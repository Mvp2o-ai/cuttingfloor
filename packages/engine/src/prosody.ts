import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSound, type Range } from './speech.ts';

// How a voice sounds over time: its pitch (YIN, de Cheveigné and Kawahara, "YIN, a fundamental
// frequency estimator for speech and music", JASA 2002), its level (RMS) and, from a transcript
// when there is one, its pace. All in this process on 16 kHz mono; deterministic.

const RATE = 16_000;
/** YIN's integration window (40 ms) and hop (10 ms). */
const WINDOW = 640;
const HOP = 160;
/** Pitch searched from 60 Hz (a low male voice) to 500 Hz (a high child's). */
const MIN_HZ = 60;
const MAX_HZ = 500;
/** YIN's absolute threshold on the normalised difference (the paper uses 0.1 to 0.15). */
const YIN_THRESHOLD = 0.15;
/** Each reported frame covers this many hops (0.1 s). */
const HOPS_PER_FRAME = 10;
export const VOICE_FRAME_SECONDS = (HOP * HOPS_PER_FRAME) / RATE;
export const VOICE_METHOD = 'yin-60-500hz';

export interface VoiceFrame {
  /** Seconds where the frame starts. */
  time: number;
  /** Median pitch of the voiced 10 ms hops in the frame; null when none are voiced. */
  pitch_hz: number | null;
  /** Share of the frame's hops with a clear pitch, 0–1. */
  voiced: number;
  /** RMS level over the frame, dBFS; null for digital silence. */
  level_db: number | null;
}

export interface VoiceSummary {
  seconds: number;
  voiced_seconds: number;
  pitch_hz: { median: number; p10: number; p90: number } | null;
  /** p10 to p90 of the pitch, in semitones: how much the voice moves up and down. */
  pitch_range_semitones: number | null;
  /** RMS over the whole stretch, and the quieter and louder frames, dBFS. */
  level_db: { rms: number | null; p10: number | null; p90: number | null };
}

export interface VoiceSeries {
  method: string;
  frame_seconds: number;
  from: number;
  summary: VoiceSummary;
  frames: VoiceFrame[];
}

/** One hop's pitch by YIN, or null when no period is clear enough. */
function yin(x: Float32Array, start: number, diff: Float64Array): number | null {
  const tauMax = Math.floor(RATE / MIN_HZ);
  const tauMin = Math.ceil(RATE / MAX_HZ);
  if (start + WINDOW + tauMax > x.length) return null;
  diff[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    for (let j = 0; j < WINDOW; j++) {
      const v = (x[start + j] as number) - (x[start + j + tau] as number);
      d += v * v;
    }
    running += d;
    // Cumulative mean normalised difference.
    diff[tau] = running > 0 ? (d * tau) / running : 1;
  }
  let tau = tauMin;
  for (; tau <= tauMax; tau++) {
    if ((diff[tau] as number) < YIN_THRESHOLD) {
      while (tau + 1 <= tauMax && (diff[tau + 1] as number) < (diff[tau] as number)) tau++;
      break;
    }
  }
  if (tau > tauMax) return null;
  // Parabolic interpolation around the minimum.
  const a = diff[tau - 1] ?? (diff[tau] as number);
  const b = diff[tau] as number;
  const c = diff[tau + 1] ?? b;
  const den = a - 2 * b + c;
  const shift = den ? (0.5 * (a - c)) / den : 0;
  return RATE / (tau + Math.max(-1, Math.min(1, shift)));
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo);
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const db = (meanSquare: number) => (meanSquare > 0 ? r1(10 * Math.log10(meanSquare)) : null);

/** Pitch and level of mono 16 kHz samples, `from` seconds being the first sample's time. */
export function voiceSeries(x: Float32Array, from = 0): VoiceSeries {
  const diff = new Float64Array(Math.floor(RATE / MIN_HZ) + 2);
  const hops = Math.max(0, Math.floor(x.length / HOP));
  const pitches: Array<number | null> = new Array(hops);
  for (let h = 0; h < hops; h++) pitches[h] = yin(x, h * HOP, diff);
  const frames: VoiceFrame[] = [];
  const levels: number[] = [];
  let total = 0;
  for (let f = 0; f * HOPS_PER_FRAME < hops; f++) {
    const first = f * HOPS_PER_FRAME;
    const last = Math.min(hops, first + HOPS_PER_FRAME);
    const voiced = pitches.slice(first, last).filter((p): p is number => p !== null);
    voiced.sort((a, b) => a - b);
    let sq = 0;
    const s0 = first * HOP;
    const s1 = Math.min(x.length, last * HOP);
    for (let i = s0; i < s1; i++) sq += (x[i] as number) ** 2;
    total += sq;
    const level = db(sq / Math.max(1, s1 - s0));
    if (level !== null) levels.push(level);
    frames.push({
      time: r3(from + (first * HOP) / RATE),
      pitch_hz: voiced.length ? r1(percentile(voiced, 0.5)) : null,
      voiced: r2(voiced.length / (last - first)),
      level_db: level,
    });
  }
  const voicedAll = pitches.filter((p): p is number => p !== null).sort((a, b) => a - b);
  levels.sort((a, b) => a - b);
  const p10 = percentile(voicedAll, 0.1);
  const p90 = percentile(voicedAll, 0.9);
  return {
    method: VOICE_METHOD,
    frame_seconds: VOICE_FRAME_SECONDS,
    from: r3(from),
    summary: {
      seconds: r3(x.length / RATE),
      voiced_seconds: r3((voicedAll.length * HOP) / RATE),
      pitch_hz: voicedAll.length
        ? { median: r1(percentile(voicedAll, 0.5)), p10: r1(p10), p90: r1(p90) }
        : null,
      pitch_range_semitones: voicedAll.length ? r2(12 * Math.log2(p90 / p10)) : null,
      level_db: {
        rms: db(total / Math.max(1, x.length)),
        p10: levels.length ? r1(percentile(levels, 0.1)) : null,
        p90: levels.length ? r1(percentile(levels, 0.9)) : null,
      },
    },
    frames,
  };
}

/** The voice of a file over a range: pitch and level every 0.1 s, on the file's clock. */
export async function measureVoice(
  file: string,
  options: Range & { signal?: AbortSignal } = {},
): Promise<VoiceSeries> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-voice-'));
  try {
    const raw = await extractSound(file, dir, { ...options, rate: RATE });
    const buf = await readFile(raw);
    const x = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
    return voiceSeries(x, options.from ?? 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
