import {
  isMade,
  type MatteSource,
  passFrames,
  type SelectionPass,
  type SelectionSource,
  selectedFile,
  selectedPicture,
} from '@cuttingfloor/engine';
import { CfError } from '@cuttingfloor/schema';
import type { Runtime } from './runtime.ts';

// A filled selection takes minutes (LaMa, about 1.5 s a frame), so it is a job of its own: it
// shows in job.list with its progress and what it is for, it is not ended as stalled while it
// moves, and whatever needs it (a render, an export) either waits on it, hearing each frame
// (an export job, so it is not taken for stalled either), or is told which job to wait for.

export interface FillRun {
  jobId: string;
  done: Promise<string>;
  fraction: number;
  frames: number;
  listeners: Set<(fraction: number) => void>;
}

/** Fills this server is making, by the file each makes. */
const runs = new Map<string, FillRun>();

export interface FillFor {
  owner: string;
  mediaId: string;
  timelineId?: string | undefined;
  clipId: string;
}

/**
 * The fill's file when it is made; otherwise the job making it (started here if none is).
 */
export async function fillCopy(
  rt: Runtime,
  what: FillFor,
  src: SelectionSource,
  dir: string,
  pass: SelectionPass,
  mattes: Map<string, MatteSource>,
  purpose: 'preview' | 'export',
): Promise<{ path: string } | { run: FillRun }> {
  const dest = selectedFile(src, dir, pass, purpose);
  const going = runs.get(dest);
  if (going) return { run: going };
  if (await isMade(dest)) return { path: dest };
  const frames = passFrames(src);
  const job = await rt.jobs.store.create({
    owner: what.owner,
    tool: 'clip.set_mask',
    meta: {
      media_id: what.mediaId,
      ...(what.timelineId ? { timeline_id: what.timelineId } : {}),
      kind: 'fill',
      clip_id: what.clipId,
    },
    statusMessage: 'queued',
  });
  let settle: { resolve: (p: string) => void; reject: (e: unknown) => void } | undefined;
  const done = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A failed fill is reported to whoever waits; nobody waiting is fine too.
  done.catch(() => undefined);
  const run: FillRun = { jobId: job.id, done, fraction: 0, frames, listeners: new Set() };
  runs.set(dest, run);
  rt.jobs.start(
    job,
    async ({ signal, progress }) => {
      try {
        progress(0, `filling the selection of clip ${what.clipId}: ${frames} frames`);
        const path = await selectedPicture(src, dir, pass, mattes, purpose, {
          signal,
          onProgress: (f) => {
            run.fraction = f;
            progress(
              f,
              `filling the selection of clip ${what.clipId}: frame ${Math.round(f * frames)} of ${frames}`,
            );
            for (const l of run.listeners) l(f);
          },
        });
        settle?.resolve(path);
        return {
          content: [{ type: 'text', text: `Filled the selection of clip ${what.clipId}` }],
          structuredContent: {
            media_id: what.mediaId,
            clip_id: what.clipId,
            ...(what.timelineId ? { timeline_id: what.timelineId } : {}),
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
    { lane: 'heavy', work: src.image ? 1 : src.duration },
  );
  return { run };
}

/** The refusal for a render that needs a fill not made yet: which job makes it, how far it is. */
export function fillNotReady(run: FillRun, clipId: string, started: boolean): CfError {
  const left = Math.max(1, Math.ceil(((1 - run.fraction) * run.frames * 1.5) / 60));
  return new CfError(
    'media_not_ready',
    `The filled selection of clip ${clipId} is ${started ? 'now' : 'still'} being made by job ${run.jobId} (${Math.round(run.fraction * 100)}%)`,
    {
      hint: `Filling takes about 1.5 s a frame on this server's CPU (${run.frames} frames, about ${left} min left). Follow it with job.get {job_id: "${run.jobId}", wait_seconds}, then render again; an export waits for it`,
      detail: { job_id: run.jobId, progress: run.fraction, frames: run.frames },
    },
  );
}

/**
 * Waits for a fill inside another job, telling that job each frame (`onFrame`), so it is not
 * taken for stalled while the fill moves.
 */
export async function awaitFill(
  run: FillRun,
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
