import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { call, connect, ok, SEQ_720P25, type TestEnv, testRuntime } from './helpers.ts';

// Jobs that stall or won't stop, through the SDK client. Every engine is a stand-in that never
// finishes and starts a helper process of its own (as a real engine's child can), so these run
// the same on a Mac without engines and in the image. Set before the engine module reads them.
const fake = await vi.hoisted(async () => {
  const { chmodSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const dir = mkdtempSync(joinPath(tmpdir(), 'cf-fake-engine-'));
  const script = joinPath(dir, 'engine.sh');
  const pids = joinPath(dir, 'pids');
  writeFileSync(
    script,
    '#!/bin/sh\n# A stand-in engine that never finishes, with a helper of its own.\nsleep 600 &\necho "$$ $!" >> "$CF_FAKE_ENGINE_PIDS"\nwait\n',
  );
  chmodSync(script, 0o755);
  const saved = Object.fromEntries(
    ['CUTTINGFLOOR_MELT', 'CUTTINGFLOOR_FFMPEG', 'CUTTINGFLOOR_FFPROBE', 'CF_FAKE_ENGINE_PIDS'].map(
      (k) => [k, process.env[k]],
    ),
  );
  process.env.CUTTINGFLOOR_MELT = script;
  process.env.CUTTINGFLOOR_FFMPEG = script;
  process.env.CUTTINGFLOOR_FFPROBE = script;
  process.env.CF_FAKE_ENGINE_PIDS = pids;
  return { pids, saved };
});

let env: TestEnv;

beforeAll(async () => {
  // One job slot and none kept for short jobs, so a held slot shows; stalls after half a second.
  env = await testRuntime({ maxJobs: 1, shortJobs: 0, stallSeconds: 0.5 });
});

afterAll(() => {
  for (const [k, v] of Object.entries(fake.saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Every process the stand-in engines started so far (the engine and its helper). */
async function enginePids(): Promise<number[]> {
  const text = await readFile(fake.pids, 'utf8').catch(() => '');
  return text.split(/\s+/).filter(Boolean).map(Number);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A one-second timeline of a title, ready to export. */
async function oneSecond(client: Awaited<ReturnType<typeof connect>>): Promise<string> {
  const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
    name: 'Short',
    sequence: SEQ_720P25,
  });
  const titled = await ok<{ timeline_id: string }>(client, 'title.add', {
    timeline_id,
    track_id: 't1',
    text: 'One second',
    duration_frames: 25,
    preview: 'none',
  });
  return titled.timeline_id;
}

interface View {
  job_id: string;
  status: string;
  status_message?: string;
  for?: Record<string, unknown>;
  error?: { code: string; detail?: Record<string, unknown> };
  result?: unknown;
  result_summary?: { value: unknown; cut: Record<string, number> };
}

describe('jobs that stall or will not stop', () => {
  it('ends a job whose progress stops, frees its slot, and kills its engine', async () => {
    const client = await connect(env.runtime);
    const timeline = await oneSecond(client);
    const first = await ok<View>(client, 'export.video', {
      timeline_id: timeline,
      preset: 'review_h264',
    });
    const second = await ok<View>(client, 'export.video', {
      timeline_id: timeline,
      preset: 'review_h264',
      filename: 'second',
    });
    // The second waits for the only slot, and names what it is for.
    let queued = await ok<View>(client, 'job.get', { job_id: second.job_id });
    if (!/^queued/.test(queued.status_message ?? ''))
      queued = await ok<View>(client, 'job.get', { job_id: second.job_id, wait_seconds: 5 });
    expect(queued.status_message).toMatch(/^queued: next in line/);
    expect(queued.for).toMatchObject({ timeline_id: timeline, preset: 'review_h264' });
    await until(async () => (await enginePids()).length >= 2);
    const [engine, helper] = await enginePids();

    // One wait answers when the stalled job ends.
    let view = await ok<View>(client, 'job.get', { job_id: first.job_id, wait_seconds: 20 });
    for (let i = 0; i < 20 && view.status === 'working'; i++)
      view = await ok<View>(client, 'job.get', { job_id: first.job_id, wait_seconds: 20 });
    expect(view.status).toBe('failed');
    expect(view.status_message).toMatch(/^stalled: no progress for/);
    expect(view.error).toMatchObject({ code: 'stalled', detail: { retry: true } });
    await until(() => !alive(engine as number) && !alive(helper as number));

    // Its slot went to the second, which now runs.
    await until(async () => {
      const next = await ok<View>(client, 'job.get', { job_id: second.job_id });
      return !/^queued/.test(next.status_message ?? '');
    });
    await ok(client, 'job.cancel', { job_id: second.job_id });
  }, 30_000);

  it('cancels a running job within seconds, its engine and the engine’s own helper', async () => {
    const quiet = await testRuntime({ maxJobs: 1, stallSeconds: 600 });
    const client = await connect(quiet.runtime);
    const timeline = await oneSecond(client);
    const before = (await enginePids()).length;
    const job = await ok<View>(client, 'export.video', {
      timeline_id: timeline,
      preset: 'review_h264',
    });
    await until(async () => (await enginePids()).length >= before + 2);
    const [engine, helper] = (await enginePids()).slice(before);
    // A wait in flight hears the cancel: it answers on each change, so a status written first
    // can come before it.
    const started = Date.now();
    const waiting = (async () => {
      let v = await ok<View>(client, 'job.get', { job_id: job.job_id, wait_seconds: 30 });
      while (v.status === 'working' && Date.now() - started < 10_000)
        v = await ok<View>(client, 'job.get', { job_id: job.job_id, wait_seconds: 30 });
      return v;
    })();
    const cancelled = await new Promise((r) => setTimeout(r, 200)).then(() =>
      ok<View>(client, 'job.cancel', { job_id: job.job_id }),
    );
    const waited = await waiting;
    expect(cancelled.status).toBe('cancelled');
    expect(waited.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(alive(engine as number)).toBe(false);
    expect(alive(helper as number)).toBe(false);
    // A finished job doesn't wait.
    const at = Date.now();
    await ok(client, 'job.get', { job_id: job.job_id, wait_seconds: 30 });
    expect(Date.now() - at).toBeLessThan(1000);
  }, 30_000);

  it('names the import job on media.get, in job.list and in a not-ready error', async () => {
    const quiet = await testRuntime({ maxJobs: 1, stallSeconds: 600 });
    const client = await connect(quiet.runtime);
    await writeFile(join(quiet.mediaDir, 'clip.mp4'), Buffer.alloc(4096, 1));
    const started = await ok<{ job_id: string; media_id: string }>(client, 'media.import', {
      source: { path: join(quiet.mediaDir, 'clip.mp4') },
    });
    const media = await ok<{ status: string; job?: Record<string, unknown> }>(client, 'media.get', {
      media_id: started.media_id,
    });
    expect(media.status).toBe('importing');
    expect(media.job).toMatchObject({
      job_id: started.job_id,
      tool: 'media.import',
      status: 'working',
    });
    const listed = await ok<{ jobs: View[] }>(client, 'job.list', { media_id: started.media_id });
    expect(listed.jobs.map((j) => j.job_id)).toEqual([started.job_id]);
    expect(listed.jobs[0]?.for).toEqual({ media_id: started.media_id });
    const refused = await call(client, 'media.analyze', {
      media_id: started.media_id,
      kind: 'transcript',
    });
    expect(refused.structured).toMatchObject({
      code: 'media_not_ready',
      detail: { job_id: started.job_id },
    });
    expect(String(refused.structured.hint)).toContain(started.job_id);
    await ok(client, 'job.cancel', { job_id: started.job_id });
  }, 30_000);

  it('lists jobs without their results, and sums a result up when asked', async () => {
    const client = await connect(env.runtime, 'summaries');
    const store = env.runtime.jobs.store;
    const job = await store.create({
      owner: 'summaries',
      tool: 'media.analyze',
      meta: { media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'speech' },
    });
    const probabilities = Array.from({ length: 2800 }, (_, i) => (i % 10) / 10);
    await store.update(job, {
      status: 'completed',
      progress: 1,
      result: {
        content: [],
        structuredContent: { kind: 'speech', speech: { frame_seconds: 0.032, probabilities } },
      },
    });
    const listed = await ok<{ jobs: View[] }>(client, 'job.list', {});
    expect(listed.jobs[0]).toMatchObject({ job_id: job.id, for: { kind: 'speech' } });
    expect(listed.jobs[0]?.result).toBeUndefined();
    const brief = await ok<View>(client, 'job.get', { job_id: job.id, result: 'summary' });
    expect(brief.result).toBeUndefined();
    expect(brief.result_summary?.cut).toEqual({ 'speech.probabilities': 2800 });
    expect(
      (brief.result_summary?.value as { speech?: { probabilities: number[] } })?.speech
        ?.probabilities,
    ).toHaveLength(5);
    // The whole result is still there.
    const full = await ok<View>(client, 'job.get', { job_id: job.id });
    expect((full.result as { speech: { probabilities: number[] } }).speech.probabilities).toEqual(
      probabilities,
    );
    // A check on many jobs at once sums each result up, unless asked for all of it.
    const many = await ok<{ jobs: View[] }>(client, 'job.get', { job_ids: [job.id] });
    expect(many.jobs[0]?.result).toBeUndefined();
    expect(many.jobs[0]?.result_summary?.cut).toEqual({ 'speech.probabilities': 2800 });
    const whole = await ok<{ jobs: View[] }>(client, 'job.get', {
      job_ids: [job.id],
      result: 'full',
    });
    const kept = whole.jobs[0]?.result as { speech?: { probabilities: number[] } } | undefined;
    expect(kept?.speech?.probabilities).toHaveLength(2800);
  });
});
