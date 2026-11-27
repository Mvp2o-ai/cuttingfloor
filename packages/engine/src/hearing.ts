import { CfError } from '@cuttingfloor/schema';
import { fft } from './correlate.ts';
import { BIN, KILL_SETTLE_MS, killTree, spawnEngine } from './exec.ts';
import { noAudio, type Range } from './speech.ts';

// Measured facts about any sound, by signal math in this process (no model): the level on steps
// and where it rises (onsets), the level in third-octave bands (spectrum), the strength of the 12
// note names and a score for the 24 keys (key), and the notes of a single line (notes, from a YIN
// pitch line). Every threshold is the caller's argument. The sound is streamed from FFmpeg, so
// long media never sits in memory whole, except for notes, whose range the server limits.

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** dB of a mean square (RMS dBFS: a full-scale sine is -3); null for digital silence. */
const dbOf = (meanSquare: number) => (meanSquare > 0 ? r1(10 * Math.log10(meanSquare)) : null);

// ---------------------------------------------------------------------------------------------
// Reading sound

/**
 * Streams the sound of `file` (over a range) at `rate` to `sink`, one block of samples per
 * channel at a time, every channel kept. Fails with no_audio when there is none.
 */
export function streamSound(
  file: string,
  options: Range & { rate: number; signal?: AbortSignal },
  sink: (channels: Float32Array[]) => void,
): Promise<{ channels: number; frames: number }> {
  if (options.until !== undefined && options.until <= (options.from ?? 0)) {
    return Promise.reject(noAudio(options, 'the range is empty'));
  }
  return new Promise((resolve, reject) => {
    const ff = spawnEngine(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        ...(options.from ? ['-ss', String(options.from)] : []),
        ...(options.until !== undefined ? ['-to', String(options.until)] : []),
        '-i',
        `file:${file}`,
        '-vn',
        '-map_metadata',
        '-1',
        '-ar',
        String(options.rate),
        '-c:a',
        'pcm_f32le',
        '-flags',
        '+bitexact',
        '-fflags',
        '+bitexact',
        '-f',
        'wav',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let head: Buffer | null = Buffer.alloc(0);
    let channels = 0;
    let rest = Buffer.alloc(0);
    let frames = 0;
    let failed: unknown = null;
    let err = '';
    const feed = (bytes: Buffer) => {
      const all = rest.length ? Buffer.concat([rest, bytes]) : bytes;
      const width = 4 * channels;
      const n = Math.floor(all.length / width);
      rest = Buffer.from(all.subarray(n * width));
      if (!n) return;
      const aligned = Buffer.from(all.subarray(0, n * width));
      const x = new Float32Array(aligned.buffer, aligned.byteOffset, n * channels);
      const out = Array.from({ length: channels }, () => new Float32Array(n));
      for (let i = 0; i < n; i++)
        for (let c = 0; c < channels; c++)
          (out[c] as Float32Array)[i] = x[i * channels + c] as number;
      frames += n;
      sink(out);
    };
    ff.stdout.on('data', (d: Buffer) => {
      if (failed) return;
      try {
        if (head) {
          head = Buffer.concat([head, d]);
          // RIFF, WAVE, then chunks up to "data": fmt carries the channel count.
          let at = 12;
          while (at + 8 <= head.length) {
            const id = head.toString('latin1', at, at + 4);
            const size = head.readUInt32LE(at + 4);
            if (id === 'fmt ' && at + 12 <= head.length) channels = head.readUInt16LE(at + 10);
            if (id === 'data') {
              const body = head.subarray(at + 8);
              head = null;
              if (!channels) throw new CfError('engine_error', 'Could not read the sound');
              feed(Buffer.from(body));
              return;
            }
            at += 8 + size + (size % 2);
          }
          return;
        }
        feed(d);
      } catch (error) {
        failed = error;
        killTree(ff);
      }
    });
    ff.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    const kill = () => {
      killTree(ff);
      setTimeout(() => reject(new CfError('cancelled', 'Cancelled')), KILL_SETTLE_MS).unref();
    };
    options.signal?.addEventListener('abort', kill, { once: true });
    ff.on('error', (e) => reject(e));
    ff.on('close', (code) => {
      options.signal?.removeEventListener('abort', kill);
      if (options.signal?.aborted) return reject(new CfError('cancelled', 'Cancelled'));
      if (failed) return reject(failed);
      if (code !== 0) {
        if (
          /does not contain any stream|matches no streams|no audio|Output file is empty/i.test(err)
        )
          return reject(noAudio(options, 'it has no audio stream'));
        return reject(
          new CfError('engine_error', 'Could not read the sound', { detail: { stderr: err } }),
        );
      }
      if (!frames) return reject(noAudio(options, 'no samples there (past the end, or no audio)'));
      resolve({ channels, frames });
    });
  });
}

/** The channels averaged into one. */
function mono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0] as Float32Array;
  const n = (channels[0] as Float32Array).length;
  const out = new Float32Array(n);
  for (const c of channels)
    for (let i = 0; i < n; i++) out[i] = (out[i] as number) + (c[i] as number);
  for (let i = 0; i < n; i++) out[i] = (out[i] as number) / channels.length;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Level on steps, and onsets

/** Band edges for an onset's share of low, mid and high, Hz. */
export const ONSET_BANDS = { low_below_hz: 250, high_above_hz: 4000 } as const;

/** A second-order Butterworth section (RBJ cookbook), Q = 1/√2; two in a row make LR4. */
class Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
  constructor(kind: 'low' | 'high', hz: number, rate: number) {
    const w = (2 * Math.PI * hz) / rate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    const edge = kind === 'low' ? (1 - cos) / 2 : (1 + cos) / 2;
    this.b0 = edge / a0;
    this.b1 = ((kind === 'low' ? 2 : -2) * edge) / a0;
    this.b2 = edge / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  step(x: number): number {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

export interface StepLevels {
  /** Seconds where the first step starts. */
  start: number;
  step: number;
  /** Per step: mean square over every channel's samples. */
  meanSquares: number[];
  /** Per step, with bands: the share of low, mid and high in the sound mixed to one channel. */
  bands?: Array<[number, number, number]>;
}

/**
 * Level on steps of `step` seconds (sample-exact: step i covers samples round(i·step·rate) up to
 * round((i+1)·step·rate)), and with `bands` each step's share of low, mid and high. Push blocks,
 * then finish. A last step shorter than the rest is measured over what it has.
 */
export function stepMeter(rate: number, step: number, start: number, bands = false) {
  let pos = 0;
  let index = 0;
  let boundary = Math.round(step * rate);
  let sum = 0;
  let count = 0;
  const e = [0, 0, 0];
  const meanSquares: number[] = [];
  const shares: Array<[number, number, number]> = [];
  const lo = [
    new Biquad('low', ONSET_BANDS.low_below_hz, rate),
    new Biquad('low', ONSET_BANDS.low_below_hz, rate),
  ];
  const hi = [
    new Biquad('high', ONSET_BANDS.high_above_hz, rate),
    new Biquad('high', ONSET_BANDS.high_above_hz, rate),
  ];
  const mid = [
    new Biquad('high', ONSET_BANDS.low_below_hz, rate),
    new Biquad('high', ONSET_BANDS.low_below_hz, rate),
    new Biquad('low', ONSET_BANDS.high_above_hz, rate),
    new Biquad('low', ONSET_BANDS.high_above_hz, rate),
  ];
  const close = () => {
    meanSquares.push(count ? sum / count : 0);
    if (bands) {
      const total = (e[0] as number) + (e[1] as number) + (e[2] as number);
      shares.push(
        total > 0
          ? [
              r2((e[0] as number) / total),
              r2((e[1] as number) / total),
              r2((e[2] as number) / total),
            ]
          : [0, 0, 0],
      );
    }
    sum = 0;
    count = 0;
    e[0] = e[1] = e[2] = 0;
    index += 1;
    boundary = Math.round((index + 1) * step * rate);
  };
  return {
    push(channels: Float32Array[]) {
      const n = (channels[0] as Float32Array).length;
      const m = bands ? mono(channels) : null;
      for (let i = 0; i < n; i++) {
        for (const c of channels) {
          const v = c[i] as number;
          sum += v * v;
        }
        count += channels.length;
        if (m) {
          const x = m[i] as number;
          const l = (lo[1] as Biquad).step((lo[0] as Biquad).step(x));
          const h = (hi[1] as Biquad).step((hi[0] as Biquad).step(x));
          let md = x;
          for (const f of mid) md = f.step(md);
          e[0] = (e[0] as number) + l * l;
          e[1] = (e[1] as number) + md * md;
          e[2] = (e[2] as number) + h * h;
        }
        pos += 1;
        if (pos >= boundary) close();
      }
    },
    finish(): StepLevels {
      if (count) close();
      return { start, step, meanSquares, ...(bands ? { bands: shares } : {}) };
    },
  };
}

/** Per step, the level in dB (RMS dBFS over every channel); null for digital silence. */
export function levelsDb(levels: StepLevels): Array<number | null> {
  return levels.meanSquares.map(dbOf);
}

export interface Onset {
  /** Seconds where the step that rose starts. */
  time: number;
  /** How much louder it is than the step before, dB; null when that step was digital silence. */
  rise_db: number | null;
  /** The level of the step, RMS dBFS. */
  level_db: number;
  /** Shares of the step's sound below 250 Hz, from 250 Hz to 4 kHz, and above 4 kHz (sum 1). */
  low: number;
  mid: number;
  high: number;
}

/**
 * Every step whose level rises by `thresholdDb` or more over the step before it; the first
 * step has none before it. A step after digital silence rises from nothing (rise_db null).
 */
export function onsetsOf(levels: StepLevels, thresholdDb: number): Onset[] {
  const db = levelsDb(levels);
  const out: Onset[] = [];
  for (let i = 1; i < db.length; i++) {
    const cur = db[i];
    const prev = db[i - 1];
    if (cur === null || cur === undefined) continue;
    const rise = prev === null || prev === undefined ? null : cur - prev;
    if (rise !== null && rise < thresholdDb) continue;
    const b = levels.bands?.[i] ?? [0, 0, 0];
    out.push({
      time: r3(levels.start + i * levels.step),
      rise_db: rise === null ? null : r1(rise),
      level_db: cur,
      low: b[0],
      mid: b[1],
      high: b[2],
    });
  }
  return out;
}

/** Sample rate the level, onsets and spectrum are read at. */
export const LEVEL_RATE = 48_000;

/** The level of a file's sound on steps of `step` seconds (with bands: their shares too). */
export async function measureSteps(
  file: string,
  options: Range & { step: number; bands?: boolean; signal?: AbortSignal },
): Promise<StepLevels> {
  const meter = stepMeter(LEVEL_RATE, options.step, options.from ?? 0, options.bands);
  await streamSound(file, { ...options, rate: LEVEL_RATE }, (block) => meter.push(block));
  return meter.finish();
}

// ---------------------------------------------------------------------------------------------
// Spectrum: third-octave bands

/** Third-octave band centres from 20 Hz to 20 kHz (base 10: 1000·10^(n/10)), as named. */
export const THIRD_OCTAVE_HZ = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
] as const;
const BAND_EDGES = THIRD_OCTAVE_HZ.map((_, i) => {
  const exact = 1000 * 10 ** ((i - 17) / 10);
  return [exact * 10 ** (-1 / 20), exact * 10 ** (1 / 20)] as const;
});

/** The spectrum's FFT: 8192 samples (about 0.17 s at 48 kHz), half overlapping. */
const SPECTRUM_FRAME = 8192;
const SPECTRUM_HOP = 4096;

export interface Spectrum {
  bands_hz: number[];
  /** Per band, over the whole range: dB (RMS dBFS of what lies in the band); null for none. */
  level_db: Array<number | null>;
  /** With a step: per step, per band, the same. */
  steps?: { start: number; step: number; level_db: Array<Array<number | null> | null> };
}

/**
 * Level in each third-octave band from 20 Hz to 20 kHz of sound mixed to one channel: Hann
 * windows of 8192 samples, half overlapping, each bin's power shared among the bands its width
 * overlaps; a window counts in the step its middle falls in. Push blocks, then finish.
 */
export function spectrumMeter(rate: number, start: number, step?: number) {
  const N = SPECTRUM_FRAME;
  const window = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const wsq = window.reduce((s, w) => s + w * w, 0);
  const df = rate / N;
  // Each bin's share in each band, by overlap of [f - df/2, f + df/2) with the band.
  const share: Array<Array<[number, number]>> = [];
  for (let k = 1; k < N / 2; k++) {
    const lo = (k - 0.5) * df;
    const hi = (k + 0.5) * df;
    const parts: Array<[number, number]> = [];
    BAND_EDGES.forEach(([a, b], band) => {
      const o = Math.min(hi, b) - Math.max(lo, a);
      if (o > 0) parts.push([band, o / df]);
    });
    share.push(parts);
  }
  const ring = new Float64Array(N);
  let filled = 0;
  let total = 0;
  const whole = new Float64Array(THIRD_OCTAVE_HZ.length);
  let frames = 0;
  const perStep = new Map<number, { sum: Float64Array; frames: number }>();
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const analyse = () => {
    for (let i = 0; i < N; i++) {
      re[i] = (ring[i] as number) * (window[i] as number);
      im[i] = 0;
    }
    fft(re, im);
    const power = new Float64Array(THIRD_OCTAVE_HZ.length);
    for (let k = 1; k < N / 2; k++) {
      const p = (2 * ((re[k] as number) ** 2 + (im[k] as number) ** 2)) / (N * wsq);
      for (const [band, f] of share[k - 1] as Array<[number, number]>)
        power[band] = (power[band] as number) + p * f;
    }
    for (let b = 0; b < power.length; b++) whole[b] = (whole[b] as number) + (power[b] as number);
    frames += 1;
    if (step) {
      const middle = (total - N / 2) / rate;
      const at = Math.floor(middle / step + 1e-9);
      const s = perStep.get(at) ?? { sum: new Float64Array(THIRD_OCTAVE_HZ.length), frames: 0 };
      for (let b = 0; b < power.length; b++) s.sum[b] = (s.sum[b] as number) + (power[b] as number);
      s.frames += 1;
      perStep.set(at, s);
    }
  };
  return {
    push(channels: Float32Array[]) {
      const x = mono(channels);
      for (let i = 0; i < x.length; i++) {
        ring[filled++] = x[i] as number;
        total += 1;
        if (filled === N) {
          analyse();
          ring.copyWithin(0, SPECTRUM_HOP, N);
          filled = N - SPECTRUM_HOP;
        }
      }
    },
    finish(): Spectrum {
      const levels = (sum: Float64Array, n: number) =>
        Array.from(sum, (p) => (n && p > 0 ? dbOf(p / n) : null));
      const out: Spectrum = {
        bands_hz: [...THIRD_OCTAVE_HZ],
        level_db: levels(whole, frames),
      };
      if (step) {
        const count = Math.ceil(total / rate / step - 1e-9);
        out.steps = {
          start: r3(start),
          step,
          level_db: Array.from({ length: count }, (_, i) => {
            const s = perStep.get(i);
            return s ? levels(s.sum, s.frames) : null;
          }),
        };
      }
      return out;
    },
  };
}

/** The spectrum of a file's sound over a range, whole and with `step`, per step. */
export async function measureSpectrum(
  file: string,
  options: Range & { step?: number; signal?: AbortSignal },
): Promise<Spectrum> {
  const meter = spectrumMeter(LEVEL_RATE, options.from ?? 0, options.step);
  await streamSound(file, { ...options, rate: LEVEL_RATE }, (block) => meter.push(block));
  return meter.finish();
}

// ---------------------------------------------------------------------------------------------
// Key: the 12 note names and the 24 keys

export const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;
/** Krumhansl and Kessler's key profiles (1982), from C. */
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** The key's FFT: 4096 samples at 11,025 Hz (about 0.37 s), half overlapping; C2 to C8. */
export const KEY_RATE = 11_025;
const KEY_FRAME = 4096;
const KEY_HOP = 2048;
const KEY_LOW_HZ = 65.4;
const KEY_HIGH_HZ = 4186;

export interface KeyFacts {
  /** Per key ("C major" … "B minor"): 0–1, the correlation of the note strengths with the key's profile, (r + 1) / 2. */
  scores: Record<string, number>;
  /** Strength of each note name over the whole range, 0–1 of the strongest. */
  notes: Record<string, number>;
  /** With a step: per step, the 12 strengths (C first) 0–1 of that step's strongest; null when nothing sounds. */
  steps?: { start: number; step: number; notes: Array<number[] | null> };
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] as number) - ma;
    const y = (b[i] as number) - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/** A score 0–1 for each of the 24 keys from 12 note strengths (C first). */
export function keyScores(chroma: ArrayLike<number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [mode, profile] of [
    ['major', MAJOR],
    ['minor', MINOR],
  ] as const) {
    for (let k = 0; k < 12; k++) {
      const rotated = Array.from({ length: 12 }, (_, i) => profile[(i - k + 12) % 12] as number);
      out[`${NOTE_NAMES[k]} ${mode}`] = r3((pearson(chroma, rotated) + 1) / 2);
    }
  }
  return out;
}

const normalise = (v: ArrayLike<number>) => {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, v[i] as number);
  return max > 0 ? Array.from(v, (x) => r3(x / max)) : null;
};

/** Note-name strengths of sound mixed to one channel at KEY_RATE. Push blocks, then finish. */
export function keyMeter(rate: number, start: number, step?: number) {
  const N = KEY_FRAME;
  const window = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const classOf = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * rate) / N;
    if (f < KEY_LOW_HZ || f > KEY_HIGH_HZ) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    classOf[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const ring = new Float64Array(N);
  let filled = 0;
  let total = 0;
  const whole = new Float64Array(12);
  const perStep = new Map<number, Float64Array>();
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const analyse = () => {
    for (let i = 0; i < N; i++) {
      re[i] = (ring[i] as number) * (window[i] as number);
      im[i] = 0;
    }
    fft(re, im);
    const c = new Float64Array(12);
    for (let k = 1; k < N / 2; k++) {
      const pc = classOf[k] as number;
      if (pc >= 0) c[pc] = (c[pc] as number) + Math.hypot(re[k] as number, im[k] as number);
    }
    for (let i = 0; i < 12; i++) whole[i] = (whole[i] as number) + (c[i] as number);
    if (step) {
      const at = Math.floor((total - N / 2) / rate / step + 1e-9);
      const s = perStep.get(at) ?? new Float64Array(12);
      for (let i = 0; i < 12; i++) s[i] = (s[i] as number) + (c[i] as number);
      perStep.set(at, s);
    }
  };
  return {
    push(channels: Float32Array[]) {
      const x = mono(channels);
      for (let i = 0; i < x.length; i++) {
        ring[filled++] = x[i] as number;
        total += 1;
        if (filled === N) {
          analyse();
          ring.copyWithin(0, KEY_HOP, N);
          filled = N - KEY_HOP;
        }
      }
    },
    finish(): KeyFacts {
      const notes = normalise(whole) ?? new Array(12).fill(0);
      const out: KeyFacts = {
        scores: keyScores(whole),
        notes: Object.fromEntries(NOTE_NAMES.map((n, i) => [n, notes[i] as number])),
      };
      if (step) {
        const count = Math.ceil(total / rate / step - 1e-9);
        out.steps = {
          start: r3(start),
          step,
          notes: Array.from({ length: count }, (_, i) => {
            const s = perStep.get(i);
            return s ? normalise(s) : null;
          }),
        };
      }
      return out;
    },
  };
}

/** Key scores and note strengths of a file's sound over a range, with `step` per step too. */
export async function measureKey(
  file: string,
  options: Range & { step?: number; signal?: AbortSignal },
): Promise<KeyFacts> {
  const meter = keyMeter(KEY_RATE, options.from ?? 0, options.step);
  await streamSound(file, { ...options, rate: KEY_RATE }, (block) => meter.push(block));
  return meter.finish();
}

// ---------------------------------------------------------------------------------------------
// Notes: a YIN pitch line split into notes

/** The notes' pitch line: YIN on 16 kHz, a 40 ms window every 10 ms, from 40 Hz to 2,000 Hz. */
export const NOTES_RATE = 16_000;
const YIN_WINDOW = 640;
const YIN_HOP = 160;
const YIN_MIN_HZ = 40;
const YIN_MAX_HZ = 2000;
const YIN_THRESHOLD = 0.15;
/** The pitch line is the median of 5 hops (50 ms), so a single wrong hop splits no note. */
const SMOOTH_HOPS = 5;
export const NOTES_METHOD = 'yin-40-2000hz-median-50ms';

/** Pitch (Hz, or null where none is clear) and mean square of every 10 ms hop. */
export async function pitchLine(
  x: Float32Array,
  signal?: AbortSignal,
): Promise<{ pitch: Array<number | null>; meanSquares: Float64Array }> {
  const tauMax = Math.floor(NOTES_RATE / YIN_MIN_HZ);
  const tauMin = Math.ceil(NOTES_RATE / YIN_MAX_HZ);
  const L = YIN_WINDOW + tauMax;
  let N = 1;
  while (N < L + YIN_WINDOW) N <<= 1;
  const hops = Math.max(0, Math.floor(x.length / YIN_HOP));
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = (sq[i] as number) + (x[i] as number) ** 2;
  const energy = (from: number, n: number) =>
    (sq[Math.min(x.length, from + n)] as number) - (sq[Math.min(x.length, from)] as number);
  const aRe = new Float64Array(N);
  const aIm = new Float64Array(N);
  const bRe = new Float64Array(N);
  const bIm = new Float64Array(N);
  const diff = new Float64Array(tauMax + 2);
  const pitch: Array<number | null> = new Array(hops).fill(null);
  const meanSquares = new Float64Array(hops);
  for (let h = 0; h < hops; h++) {
    if (h % 2000 === 0) {
      if (signal?.aborted) throw new CfError('cancelled', 'Cancelled');
      await new Promise((r) => setImmediate(r));
    }
    const s = h * YIN_HOP;
    meanSquares[h] = energy(s, YIN_HOP) / Math.max(1, Math.min(YIN_HOP, x.length - s));
    if (s + L > x.length) continue;
    const e0 = energy(s, YIN_WINDOW);
    if (e0 <= 0) continue;
    // r(τ) = Σ x[s+j]·x[s+j+τ] for j < W, for every τ at once, as a cross-correlation by FFT.
    for (let i = 0; i < N; i++) {
      aRe[i] = i < L ? (x[s + i] as number) : 0;
      aIm[i] = 0;
      bRe[i] = i < YIN_WINDOW ? (x[s + i] as number) : 0;
      bIm[i] = 0;
    }
    fft(aRe, aIm);
    fft(bRe, bIm);
    for (let i = 0; i < N; i++) {
      const re = (aRe[i] as number) * (bRe[i] as number) + (aIm[i] as number) * (bIm[i] as number);
      const im = (aIm[i] as number) * (bRe[i] as number) - (aRe[i] as number) * (bIm[i] as number);
      aRe[i] = re;
      aIm[i] = im;
    }
    fft(aRe, aIm, true);
    diff[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      const d = Math.max(0, e0 + energy(s + tau, YIN_WINDOW) - 2 * (aRe[tau] as number));
      running += d;
      diff[tau] = running > 0 ? (d * tau) / running : 1;
    }
    let tau = tauMin;
    for (; tau <= tauMax; tau++) {
      if ((diff[tau] as number) < YIN_THRESHOLD) {
        while (tau + 1 <= tauMax && (diff[tau + 1] as number) < (diff[tau] as number)) tau++;
        break;
      }
    }
    if (tau > tauMax) continue;
    const a = diff[tau - 1] ?? (diff[tau] as number);
    const b = diff[tau] as number;
    const c = tau + 1 <= tauMax ? (diff[tau + 1] as number) : b;
    const den = a - 2 * b + c;
    const shift = den ? (0.5 * (a - c)) / den : 0;
    pitch[h] = NOTES_RATE / (tau + Math.max(-1, Math.min(1, shift)));
  }
  return { pitch, meanSquares };
}

export interface Note {
  start: number;
  end: number;
  /** Median pitch over the note, Hz. */
  hz: number;
  /** The nearest note name in equal temperament with A4 = 440 Hz (C4 is middle C). */
  note: string;
  /** Cents from that note, -50 to 50. */
  cents: number;
  /** RMS dBFS over the note. */
  level_db: number | null;
  start_beats?: number;
  length_beats?: number;
}

/** The nearest note name to a pitch and the cents off it. */
export function noteName(hz: number): { note: string; cents: number } {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const n = Math.round(midi);
  return {
    note: `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`,
    cents: Math.round((midi - n) * 100),
  };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

export interface NoteRules {
  /** A new note starts where the pitch moves this many cents from the note's mean so far. */
  splitCents: number;
  /** Notes shorter than this are left out. */
  minSeconds: number;
  /** With `step`: a new note also starts where the level rises by this much over the step before. */
  thresholdDb?: number;
  step?: number;
  /** With a tempo: each note in beats too, counted from firstBarSeconds. */
  tempo?: number;
  firstBarSeconds?: number;
}

/** The notes of a single line in mono 16 kHz samples, `from` being the first sample's time. */
export async function notesOf(
  x: Float32Array,
  from: number,
  rules: NoteRules,
  signal?: AbortSignal,
): Promise<Note[]> {
  const { pitch, meanSquares } = await pitchLine(x, signal);
  const hops = pitch.length;
  const hopSeconds = YIN_HOP / NOTES_RATE;
  // A hop's pitch is read over the 40 ms window it starts: it stands for the window's middle.
  const centre = YIN_WINDOW / 2 / NOTES_RATE;
  const last = from + x.length / NOTES_RATE;
  // The pitch line: per hop, the median of the voiced hops among the 5 around it (in cents),
  // voiced when most of them are.
  const line: Array<number | null> = new Array(hops).fill(null);
  const half = SMOOTH_HOPS >> 1;
  for (let h = 0; h < hops; h++) {
    const near: number[] = [];
    for (let k = h - half; k <= h + half; k++) {
      const p = pitch[k];
      if (p !== null && p !== undefined) near.push(1200 * Math.log2(p / 440));
    }
    if (near.length * 2 > Math.min(hops, h + half + 1) - Math.max(0, h - half))
      line[h] = median(near);
  }
  // Hops where a level step that rose by thresholdDb starts.
  const struck = new Set<number>();
  if (rules.thresholdDb !== undefined && rules.step) {
    const meter = stepMeter(NOTES_RATE, rules.step, from);
    meter.push([x]);
    for (const o of onsetsOf(meter.finish(), rules.thresholdDb)) {
      if (o.rise_db !== null) {
        struck.add(Math.max(0, Math.round(((o.time - from - centre) * NOTES_RATE) / YIN_HOP)));
      }
    }
  }
  const notes: Note[] = [];
  let cur: { first: number; last: number; cents: number[]; sum: number } | null = null;
  const close = () => {
    if (!cur) return;
    const seconds = (cur.last - cur.first + 1) * hopSeconds;
    if (seconds + 1e-9 >= rules.minSeconds) {
      const hz = 440 * 2 ** (median(cur.cents) / 1200);
      let ms = 0;
      for (let h = cur.first; h <= cur.last; h++) ms += meanSquares[h] as number;
      const start = from + cur.first * hopSeconds + (cur.first ? centre : 0);
      const end = Math.min(last, from + (cur.last + 1) * hopSeconds + centre);
      const beats =
        rules.tempo !== undefined
          ? {
              start_beats: r3(((start - (rules.firstBarSeconds ?? 0)) * rules.tempo) / 60),
              length_beats: r3(((end - start) * rules.tempo) / 60),
            }
          : {};
      notes.push({
        start: r3(start),
        end: r3(end),
        hz: r2(hz),
        ...noteName(hz),
        level_db: dbOf(ms / (cur.last - cur.first + 1)),
        ...beats,
      });
    }
    cur = null;
  };
  for (let h = 0; h < hops; h++) {
    const c = line[h];
    if (c === null || c === undefined) {
      close();
      continue;
    }
    if (cur) {
      const mean = cur.sum / cur.cents.length;
      if (!struck.has(h) && Math.abs(c - mean) < rules.splitCents) {
        cur.last = h;
        cur.cents.push(c);
        cur.sum += c;
        continue;
      }
      close();
    }
    cur = { first: h, last: h, cents: [c], sum: c };
  }
  close();
  return notes;
}

/** The notes of a single line in a file's sound over a range (mixed to one channel). */
export async function findNotes(
  file: string,
  options: Range & { rules: NoteRules; signal?: AbortSignal },
): Promise<Note[]> {
  const blocks: Float32Array[] = [];
  const { frames } = await streamSound(file, { ...options, rate: NOTES_RATE }, (block) => {
    blocks.push(mono(block));
  });
  const x = new Float32Array(frames);
  let at = 0;
  for (const b of blocks) {
    x.set(b, at);
    at += b.length;
  }
  return notesOf(x, options.from ?? 0, options.rules, options.signal);
}
