import type { Job } from '@cuttingfloor/jobs';
import { describe, expect, it } from 'vitest';
import { pollIntervalMs, taskStatusMessage, toTask } from '../src/result.ts';

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: 'j_00000000000000000000000000',
    owner: 'o',
    tool: 'export.video',
    status: 'working',
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ttlMs: 1000,
    ...over,
  }) as Job;

describe('a task says how far along its job is', () => {
  it('adds the percentage and the time left to what the job is doing, on one short line', () => {
    expect(
      taskStatusMessage(job({ statusMessage: 'exporting', progress: 0.42 }), { secondsLeft: 61 }),
    ).toBe('exporting, 42%, about 61 s left');
    expect(
      taskStatusMessage(job({ statusMessage: 'exporting', progress: 0.5 }), { secondsLeft: 200 }),
    ).toBe('exporting, 50%, about 3 min left');
  });

  it("leaves the job's own percentage alone, and says nothing it does not know", () => {
    expect(taskStatusMessage(job({ statusMessage: 'making proxy 43%', progress: 0.79 }))).toBe(
      'making proxy 43%',
    );
    expect(taskStatusMessage(job({ statusMessage: 'probing' }))).toBe('probing');
    expect(
      taskStatusMessage(job({ status: 'completed', statusMessage: 'done', progress: 1 })),
    ).toBe('done');
  });

  it('keeps to 80 characters by shortening the job’s words, not the progress', () => {
    const said = taskStatusMessage(job({ statusMessage: 'queued: '.padEnd(120, 'x') }), {
      startsIn: 30,
    }) as string;
    expect(said.length).toBeLessThanOrEqual(80);
    expect(said).toMatch(/, starts in about 30 s$/);
  });

  it('asks for a read a second while a job is young or about to end, less often after', () => {
    const now = Date.now();
    const made = (secondsAgo: number) =>
      job({ createdAt: new Date(now - secondsAgo * 1000).toISOString() });
    expect(pollIntervalMs(made(2), undefined, now)).toBe(1000);
    expect(pollIntervalMs(made(30), undefined, now)).toBe(2000);
    expect(pollIntervalMs(made(300), undefined, now)).toBe(5000);
    expect(pollIntervalMs(made(300), { secondsLeft: 4 }, now)).toBe(1000);
    expect(pollIntervalMs(job({ status: 'completed' }), undefined, now)).toBe(1000);
    expect(toTask(made(300)).pollIntervalMs).toBe(5000);
  });
});
