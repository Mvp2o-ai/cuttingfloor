import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@cuttingfloor/core';
import { FileJobStore, JobRunner } from '@cuttingfloor/jobs';
import { CfError } from '@cuttingfloor/schema';
import { describe, expect, it } from 'vitest';

async function setup(concurrency = 1) {
  const store = new FileJobStore(new Workspace(await mkdtemp(join(tmpdir(), 'cf-jobs-'))));
  return { store, runner: new JobRunner(store, concurrency) };
}

/** Work that runs until aborted. */
const forever = ({ signal }: { signal: AbortSignal }) =>
  new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('aborted'))),
  );

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
    const running = await store.create({ owner: 'o', tool: 't' });
    const queued = await store.create({ owner: 'o', tool: 't' });
    runner.start(running, forever);
    runner.start(queued, forever);
    // Wait for the runner to record the second job as queued; a fixed sleep raced it on slow
    // CI runners.
    let message: string | undefined;
    for (let i = 0; i < 200 && message !== 'queued'; i++) {
      message = (await store.get(queued.id, 'o'))?.statusMessage;
      if (message !== 'queued') await new Promise((r) => setTimeout(r, 10));
    }
    expect(message).toBe('queued');
    expect((await runner.cancel(queued.id, 'o'))?.status).toBe('cancelled');
    expect((await runner.cancel(running.id, 'o'))?.status).toBe('cancelled');
    // The slot is free again.
    const next = await store.create({ owner: 'o', tool: 't' });
    runner.start(next, async () => ({ content: [] }));
    await runner.settled(next.id);
    expect((await store.get(next.id, 'o'))?.status).toBe('completed');
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
});
