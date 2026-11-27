import type { FrameRate, MeterChange, ScoreDoc, TempoChange } from '@cuttingfloor/schema';

// Score time. Positions are beats (a quarter note is 1) under a tempo map; seconds and frames
// are worked out here and nowhere else, so every tool gives the same answer for the same beat.
// A ramp glides linearly in beats from the change before to its own tempo, arriving on its beat.

interface Segment {
  /** Beat and second the segment starts at. */
  at: number;
  seconds: number;
  /** Tempo at its start, and at its end when it glides (else the same). */
  from: number;
  to: number;
  /** Beats it lasts; Infinity for the last. */
  length: number;
}

function segments(tempo: TempoChange[]): Segment[] {
  const changes = [...tempo].sort((a, b) => a.at - b.at);
  const out: Segment[] = [];
  let seconds = 0;
  for (const [i, change] of changes.entries()) {
    const next = changes[i + 1];
    const length = next ? next.at - change.at : Number.POSITIVE_INFINITY;
    const segment: Segment = {
      at: change.at,
      seconds,
      from: change.bpm,
      to: next?.ramp ? next.bpm : change.bpm,
      length,
    };
    out.push(segment);
    if (next) seconds += secondsInto(segment, length);
  }
  return out;
}

/** Seconds from a segment's start to `x` beats into it. */
function secondsInto(s: Segment, x: number): number {
  if (s.to === s.from || !Number.isFinite(s.length)) return (60 * x) / s.from;
  const slope = (s.to - s.from) / s.length;
  return (60 / slope) * Math.log((s.from + slope * x) / s.from);
}

/** Beats from a segment's start to `t` seconds into it. */
function beatsInto(s: Segment, t: number): number {
  if (s.to === s.from || !Number.isFinite(s.length)) return (t * s.from) / 60;
  const slope = (s.to - s.from) / s.length;
  return (s.from / slope) * (Math.exp((t * slope) / 60) - 1);
}

/** The second a beat falls on. Beats before 0 run at the opening tempo. */
export function beatsToSeconds(tempo: TempoChange[], beats: number): number {
  const segs = segments(tempo);
  const s = segs.findLast((seg) => seg.at <= beats) ?? (segs[0] as Segment);
  return s.seconds + secondsInto(s, beats - s.at);
}

/** The beat a second falls on. Seconds before 0 run at the opening tempo. */
export function secondsToBeats(tempo: TempoChange[], seconds: number): number {
  const segs = segments(tempo);
  const s = segs.findLast((seg) => seg.seconds <= seconds) ?? (segs[0] as Segment);
  return s.at + beatsInto(s, seconds - s.seconds);
}

/** The tempo in beats per minute at a beat (part way through a glide, the tempo it has reached). */
export function tempoAt(tempo: TempoChange[], beats: number): number {
  const segs = segments(tempo);
  const s = segs.findLast((seg) => seg.at <= beats) ?? (segs[0] as Segment);
  if (s.to === s.from || !Number.isFinite(s.length)) return s.from;
  return s.from + ((s.to - s.from) * (beats - s.at)) / s.length;
}

/** Beats (quarter notes) in one bar of a meter. */
export function barLength(meter: Pick<MeterChange, 'beats' | 'unit'>): number {
  return (meter.beats * 4) / meter.unit;
}

interface MeterSpan {
  bar: number;
  at: number;
  length: number;
  meter: MeterChange;
}

function meterSpans(meter: MeterChange[]): MeterSpan[] {
  const changes = [...meter].sort((a, b) => a.bar - b.bar);
  const out: MeterSpan[] = [];
  let at = 0;
  for (const [i, change] of changes.entries()) {
    const length = barLength(change);
    out.push({ bar: change.bar, at, length, meter: change });
    const next = changes[i + 1];
    if (next) at += (next.bar - change.bar) * length;
  }
  return out;
}

/** The beat a bar starts on. Bars count from 1. */
export function barToBeats(meter: MeterChange[], bar: number): number {
  const spans = meterSpans(meter);
  const s = spans.findLast((span) => span.bar <= bar) ?? (spans[0] as MeterSpan);
  return s.at + (bar - s.bar) * s.length;
}

/** The bar a beat falls in (from 1), and how many beats into that bar it is. */
export function beatsToBar(meter: MeterChange[], beats: number): { bar: number; into: number } {
  const spans = meterSpans(meter);
  const s = spans.findLast((span) => span.at <= beats) ?? (spans[0] as MeterSpan);
  const bars = Math.floor((beats - s.at) / s.length + 1e-9);
  return { bar: s.bar + bars, into: beats - s.at - bars * s.length };
}

/** A position in a score every way a tool gives it. */
export interface Position {
  beats: number;
  seconds: number;
  /** In frames at the score's fps, exact (45.5 is half way through frame 45); absent without fps. */
  frames?: number;
}

const tidy = (n: number) => Math.round(n * 1e9) / 1e9;

/** Frames at a rate for a time in seconds, exact (not rounded to a whole frame). */
export function secondsToFrames(fps: FrameRate, seconds: number): number {
  return Math.round(((seconds * fps.num) / fps.den) * 1e6) / 1e6;
}

/** Where a beat of a score sits in beats, seconds and (with fps) frames. */
export function positionAt(score: Pick<ScoreDoc, 'tempo' | 'fps'>, beats: number): Position {
  // Frames come from the unrounded time, so a beat that lands on a frame says so exactly.
  const seconds = beatsToSeconds(score.tempo, beats);
  return {
    beats: tidy(beats),
    seconds: tidy(seconds),
    ...(score.fps ? { frames: secondsToFrames(score.fps, seconds) } : {}),
  };
}

/** Where a time in seconds sits in a score, in beats, seconds and (with fps) frames. */
export function positionAtSeconds(
  score: Pick<ScoreDoc, 'tempo' | 'fps'>,
  seconds: number,
): Position {
  return {
    beats: tidy(secondsToBeats(score.tempo, seconds)),
    seconds: tidy(seconds),
    ...(score.fps ? { frames: secondsToFrames(score.fps, seconds) } : {}),
  };
}

/** Where each bar starts from one beat up to (not including) another, at most `limit` bars. */
export function barsBetween(
  score: Pick<ScoreDoc, 'tempo' | 'meter' | 'fps'>,
  fromBeats: number,
  untilBeats: number,
  limit: number,
): Array<Position & { bar: number }> {
  const out: Array<Position & { bar: number }> = [];
  const first = beatsToBar(score.meter, fromBeats);
  let bar = first.into > 1e-9 ? first.bar + 1 : first.bar;
  while (out.length < limit) {
    const at = barToBeats(score.meter, bar);
    if (at >= untilBeats - 1e-9) break;
    out.push({ bar, ...positionAt(score, at) });
    bar += 1;
  }
  return out;
}
