import { spawn } from 'node:child_process';
import { CfError } from '@cuttingfloor/schema';
import { BIN } from './exec.ts';

// Tempo and beats for media.analyze: an onset envelope from spectral flux, a tempo from its
// autocorrelation (weighted towards 120 BPM), and beat times by dynamic programming (Ellis,
// "Beat tracking by dynamic programming", 2007). All deterministic, all in this process.

const RATE = 22_050;
const FRAME = 1024;
const HOP = 512;
const FPS = RATE / HOP;
const MAX_SECONDS = 30 * 60;

export interface Beats {
  bpm: number;
  /** Beat times in media seconds. */
  beats: number[];
  /** Every fourth beat from the strongest phase: likely bar starts. */
  downbeats: number[];
}

/** Mono samples at 22.05 kHz. */
function decode(file: string, signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-i',
        `file:${file}`,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(RATE),
        '-t',
        String(MAX_SECONDS),
        '-f',
        'f32le',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let err = '';
    ff.stdout.on('data', (d: Buffer) => chunks.push(d));
    ff.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-1000);
    });
    const kill = () => ff.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });
    ff.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(new CfError('cancelled', 'Cancelled'));
      if (code !== 0)
        return reject(
          new CfError('engine_error', 'Could not read the sound', { detail: { stderr: err } }),
        );
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

/** In-place radix-2 FFT on interleaved re/im of length 2n. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * cr - (im[b] as number) * ci;
        const xi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Onset strength per hop: half-wave rectified change in log magnitude, summed over bins. */
export function onsetEnvelope(samples: Float32Array): Float64Array {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const env = new Float64Array(frames);
  const window = new Float64Array(FRAME).map(
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME),
  );
  let prev = new Float64Array(FRAME / 2);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = (samples[f * HOP + i] ?? 0) * (window[i] as number);
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(FRAME / 2);
    let flux = 0;
    for (let k = 0; k < FRAME / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k] as number, im[k] as number));
      const d = (mag[k] as number) - (prev[k] as number);
      if (d > 0) flux += d;
    }
    env[f] = f ? flux : 0;
    prev = mag;
  }
  // Remove the slow trend so steady loudness doesn't read as onsets.
  const out = new Float64Array(frames);
  const half = Math.round(FPS);
  let sum = 0;
  for (let f = 0; f < frames; f++) {
    sum += env[f] as number;
    if (f >= 2 * half) sum -= env[f - 2 * half] as number;
    const mean = sum / Math.min(f + 1, 2 * half);
    out[f] = Math.max(0, (env[f] as number) - mean);
  }
  return out;
}

/** Autocorrelation at a fractional lag, linearly interpolated. */
function correlation(env: Float64Array, lag: number): number {
  let acc = 0;
  for (let f = Math.ceil(lag); f < env.length; f++) {
    const g = f - lag;
    const i = Math.floor(g);
    const t = g - i;
    acc += (env[f] as number) * ((env[i] as number) * (1 - t) + (env[i + 1] ?? 0) * t);
  }
  return acc;
}

/**
 * Tempo in BPM: a comb over the onset envelope's autocorrelation at 1–4 beat periods (sharper
 * than one lag), weighted towards 120 BPM, searched coarsely then refined to 0.1 BPM.
 */
export function estimateTempo(env: Float64Array): number {
  const strength = (bpm: number) => {
    const lag = (60 * FPS) / bpm;
    let comb = 0;
    for (let k = 1; k <= 4; k++) comb += correlation(env, k * lag) / k;
    return comb * Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
  };
  let best = 120;
  let score = -Infinity;
  for (let bpm = 60; bpm <= 200; bpm += 1) {
    const s = strength(bpm);
    if (s > score) {
      score = s;
      best = bpm;
    }
  }
  for (let bpm = best - 1; bpm <= best + 1; bpm += 0.1) {
    const s = strength(bpm);
    if (s > score) {
      score = s;
      best = bpm;
    }
  }
  return Math.round(best * 10) / 10;
}

/** Beat frames by dynamic programming: strong onsets, spaced close to the period. */
export function trackBeats(env: Float64Array, bpm: number): number[] {
  const period = (60 * FPS) / bpm;
  const n = env.length;
  if (!n) return [];
  const std = Math.max(1, period / 32);
  const local = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let k = -Math.ceil(3 * std); k <= Math.ceil(3 * std); k++) {
      s += (env[f + k] ?? 0) * Math.exp(-0.5 * (k / std) ** 2);
    }
    local[f] = s;
  }
  const max = Math.max(...local) || 1;
  for (let f = 0; f < n; f++) local[f] = (local[f] as number) / max;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const tight = 100;
  for (let f = 0; f < n; f++) {
    let best = 0;
    let from = -1;
    for (let p = Math.max(0, Math.round(f - 2 * period)); p <= f - Math.round(period / 2); p++) {
      const s = (score[p] as number) - tight * Math.log((f - p) / period) ** 2;
      if (s > best) {
        best = s;
        from = p;
      }
    }
    score[f] = (local[f] as number) + best;
    back[f] = from;
  }
  // Finish on the best score in the last period, then walk back.
  let end = n - 1;
  for (let f = Math.max(0, n - Math.round(period)); f < n; f++)
    if ((score[f] as number) > (score[end] as number)) end = f;
  const beats: number[] = [];
  for (let f = end; f >= 0; f = back[f] as number) beats.unshift(f);
  return beats;
}

/** Tempo and beats of a media file's sound. */
export async function analyseBeats(file: string, signal?: AbortSignal): Promise<Beats> {
  const samples = await decode(file, signal);
  if (samples.length < FRAME * 4) {
    throw new CfError('bad_request', 'The sound is too short to find a beat in');
  }
  const env = onsetEnvelope(samples);
  const bpm = estimateTempo(env);
  const frames = trackBeats(env, bpm);
  const beats = frames.map((f) => Math.round(((f * HOP + FRAME / 2) / RATE) * 1000) / 1000);
  // Downbeats: the phase (of four) whose beats carry the most onset energy.
  let phase = 0;
  let strongest = -1;
  for (let p = 0; p < 4; p++) {
    const e = frames.filter((_, i) => i % 4 === p).reduce((s, f) => s + (env[f] ?? 0), 0);
    if (e > strongest) {
      strongest = e;
      phase = p;
    }
  }
  return {
    bpm: Math.round(bpm * 10) / 10,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === phase),
  };
}
