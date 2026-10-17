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
});
