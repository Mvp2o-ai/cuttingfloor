import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@cuttingfloor/core';
import { FileJobStore, JobRunner } from '@cuttingfloor/jobs';
import { CfError } from '@cuttingfloor/schema';
import { describe, expect, it, vi } from 'vitest';

async function setup(concurrency = 1) {
  const store = new FileJobStore(new Workspace(await mkdtemp(join(tmpdir(), 'cf-jobs-'))));
  return { store, runner: new JobRunner(store, concurrency) };
}

/** Work that runs until aborted. */
const forever = ({ signal }: { signal: AbortSignal }) =>
  new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('aborted'))),
  );

/** Waits (up to 2 s) for a job's status message to match; returns the last one seen. */
async function messageOf(store: FileJobStore, id: string, want: RegExp) {
  let message: string | undefined;
  for (let i = 0; i < 200 && !want.test(message ?? ''); i++) {
    message = (await store.get(id, 'o'))?.statusMessage;
    if (!want.test(message ?? '')) await new Promise((r) => setTimeout(r, 10));
  }
  return message;
}

describe('JobRunner', () => {
  it('completes, records results and keeps domain errors as isError results', async () => {
    const { store, runner } = await setup();
    const a = await store.create({ owner: 'o', tool: 't' });
    runner.start(a, async ({ progress }) => {
      progress(0.5, 'half');
      return { content: [], structuredContent: { ok: true } };
    });
    await runner.settled(a.id);
    expect(await store.get(a.id, 'o')).toMatchObject({
      status: 'completed',
      progress: 1,
      result: { structuredContent: { ok: true } },
    });
    const b = await store.create({ owner: 'o', tool: 't' });
    runner.start(b, async () => {
      throw new CfError('render_failed', 'nope');
    });
    await runner.settled(b.id);
    expect(await store.get(b.id, 'o')).toMatchObject({
      status: 'completed',
      result: { isError: true, structuredContent: { code: 'render_failed' } },
    });
  });

  it('shows the latest progress even when it came within a second of the last', async () => {
    const { store, runner } = await setup();
    const job = await store.create({ owner: 'o', tool: 't' });
    let finish = () => {};
    runner.start(job, async ({ progress }) => {
      progress(0, 'fetching inputs');
      progress(0.1, 'running');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { content: [], structuredContent: {} };
    });
    await new Promise((r) => setTimeout(r, 1300));
    expect(await store.get(job.id, 'o')).toMatchObject({
      status: 'working',
      statusMessage: 'running',
      progress: 0.1,
    });
    finish();
    await runner.settled(job.id);
  });

  it('queues beyond its concurrency, and cancels running and queued jobs', async () => {
    const { store, runner } = await setup(1);
    const running = await store.create({ owner: 'o', tool: 'export.video' });
    const queued = await store.create({ owner: 'o', tool: 't' });
    const third = await store.create({ owner: 'o', tool: 't' });
    runner.start(running, forever);
    runner.start(queued, forever);
    runner.start(third, forever);
    // Each queued job says where it stands and what it waits for.
    expect(await messageOf(store, queued.id, /^queued/)).toBe(
      'queued: next in line, waiting for a free job slot (1 run at once on this server; running now: export.video)',
    );
    expect(await messageOf(store, third.id, /^queued: 1 ahead/)).toMatch(/1 ahead/);
    expect(runner.queuePosition(third.id)).toMatchObject({ ahead: 1, limit: 1 });
    expect((await runner.cancel(queued.id, 'o'))?.status).toBe('cancelled');
    // The one behind it moves up.
    expect(await messageOf(store, third.id, /next in line/)).toMatch(/next in line/);
    expect((await runner.cancel(running.id, 'o'))?.status).toBe('cancelled');
    expect(runner.queuePosition(third.id)).toBeUndefined();
    expect((await runner.cancel(third.id, 'o'))?.status).toBe('cancelled');
    // The slot is free again.
    const next = await store.create({ owner: 'o', tool: 't' });
    runner.start(next, async () => ({ content: [] }));
    await runner.settled(next.id);
    expect((await store.get(next.id, 'o'))?.status).toBe('completed');
  });

  it('runs sandbox jobs without taking a slot engine work needs', async () => {
    const { store, runner } = await setup(1);
    const render = await store.create({ owner: 'o', tool: 'create.motion' });
    runner.start(render, forever, { lane: 'sandbox' });
    // An export started while a render runs starts at once, not behind it.
    const exp = await store.create({ owner: 'o', tool: 'export.video' });
    runner.start(exp, async () => ({ content: [], structuredContent: { ok: true } }));
    await runner.settled(exp.id);
    expect(await store.get(exp.id, 'o')).toMatchObject({ status: 'completed' });
    expect((await store.get(exp.id, 'o'))?.startedAt).toEqual(expect.any(String));
    await runner.cancel(render.id, 'o');
  });

  it('runs heavy jobs one at a time in their own slots', async () => {
    const { store, runner } = await setup(1);
    const first = await store.create({ owner: 'o', tool: 'create.cutout' });
    runner.start(first, forever, { lane: 'heavy' });
    const second = await store.create({ owner: 'o', tool: 'create.cutout' });
    runner.start(second, forever, { lane: 'heavy' });
    // The second cut-out waits behind the first, and says for what.
    expect(await messageOf(store, second.id, /heavy model work/)).toBe(
      'queued: next in line, waiting for a free slot for heavy model work (1 run at once on this server; running now: create.cutout)',
    );
    // A voiceover started meanwhile runs at once, in the engine slot.
    const voice = await store.create({ owner: 'o', tool: 'create.voiceover' });
    runner.start(voice, async () => ({ content: [], structuredContent: { ok: true } }));
    await runner.settled(voice.id);
    expect(await store.get(voice.id, 'o')).toMatchObject({ status: 'completed' });
    await runner.cancel(second.id, 'o');
    await runner.cancel(first.id, 'o');
  });

  it('scopes jobs to their owner and honours idempotency keys', async () => {
    const { store } = await setup();
    const job = await store.create({ owner: 'o', tool: 'export.video', idempotencyKey: 'k' });
    expect(await store.get(job.id, 'someone-else')).toBeUndefined();
    expect((await store.findIdempotent('o', 'export.video', 'k'))?.id).toBe(job.id);
    expect(await store.findIdempotent('o', 'media.import', 'k')).toBeUndefined();
    await store.update(job, { status: 'cancelled' });
    expect(await store.findIdempotent('o', 'export.video', 'k')).toBeUndefined();
  });

  it('shares one data root between servers: whose jobs, remote cancel, dead servers', async () => {
    const ws = new Workspace(await mkdtemp(join(tmpdir(), 'cf-nodes-')));
    const store = new FileJobStore(ws);
    const a = new JobRunner(store, 2, { node: 'a', heartbeatMs: 50, staleMs: 400 });
    const b = new JobRunner(store, 2, { node: 'b', heartbeatMs: 50, staleMs: 400 });

    // A job running on a: b starting up leaves it alone, and it carries a's name.
    const live = await store.create({ owner: 'o', tool: 't' });
    a.start(live, forever);
    await new Promise((r) => setTimeout(r, 120));
    expect(await b.recover()).toBe(0);
    expect(await store.get(live.id, 'o')).toMatchObject({ status: 'working', node: 'a' });

    // Cancelled through b, it stops on a at its next heartbeat and stays cancelled.
    await b.cancel(live.id, 'o');
    await a.settled(live.id);
    expect(await store.get(live.id, 'o')).toMatchObject({ status: 'cancelled' });

    // A job whose server died: b ends it only once its heartbeat is stale.
    const orphan = await store.create({ owner: 'o', tool: 't' });
    await store.update(orphan, { node: 'c' });
    expect(await b.recover({ startup: false })).toBe(0);
    await new Promise((r) => setTimeout(r, 450));
    expect(await b.recover({ startup: false })).toBe(1);
    expect(await store.get(orphan.id, 'o')).toMatchObject({
      status: 'completed',
      result: { structuredContent: { code: 'interrupted' } },
    });

    // A server restarting under its old name ends its own jobs at once.
    const mine = await store.create({ owner: 'o', tool: 't' });
    await store.update(mine, { node: 'a' });
    const restarted = new JobRunner(store, 2, { node: 'a' });
    expect(await restarted.recover()).toBe(1);
  });

  it('runs an owner’s jobs within their own limit, apart from other owners, and reports each end', async () => {
    const { store } = await setup();
    const ended: string[] = [];
    const runner = new JobRunner(store, 4, {
      onEnd: (job) => ended.push(`${job.id}:${job.status}`),
    });
    const a = await store.create({ owner: 'o', tool: 't' });
    const b = await store.create({ owner: 'o', tool: 't' });
    const c = await store.create({ owner: 'p', tool: 't' });
    for (const job of [a, b]) runner.start(job, forever, { ownerLimit: 1 });
    runner.start(c, forever, { ownerLimit: 1 });
    expect(await messageOf(store, b.id, /your own jobs/)).toBe(
      'queued: waiting for one of your own jobs to finish (1 at once on your plan)',
    );
    // Another owner's job runs at once, even on the same limit.
    for (let i = 0; i < 100 && !(await store.get(c.id, 'p'))?.startedAt; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect((await store.get(c.id, 'p'))?.startedAt).toBeTruthy();
    expect((await store.get(b.id, 'o'))?.startedAt).toBeUndefined();
    await runner.cancel(a.id, 'o');
    for (let i = 0; i < 100 && !(await store.get(b.id, 'o'))?.startedAt; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect((await store.get(b.id, 'o'))?.startedAt).toBeTruthy();
    await runner.cancel(b.id, 'o');
    await runner.cancel(c.id, 'p');
    expect(ended.sort()).toEqual([a, b, c].map((j) => `${j.id}:cancelled`).sort());
  });

  it('keeps its heartbeat after a failed write, so a remote cancel still stops it', async () => {
    const ws = new Workspace(await mkdtemp(join(tmpdir(), 'cf-flaky-')));
    const store = new FileJobStore(ws);
    const runner = new JobRunner(store, 1, { heartbeatMs: 30 });
    const job = await store.create({ owner: 'o', tool: 't' });
    // The first heartbeat write fails, as a rename racing another writer can.
    const update = store.update.bind(store);
    let failed = false;
    store.update = async (j, patch) => {
      if (!failed && j.id === job.id) {
        failed = true;
        throw new Error('ENOENT: rename');
      }
      return update(j, patch);
    };
    runner.start(job, forever);
    for (let i = 0; i < 100 && !failed; i++) await new Promise((r) => setTimeout(r, 10));
    // Cancelled from another server.
    await new JobRunner(store, 1, { node: 'other' }).cancel(job.id, 'o');
    await runner.settled(job.id);
    expect((await store.get(job.id, 'o'))?.status).toBe('cancelled');
  });

  it('ends a stalled job with a typed error and gives its slot to the next', async () => {
    const { store } = await setup();
    const runner = new JobRunner(store, 1, { stallMs: 150, shortSlots: 0, cancelGraceMs: 100 });
    const stuck = await store.create({ owner: 'o', tool: 'create.cutout' });
    // Work that reports once, then neither moves nor listens to its signal.
    runner.start(stuck, ({ progress }) => {
      progress(0.004, 'matting');
      return new Promise<never>(() => undefined);
    });
    const next = await store.create({ owner: 'o', tool: 't' });
    runner.start(next, async () => ({ content: [], structuredContent: { ok: true } }));
    for (let i = 0; i < 300 && (await store.get(next.id, 'o'))?.status === 'working'; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(await store.get(next.id, 'o')).toMatchObject({ status: 'completed' });
    const ended = await store.get(stuck.id, 'o');
    expect(ended?.statusMessage).toMatch(
      /^stalled: no progress for .* \(stuck at 0\.4%, matting\)/,
    );
    expect(ended?.result).toMatchObject({
      isError: true,
      structuredContent: {
        code: 'stalled',
        detail: { progress: 0.004, status_message: 'matting', retry: true },
      },
    });
  });

  it('keeps a job that reports heartbeats or waits for a render slot', async () => {
    const { store } = await setup();
    const runner = new JobRunner(store, 1, { stallMs: 100 });
    const job = await store.create({ owner: 'o', tool: 't' });
    runner.start(job, async ({ alive, waiting }) => {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 40));
        alive();
      }
      waiting(true);
      await new Promise((r) => setTimeout(r, 300));
      waiting(false);
      return { content: [], structuredContent: { ok: true } };
    });
    await runner.settled(job.id);
    expect(await store.get(job.id, 'o')).toMatchObject({ status: 'completed' });
  });

  it('cancels within seconds even when the work ignores its signal', async () => {
    const { store } = await setup();
    const runner = new JobRunner(store, 1, { cancelGraceMs: 100 });
    const job = await store.create({ owner: 'o', tool: 't' });
    runner.start(job, () => new Promise<never>(() => undefined));
    await new Promise((r) => setTimeout(r, 50));
    const at = Date.now();
    expect((await runner.cancel(job.id, 'o'))?.status).toBe('cancelled');
    expect(Date.now() - at).toBeLessThan(2000);
    // Its slot is free.
    const next = await store.create({ owner: 'o', tool: 't' });
    runner.start(next, async () => ({ content: [] }));
    await runner.settled(next.id);
    expect((await store.get(next.id, 'o'))?.status).toBe('completed');
  });

  it('keeps a slot for short jobs, so they never wait behind long running ones', async () => {
    const { store } = await setup();
    const runner = new JobRunner(store, 1, { shortSlots: 1, shortSeconds: 60 });
    const long = await store.create({ owner: 'o', tool: 'media.analyze' });
    runner.start(long, forever, { work: 3600 });
    const longer = await store.create({ owner: 'o', tool: 'media.analyze' });
    runner.start(longer, forever, { work: 1200 });
    // A short transcript runs at once in the kept slot; the long one behind still waits.
    const short = await store.create({ owner: 'o', tool: 'media.analyze' });
    runner.start(short, async () => ({ content: [], structuredContent: { ok: true } }), {
      work: 8,
    });
    await runner.settled(short.id);
    expect((await store.get(short.id, 'o'))?.status).toBe('completed');
    expect(runner.queuePosition(longer.id)).toMatchObject({ ahead: 0 });
    // The kept slot takes only short jobs: with it busy, the next short one waits its turn.
    const busy = await store.create({ owner: 'o', tool: 't' });
    runner.start(busy, forever, { work: 5 });
    const waiting = await store.create({ owner: 'o', tool: 't' });
    runner.start(waiting, forever, { work: 5 });
    expect(await messageOf(store, waiting.id, /kept for short jobs/)).toMatch(
      /^queued: 1 ahead, waiting for a free job slot \(1 run at once on this server, plus 1 kept for short jobs like this one; running now: /,
    );
    for (const j of [waiting, busy, longer, long]) await runner.cancel(j.id, 'o');
  });

  it('estimates only from progress that has moved steadily', async () => {
    const { store } = await setup();
    const runner = new JobRunner(store, 1, { shortSlots: 0 });
    const job = await store.create({ owner: 'o', tool: 'export.video' });
    let report: (f: number) => void = () => undefined;
    runner.start(job, ({ progress, signal }) => {
      report = (f) => progress(f, `rendering ${Math.round(f * 100)}%`);
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error())),
      );
    });
    const queued = await store.create({ owner: 'o', tool: 't' });
    runner.start(queued, forever);
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.estimate(job.id)).toBeUndefined();
    expect(runner.estimate(queued.id)).toBeUndefined();
    // 10% every 5 s, seen over 10 s (the clock moved by hand).
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    for (const [s, f] of [
      [0, 0.1],
      [5, 0.2],
      [10, 0.3],
    ] as const) {
      clock.mockReturnValue(now + s * 1000);
      report(f);
    }
    expect(runner.estimate(job.id)).toEqual({ secondsLeft: 35 });
    expect(runner.estimate(queued.id)).toEqual({ startsIn: 35 });
    clock.mockRestore();
    await runner.cancel(queued.id, 'o');
    await runner.cancel(job.id, 'o');
  });

  it('runs work waiting on another service apart from engine work', async () => {
    const { store, runner } = await setup(1);
    const lipsync = await store.create({ owner: 'o', tool: 'create.lipsync' });
    runner.start(lipsync, forever, { lane: 'remote' });
    const exp = await store.create({ owner: 'o', tool: 'export.video' });
    runner.start(exp, async () => ({ content: [], structuredContent: { ok: true } }));
    await runner.settled(exp.id);
    expect(await store.get(exp.id, 'o')).toMatchObject({ status: 'completed' });
    await runner.cancel(lipsync.id, 'o');
  });

  it('writes one file from many writers at once without losing a write', async () => {
    const ws = new Workspace(await mkdtemp(join(tmpdir(), 'cf-race-')));
    const file = ws.path('x.json');
    await Promise.all(Array.from({ length: 50 }, (_, n) => ws.writeJson(file, { n })));
    expect(await ws.readJson<{ n: number }>(file)).toHaveProperty('n');
  });
});
