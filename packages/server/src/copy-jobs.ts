import { isMade } from '@cuttingfloor/engine';
import { CfError } from '@cuttingfloor/schema';
import type { Runtime } from './runtime.ts';

// Copies of a clip's source that take minutes to make (a filled selection, in-between frames)
// are jobs of their own: each shows in job.list with its progress per frame and what it is for,
// it is not ended as stalled while it moves, and whatever needs it either waits on it, hearing
// each frame (an export job, which so is not taken for stalled either), or is told which job
// makes it. A copy is made once per clip and setting, whatever size it is shown at.

export type CopyKind = 'fill' | 'in-between';

const WHAT: Record<CopyKind, string> = {
  fill: 'filled selection',
  'in-between': 'in-between frames',
};

export interface CopyRun {
  jobId: string;
  kind: CopyKind;
  done: Promise<string>;
  fraction: number;
  frames: number;
  listeners: Set<(fraction: number) => void>;
  /** Ends whoever waits on it, when its job ended without making the copy. */
  reject: (error: unknown) => void;
}

/** Copies this server is making, by the file each makes. */
const runs = new Map<string, CopyRun>();

export interface CopyFor {
  owner: string;
  mediaId: string;
  timelineId?: string | undefined;
  clipId: string;
  kind: CopyKind;
}

/**
 * The copy's file when it is made; otherwise the job making it (started here if none is).
 * `make` writes `dest`, calling `onProgress` (0–1) as it goes.
 */
export async function copyJob(
  rt: Runtime,
  what: CopyFor,
  dest: string,
  frames: number,
  /** Seconds of source it reads, for the job's stall limit. */
  seconds: number,
  make: (options: {
    signal: AbortSignal;
    onProgress: (fraction: number) => void;
  }) => Promise<string>,
): Promise<{ path: string } | { run: CopyRun }> {
  const going = runs.get(dest);
  if (going) {
    // A job that was cancelled or failed, or that the server stopped, makes nothing: the copy
    // is started afresh.
    const job = await rt.jobs.store.get(going.jobId, what.owner);
    if (job?.status === 'working') return { run: going };
    runs.delete(dest);
    going.reject(new CfError('cancelled', `Job ${going.jobId} ended before the copy was made`));
  }
  if (await isMade(dest)) return { path: dest };
  const label = `the ${WHAT[what.kind]} of clip ${what.clipId}`;
  const job = await rt.jobs.store.create({
    owner: what.owner,
    tool: what.kind === 'fill' ? 'clip.set_mask' : 'clip.set_speed',
    meta: {
      media_id: what.mediaId,
      ...(what.timelineId ? { timeline_id: what.timelineId } : {}),
      kind: what.kind,
      clip_id: what.clipId,
    },
    statusMessage: 'queued',
  });
  let settle: { resolve: (p: string) => void; reject: (e: unknown) => void } | undefined;
  const done = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A failed copy is reported to whoever waits; nobody waiting is fine too.
  done.catch(() => undefined);
  const run: CopyRun = {
    jobId: job.id,
    kind: what.kind,
    done,
    fraction: 0,
    frames,
    listeners: new Set(),
    reject: (e) => settle?.reject(e),
  };
  runs.set(dest, run);
  rt.jobs.start(
    job,
    async ({ signal, progress }) => {
      try {
        progress(0, `making ${label}: ${frames} frames`);
        const path = await make({
          signal,
          onProgress: (f) => {
            run.fraction = f;
            progress(f, `making ${label}: frame ${Math.round(f * frames)} of ${frames}`);
            for (const l of run.listeners) l(f);
          },
        });
        settle?.resolve(path);
        return {
          content: [{ type: 'text', text: `Made ${label}` }],
          structuredContent: {
            media_id: what.mediaId,
            clip_id: what.clipId,
            ...(what.timelineId ? { timeline_id: what.timelineId } : {}),
            kind: what.kind,
            frames,
          },
        };
      } catch (e) {
        settle?.reject(e);
        throw e;
      } finally {
        runs.delete(dest);
      }
    },
    { lane: 'heavy', work: seconds },
  );
  // However the job ends (a cancel while it waited for a slot never runs the work), it is no
  // longer the copy's maker.
  void rt.jobs.settled(job.id).finally(() => {
    if (runs.get(dest) !== run) return;
    runs.delete(dest);
    run.reject(new CfError('cancelled', `Job ${job.id} ended before the copy was made`));
  });
  return { run };
}

/**
 * The refusal for a render that needs a copy not made yet: which job makes it, how far it is,
 * and, from the job runner, where it waits in the queue or the time left at its measured rate.
 */
export function copyNotReady(rt: Runtime, run: CopyRun, clipId: string): CfError {
  const queued = rt.jobs.queuePosition(run.jobId);
  const estimate = rt.jobs.estimate(run.jobId);
  const pct = Math.round(run.fraction * 100);
  const where = queued
    ? `waiting for a slot (${queued.ahead} ${queued.ahead === 1 ? 'job' : 'jobs'} ahead; ${queued.limit} ${queued.limit === 1 ? 'runs' : 'run'} at once)`
    : `${pct}% done${estimate?.secondsLeft !== undefined ? `, about ${Math.ceil(estimate.secondsLeft / 60)} min left at its rate so far` : ''}`;
  return new CfError(
    'media_not_ready',
    `The ${WHAT[run.kind]} of clip ${clipId} ${run.kind === 'fill' ? 'is' : 'are'} being made by job ${run.jobId}: ${where}`,
    {
      hint: `job.get {job_id: "${run.jobId}", wait_seconds: 50} answers when it is done (progress per frame and seconds_left meanwhile); render again then. An export waits for it`,
      detail: {
        job_id: run.jobId,
        progress: run.fraction,
        frames: run.frames,
        ...(queued ? { jobs_ahead: queued.ahead } : {}),
        ...(estimate?.secondsLeft !== undefined ? { seconds_left: estimate.secondsLeft } : {}),
      },
    },
  );
}

/**
 * Waits for a copy inside another job, telling that job each frame (`onFrame`), so it is not
 * taken for stalled while the copy moves.
 */
export async function awaitCopy(
  run: CopyRun,
  onFrame: (fraction: number) => void,
): Promise<string> {
  const listener = (f: number) => onFrame(f);
  run.listeners.add(listener);
  try {
    return await run.done;
  } finally {
    run.listeners.delete(listener);
  }
}

/**
 * Gets a copy for a render: its file once made; inside a job (`signal`) it waits, saying how
 * far the copy is with its stall clock stopped; a request refuses, naming the job, unless the
 * clip is not at the frames it shows (then undefined: the clip plays without it there).
 */
export async function copyFor(
  rt: Runtime,
  made: { path: string } | { run: CopyRun },
  clipId: string,
  options: {
    signal: AbortSignal | undefined;
    needed: boolean;
    waiting?: ((on: boolean, message: string) => void) | undefined;
    /** Inside a job: waits out of its slot (JobContext.aside). */
    aside?: (<T>(wait: Promise<T>) => Promise<T>) | undefined;
  },
): Promise<string | undefined> {
  if ('path' in made) return made.path;
  const { run } = made;
  if (options.signal) {
    // The copy job has its own stall watch; this one waits with its clock stopped.
    const say = (f: number) =>
      options.waiting?.(
        true,
        `waiting for the ${WHAT[run.kind]} of clip ${clipId} (job ${run.jobId}, ${Math.round(f * 100)}%)`,
      );
    say(run.fraction);
    try {
      const waited = awaitCopy(run, say);
      return await (options.aside ? options.aside(waited) : waited);
    } finally {
      options.waiting?.(false, 'preparing sources');
    }
  }
  if (!options.needed) return undefined;
  throw copyNotReady(rt, run, clipId);
}
