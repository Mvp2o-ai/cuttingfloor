import type { StoredClip, StoredSpeed } from '@cuttingfloor/schema';

// Clip speed: a playback rate that is constant or piecewise-linear over the clip (a speed
// ramp), optionally reversed. Rate 0 is a freeze frame. `in` is always the lowest source
// position the clip shows; a reversed clip plays its span from the end back to `in`.
//
// Shrinking a clip (trim inwards, split, an overwrite cutting it) keeps what plays exactly:
// the ramp is cut with it. Extending continues at the rate of the edge it grows from.

export interface RatePoint {
  /** Ticks from the clip start. */
  t: number;
  rate: number;
}

type Timed = Pick<StoredClip, 'in' | 'duration' | 'speed'>;

/** The rate curve over the clip, as points from 0 to the clip's duration. */
export function ratePoints(clip: Timed): RatePoint[] {
  const s = clip.speed;
  if (s?.curve) return s.curve;
  const rate = s?.rate ?? 1;
  return [
    { t: 0, rate },
    { t: clip.duration, rate },
  ];
}

/** Rate at tick `t` from the clip start (linear between points, held past the ends). */
export function rateAt(points: RatePoint[], t: number): number {
  const first = points[0];
  if (!first || t <= first.t) return first?.rate ?? 1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as RatePoint;
    const b = points[i] as RatePoint;
    if (t <= b.t)
      return b.t === a.t ? b.rate : a.rate + ((b.rate - a.rate) * (t - a.t)) / (b.t - a.t);
  }
  return points[points.length - 1]?.rate ?? 1;
}

/**
 * Source ticks played from the clip start to tick `t`: the integral of the rate. Before the
 * start and past the end it continues at the edge rate (a transition plays source there).
 */
export function played(points: RatePoint[], t: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (first && t < first.t) return first.rate * (t - first.t);
  if (last && t > last.t) return played(points, last.t) + last.rate * (t - last.t);
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as RatePoint;
    const b = points[i] as RatePoint;
    if (t <= a.t) break;
    const end = Math.min(t, b.t);
    const r1 = rateAt(points, end);
    sum += ((a.rate + r1) / 2) * (end - a.t);
  }
  return sum;
}

/** Source ticks the whole clip covers. */
export function span(clip: Timed): number {
  return Math.round(played(ratePoints(clip), clip.duration));
}

/**
 * Source position of the picture shown at frame `i`. A frame covers a stretch of source; going
 * forward it shows the first moment of it, in reverse the last frame before it, so a reversed
 * clip's first frame is the source's last frame rather than the end of it.
 */
export function frameSource(clip: Timed, tpf: number, i: number): number {
  const points = ratePoints(clip);
  if (!clip.speed?.reverse) return clip.in + played(points, i * tpf);
  return clip.in + span(clip) - played(points, (i + 1) * tpf);
}

/** Stores a curve compactly: a constant curve becomes a plain rate; rate 1 forward is no speed. */
function normalised(points: RatePoint[], base: StoredSpeed | undefined): StoredSpeed | undefined {
  const rate = points[0]?.rate ?? 1;
  const flat = points.every((p) => Math.abs(p.rate - rate) < 1e-9);
  const out: StoredSpeed = {
    ...(flat ? (rate === 1 ? {} : { rate }) : { curve: points }),
    ...(base?.reverse ? { reverse: true } : {}),
    ...(base?.preserve_pitch === false ? { preserve_pitch: false } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** The part of a clip between ticks `t0` and `t1` from its start: new `in`, duration and speed. */
export function subclip(
  clip: Timed,
  t0: number,
  t1: number,
): { in: number; duration: number; speed?: StoredSpeed } {
  const points = ratePoints(clip);
  if (!clip.speed) return { in: clip.in + t0, duration: t1 - t0 };
  const inside = points.filter((p) => p.t > t0 && p.t < t1);
  const cut: RatePoint[] = [
    { t: 0, rate: rateAt(points, t0) },
    ...inside.map((p) => ({ t: p.t - t0, rate: p.rate })),
    { t: t1 - t0, rate: rateAt(points, t1) },
  ];
  const total = span(clip);
  const start = clip.speed.reverse
    ? clip.in + total - Math.round(played(points, t1))
    : clip.in + Math.round(played(points, t0));
  const speed = normalised(cut, clip.speed);
  return { in: start, duration: t1 - t0, ...(speed ? { speed } : {}) };
}

/** A clip grown by `delta` ticks at one edge, continuing at that edge's rate. */
export function extended(
  clip: Timed,
  edge: 'start' | 'end',
  delta: number,
): { in: number; duration: number; speed?: StoredSpeed } {
  if (!clip.speed) {
    return edge === 'end'
      ? { in: clip.in, duration: clip.duration + delta }
      : { in: clip.in - delta, duration: clip.duration + delta };
  }
  const points = ratePoints(clip);
  const duration = clip.duration + delta;
  let grown: RatePoint[];
  let added: number;
  if (edge === 'end') {
    const last = points[points.length - 1] as RatePoint;
    grown = [...points, { t: duration, rate: last.rate }];
    added = last.rate * delta;
  } else {
    const first = points[0] as RatePoint;
    grown = [{ t: 0, rate: first.rate }, ...points.map((p) => ({ t: p.t + delta, rate: p.rate }))];
    added = first.rate * delta;
  }
  // Source grows at the timeline end for forward clips and at the start for reversed ones.
  const growsLow = clip.speed.reverse ? edge === 'end' : edge === 'start';
  const speed = normalised(dedupe(grown), clip.speed);
  return {
    in: growsLow ? clip.in - Math.round(added) : clip.in,
    duration,
    ...(speed ? { speed } : {}),
  };
}

/** Drops points that repeat their neighbour's time. */
function dedupe(points: RatePoint[]): RatePoint[] {
  return points.filter((p, i) => i === 0 || p.t !== (points[i - 1] as RatePoint).t);
}

/** Mean rate of a curve given at fractions of the clip (0–1): its area. */
export function meanRate(curve: Array<{ at: number; rate: number }>): number {
  let area = 0;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1] as { at: number; rate: number };
    const b = curve[i] as { at: number; rate: number };
    area += ((a.rate + b.rate) / 2) * (b.at - a.at);
  }
  return area;
}
