import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { CfError } from '@cuttingfloor/schema';
import {
  createServer,
  type MeterEntry,
  meteredSeconds,
  type OwnerLimits,
} from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, ok, SEQ_720P25, type TestEnv, testRuntime } from './helpers.ts';

// A hosted plan reaches the tools as limits: jobs at once, the largest export, a refusal once the
// plan's minutes are used. Jobs are metered as they end.

let env: TestEnv;

beforeAll(async () => {
  env = await testRuntime();
});

async function connectWith(owner: string, limits: () => Promise<OwnerLimits>): Promise<Client> {
  const server = createServer({
    runtime: env.runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => owner,
    limits,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function titled(client: Client, sequence = SEQ_720P25): Promise<string> {
  const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
    name: 'Plan',
    sequence,
  });
  const done = await ok<{ timeline_id: string }>(client, 'title.add', {
    timeline_id,
    track_id: 't1',
    text: 'Thirty seconds',
    duration_frames: 750,
    preview: 'none',
  });
  return done.timeline_id;
}

describe('plan limits', () => {
  it('refuses new jobs once the minutes are used, while editing still works', async () => {
    const refusal = new CfError('quota_exceeded', "This period's 300 render minutes are used", {
      hint: 'Wait until they renew',
    });
    const client = await connectWith('used-up', async () => ({ refuseJobs: refusal }));
    const timeline = await titled(client);
    const exported = await call(client, 'export.video', {
      timeline_id: timeline,
      preset: 'web_1080p_h264',
    });
    expect(exported.isError).toBe(true);
    expect(exported.structured).toMatchObject({ code: 'quota_exceeded' });
    const checked = await call(client, 'qa.check', { timeline_id: timeline });
    expect(checked.structured).toMatchObject({ code: 'quota_exceeded' });
  });

  it('caps the export size at the plan’s, and says how to fit it', async () => {
    const client = await connectWith('hd-only', async () => ({ shortSide: 1080 }));
    const timeline = await titled(client, { width: 3840, height: 2160, fps: { num: 25, den: 1 } });
    const big = await call(client, 'export.video', {
      timeline_id: timeline,
      preset: 'master_prores_422hq',
    });
    expect(big.structured).toMatchObject({
      code: 'limit_exceeded',
      detail: { width: 3840, height: 2160, short_side_limit: 1080 },
    });
    expect(String(big.structured.hint)).toContain('{height: 1080}');
    const fitted = await call(client, 'export.video', {
      timeline_id: timeline,
      preset: 'master_prores_422hq',
      overrides: { height: 1080 },
    });
    expect(fitted.isError).toBe(false);
    await call(client, 'job.cancel', { job_id: fitted.structured.job_id });
  });

  it('runs an owner’s jobs one at a time on a one-job plan, and meters each as it ends', async () => {
    const metered: MeterEntry[] = [];
    const off = env.runtime.onMetered((job, entry) => {
      if (job.owner === 'one-job') metered.push(entry);
    });
    const client = await connectWith('one-job', async () => ({ jobs: 1 }));
    const timeline = await titled(client);
    const since = new Date();
    const first = await ok<{ job_id: string }>(client, 'qa.check', { timeline_id: timeline });
    const second = await ok<{ job_id: string }>(client, 'qa.check', { timeline_id: timeline });
    for (const job of [first, second])
      await ok(client, 'job.get', { job_id: job.job_id, wait_seconds: 50 });
    for (let i = 0; i < 100 && metered.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    off();
    const [a, b] = [first, second].map((j) => metered.find((m) => m.job_id === j.job_id));
    expect(a?.tool).toBe('qa.check');
    // The second waited for the first: their runs don't overlap.
    expect(b && a && b.started_at >= a.ended_at).toBe(true);
    const total = (a?.seconds ?? 0) + (b?.seconds ?? 0);
    expect(await meteredSeconds(env.runtime.ws, 'one-job', since)).toBeCloseTo(total, 3);
    expect(await meteredSeconds(env.runtime.ws, 'one-job', new Date(Date.now() + 1000))).toBe(0);
  }, 120_000);
});
