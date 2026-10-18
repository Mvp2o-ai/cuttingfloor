import type { Effect, SessionData, SessionStep } from './types.ts';

// When each step lands, worked out from the data so nobody writes timings by hand. The server
// renders the finished state from this, and the driver plays it.

const START = 0.5;
const QUICK = 0.45;
/** Characters a second: people type slower than agents stream. */
const TYPING = { user: 48, agent: 70 } as const;
/** How long the finished session holds before it fades and loops. */
const HOLD = 5;
const FADE = 0.8;

export type Timed = SessionStep & { at: number; answered: number };

export type Schedule = {
  steps: Timed[];
  /** Loop length in seconds. */
  length: number;
  fade: [number, number];
  calls: number;
  /** Seconds of video on V1 once every clip has landed. */
  seconds: number;
};

export function schedule(data: SessionData): Schedule {
  const steps: Timed[] = [];
  let t = START;
  for (const [i, s] of data.steps.entries()) {
    const next = data.steps[i + 1];
    const answered = s.kind === 'call' ? t + (s.wait ?? QUICK) : t;
    steps.push({ ...s, at: t, answered });
    if (s.kind === 'call') t = answered + (next?.kind === 'call' ? 0.25 : 0.45);
    else t += s.text.length / TYPING[s.kind] + (s.kind === 'user' ? 0.9 : 0.5);
  }
  const end = t + HOLD;
  return {
    steps,
    length: end + FADE + 0.2,
    fade: [end, end + FADE],
    calls: steps.filter((s) => s.kind === 'call').length,
    seconds: Math.max(0, ...clips(steps).map((c) => c.effect.to)),
  };
}

type Clip = Timed & { kind: 'call'; effect: Extract<Effect, { type: 'clip' }> };

/** The V1 clips, in the order they land. */
export function clips(steps: Timed[]): Clip[] {
  return steps.filter(
    (s): s is Clip =>
      s.kind === 'call' && s.effect?.type === 'clip' && s.effect.tracks.includes('V1'),
  );
}

export function effect<T extends Effect['type']>(
  steps: Timed[],
  type: T,
): (Timed & { effect: Extract<Effect, { type: T }> }) | undefined {
  return steps.find((s) => s.kind === 'call' && s.effect?.type === type) as
    | (Timed & { effect: Extract<Effect, { type: T }> })
    | undefined;
}

/** Calls that make a new timeline. Reads (media.*, qa, render, export) don't. */
export function edits(steps: Timed[], t: number): number {
  return steps.filter(
    (s) => s.kind === 'call' && t >= s.answered && !/^(media|qa|render|export|job)\./.test(s.fn),
  ).length;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function timecode(seconds: number, fps: number): string {
  const frames = Math.round(seconds * fps);
  const s = Math.floor(frames / fps);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(frames % fps)}`;
}

export function timelineLabel(n: number): string {
  return n === 0 ? 'no timeline' : `tl_${pad(n)}`;
}

export function idleStatus(s: Schedule): string {
  return `idle · ${s.calls} tool calls · ${Math.round(s.seconds)}s of video`;
}
