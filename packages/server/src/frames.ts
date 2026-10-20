import { CfError, JUDGE_LIMITS, type JudgeAnswer } from '@cuttingfloor/schema';
import { askJev } from './jev.ts';

// Frames judged one by one: media.analyze look asks its questions of them, media.seek its
// criteria. Both sample the same way, send the same pictures and share the daily budget.

/** State names filled on every frame, which a caller's own entries may not take. */
export const FRAME_NAMES = ['frame', 'previous', 'seconds_between'];

export type JudgedFrame = { time: number; answers: Record<string, JudgeAnswer> };

export interface Sampling {
  every_seconds?: number | undefined;
  at_seconds?: number[] | undefined;
  from_seconds?: number | undefined;
  until_seconds?: number | undefined;
  with_previous?: boolean | undefined;
}

/**
 * The sample times over a picture `duration` seconds long (0 for a still), checked before any
 * job exists, and how many of them are judged (with_previous only shows the first).
 */
export function sampleTimes(
  duration: number,
  args: Sampling,
  unit = 'media',
): { times: number[]; asked: number } {
  const step = args.every_seconds ?? 1;
  const from = args.from_seconds ?? 0;
  const to = Math.min(args.until_seconds ?? duration, duration);
  let times: number[] = [];
  if (!duration) times = [0];
  else if (args.at_seconds) times = [...new Set(args.at_seconds)].sort((a, b) => a - b);
  else for (let t = from; t < to - 1e-6; t += step) times.push(Math.round(t * 1000) / 1000);
  const late = times.find((t) => duration && t >= duration);
  if (late !== undefined) {
    throw new CfError('bad_request', `${late} s is past the end of the ${unit} (${duration} s)`, {
      hint: `Sample times from 0 up to ${duration} s`,
    });
  }
  if (!times.length) {
    throw new CfError('bad_request', `Nothing to sample between ${from} s and ${to} s`, {
      hint: `The ${unit} runs ${duration} s; from_seconds must come before until_seconds`,
    });
  }
  const asked = times.length - (args.with_previous && times.length > 1 ? 1 : 0);
  if (asked > JUDGE_LIMITS.frames) {
    throw new CfError(
      'limit_exceeded',
      `That samples ${asked} frames; a call takes up to ${JUDGE_LIMITS.frames}`,
      {
        hint: `every_seconds ${Math.ceil(((to - from) / JUDGE_LIMITS.frames) * 100) / 100} covers it in one call, or split it with from_seconds and until_seconds`,
      },
    );
  }
  return { times, asked };
}

/** Refuses state entries named like the pictures and facts every frame fills in itself. */
export function checkFrameState(tool: string, state: Record<string, unknown> | undefined): void {
  const taken = Object.keys(state ?? {}).filter((n) => FRAME_NAMES.includes(n));
  if (taken.length) {
    throw new CfError('bad_request', `${tool} names ${taken.join(', ')} itself`, {
      hint: 'Give your state entries other names, e.g. script or definition',
    });
  }
}

/**
 * Asks every question of each frame, eight frames at a time: the frame as `frame`, with
 * with_previous the one sampled before as `previous`, plus the caller's state.
 */
export async function askFrames(options: {
  base: string;
  key: string;
  times: number[];
  stills: Buffer[];
  withPrevious: boolean;
  state?: Record<string, unknown> | undefined;
  questions: Record<string, unknown>;
  signal: AbortSignal;
  onFrame: (done: number, of: number) => void;
}): Promise<JudgedFrame[]> {
  const { times, stills } = options;
  // with_previous: the first frame is only ever shown as `previous`.
  const first = options.withPrevious && times.length > 1 ? 1 : 0;
  const frames: JudgedFrame[] = new Array(times.length - first);
  let next = first;
  let done = 0;
  const worker = async () => {
    while (next < times.length) {
      const i = next++;
      const t = times[i] as number;
      const prev = i > 0 && options.withPrevious ? i - 1 : -1;
      const { answers } = await askJev({
        base: options.base,
        key: options.key,
        images: [
          ...(prev >= 0 ? [{ name: 'previous', jpeg: stills[prev] as Buffer }] : []),
          { name: 'frame', jpeg: stills[i] as Buffer },
        ],
        state: {
          ...options.state,
          ...(prev >= 0
            ? { seconds_between: Math.round((t - (times[prev] as number)) * 1000) / 1000 }
            : {}),
        },
        questions: options.questions,
        signal: options.signal,
      });
      frames[i - first] = { time: t, answers };
      options.onFrame(++done, frames.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, frames.length) }, worker));
  return frames;
}
