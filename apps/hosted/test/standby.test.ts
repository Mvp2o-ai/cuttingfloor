import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMELINES } from '@cuttingfloor/core';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { configFromEnv, createServer, Runtime, type RuntimeConfig } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmailProvider, OutboundEmail } from '../src/email.ts';
import { Sequence, type Subscribers } from '../src/sequence.ts';
import { accountMailer, STANDBY_NOTICE, startBackground } from '../src/standby.ts';

// A standby server (CUTTINGFLOOR_STANDBY=1) runs on a copy of production's data beside the
// server still in production: it answers requests, and does nothing to the data by the clock.

const OWNER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ07';
const TEMPLATES = fileURLToPath(new URL('../email/', import.meta.url));
const dirs: string[] = [];
const runtimes: Runtime[] = [];

async function runtimeOn(dataDir: string, standby: boolean): Promise<Runtime> {
  const config: RuntimeConfig = {
    ...configFromEnv({
      CUTTINGFLOOR_MODE: 'hosted',
      CUTTINGFLOOR_DATA: dataDir,
      ...(standby ? { CUTTINGFLOOR_STANDBY: '1' } : {}),
    }),
    motionUrl: null,
    node: 'standby-test',
  };
  const runtime = new Runtime(config);
  runtimes.push(runtime);
  return runtime;
}

/** A data root holding a timeline and a media file nobody used for thirty days. */
async function expiredData(): Promise<{ root: string; timeline: string; blob: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-standby-'));
  dirs.push(dir);
  const root = join(dir, 'data');
  const setup = await runtimeOn(root, true);
  const { ws, media } = setup;
  const old = new Date(Date.now() - 30 * 86_400_000);
  const timeline = `tl_${'a'.repeat(32)}`;
  await ws.records.collection(TIMELINES, { owner: OWNER }).put(timeline, {} as never);
  await utimes(ws.ownerDir(OWNER, 'timelines', `${timeline}.json`), old, old);
  const record = await media.create(OWNER, { url: 'https://example.com/a.mp4' }, 'a.mp4');
  const blob = ws.blobs.keys.media(OWNER, record.media_id, 'source.mp4');
  await ws.blobs.put(blob, { bytes: Buffer.from('bytes') });
  await media.save(OWNER, { ...record, file: blob });
  await utimes(join(media.dir(OWNER, record.media_id), 'media.json'), old, old);
  return { root, timeline, blob };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('a standby server', () => {
  it('is one only when CUTTINGFLOOR_STANDBY is 1', () => {
    expect(configFromEnv({}).standby).toBeUndefined();
    expect(configFromEnv({ CUTTINGFLOOR_STANDBY: '0' }).standby).toBeUndefined();
    expect(configFromEnv({ CUTTINGFLOOR_STANDBY: '1' }).standby).toBe(true);
    expect(STANDBY_NOTICE).toMatch(/no sweep.*no recovery.*no lifecycle.*no email/);
  });

  it('keeps an expired record and blob through its start and the hour’s turn', async () => {
    const { root, timeline, blob } = await expiredData();
    vi.useFakeTimers({ toFake: ['setInterval'] });
    const standby = await runtimeOn(root, true);
    await standby.start();
    await vi.advanceTimersByTimeAsync(2 * 3_600_000 + 5_000);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 200));
    const timelines = standby.ws.records.collection(TIMELINES, { owner: OWNER });
    expect(await timelines.has(timeline)).toBe(true);
    expect(await standby.ws.blobs.head(blob)).toBeDefined();
    // The same data on a server that is not standby: both go as it starts.
    const serving = await runtimeOn(root, false);
    await serving.start();
    expect(await timelines.has(timeline)).toBe(false);
    expect(await serving.ws.blobs.head(blob)).toBeUndefined();
  });

  it('leaves a job another server was running as it is', async () => {
    const { root } = await expiredData();
    const other = await runtimeOn(root, true);
    const job = await other.jobs.store.create({ owner: OWNER, tool: 'export.video' });
    const standby = await runtimeOn(root, true);
    await standby.start();
    expect((await standby.jobs.store.get(job.id, OWNER))?.status).toBe('working');
    const serving = await runtimeOn(root, false);
    await serving.start({ sweep: false });
    expect((await serving.jobs.store.get(job.id, OWNER))?.statusMessage).toBe('interrupted');
  });

  it('still answers a tool call', async () => {
    const { root } = await expiredData();
    const standby = await runtimeOn(root, true);
    await standby.start();
    const server = createServer({
      runtime: standby,
      credentials: new LocalCredentialStore({}, false),
      owner: () => OWNER,
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'standby', version: '0.0.0' });
    await client.connect(clientSide);
    const made = (await client.callTool({
      name: 'timeline.create',
      arguments: { name: 'Cut', sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } } },
    })) as { isError?: boolean; structuredContent?: { timeline_id?: string } };
    expect(made.isError).toBeFalsy();
    expect(made.structuredContent?.timeline_id).toMatch(/^tl_/);
  });

  it('sends no email: no mailer, and a due sequence slot is not even looked at', async () => {
    const env = { RESEND_API_KEY: 're_test', CUTTINGFLOOR_EMAIL_FROM: 'Ken <ken@example.com>' };
    expect(accountMailer(env, true)).toBeUndefined();
    expect(accountMailer(env, false)).toBeDefined();
    expect(accountMailer({}, false)).toBeUndefined();

    const { root } = await expiredData();
    const runtime = await runtimeOn(root, true);
    const sent: OutboundEmail[] = [];
    const provider: EmailProvider = {
      send: async (email) => {
        sent.push(email);
        return { id: `msg_${sent.length}` };
      },
    };
    const now = Date.now();
    const subscribers: Subscribers = {
      async *createdSince() {
        yield {
          id: OWNER,
          email: 'person@example.com',
          createdAt: new Date(now - 60_000).toISOString(),
          verified: true,
        };
      },
      current: async () => ({ email: 'person@example.com' }),
    };
    let made = 0;
    const sequence = () => {
      made += 1;
      return new Sequence({
        ws: runtime.ws,
        subscribers,
        provider,
        from: 'Ken at cuttingfloor <ken@cuttingfloor.ai>',
        replyTo: 'support@cuttingfloor.ai',
        signer: 'Ken',
        publicUrl: 'https://api.cuttingfloor.ai',
        unsubscribeSecret: 'unsubscribe-secret',
        followUpAfterMs: 3 * 86_400_000,
        creditsAfterMs: 7 * 86_400_000,
        credits: async () => ({ left: 23.1, perMonth: null, bought: 0 }),
        pollMs: 20,
        templatesDir: TEMPLATES,
      });
    };
    const started: Array<{ sweep?: boolean }> = [];
    const lifecycle = { start: (options: { sweep?: boolean } = {}) => void started.push(options) };
    expect(startBackground({ standby: true, lifecycle, sequence })).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(made).toBe(0);
    expect(sent).toEqual([]);
    // It still hears its own calls and jobs, and sweeps nothing.
    expect(started).toEqual([{ sweep: false }]);
    // Not on standby, the same slot is due and its email goes.
    const running = startBackground({ standby: false, lifecycle, sequence });
    try {
      const end = Date.now() + 10_000;
      while (!sent.length && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      expect(sent).toHaveLength(1);
      expect(started[1]).toEqual({ sweep: true });
    } finally {
      running?.stop();
    }
  });
});
