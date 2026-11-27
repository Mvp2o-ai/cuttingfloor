import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfError } from '@cuttingfloor/schema';
import { BIN, KILL_SETTLE_MS, killTree, run, spawnEngine } from './exec.ts';
import { drawText, fillRect, type Raster, type Rgb, textHeight, textWidth } from './raster.ts';
import {
  blankPicture,
  COLOURS,
  drawGrid,
  type Grid,
  LOW_PITCH,
  PITCH_ROWS,
  pitchHz,
  type SoundLayout,
  soundLayout,
  yOf,
} from './sound-axes.ts';

// A spectrogram on a pitch scale: a constant-Q transform worked out here, one row per semitone.
// Each row is measured with Blackman-windowed kernels CYCLES periods of its own pitch long, so
// every row has the same resolution relative to its pitch: long windows at the bottom (a bass
// note sits on its own row, at the cost of time detail: 0.9 s at C2) and short ones at the top
// (hi-hats and hiss show as hits: 14 ms at C8). Three kernels per row, a third of a semitone
// apart, and the row keeps the loudest, so a note sung off pitch still fills its nearest row.
// The low rows are measured on the sound filtered and halved in rate octave by octave, which
// keeps the work the same for every octave. A column's level is the mean power of the windows
// inside its time (one window at its centre where the window is longer than the column).
// Levels are dBFS: a full-scale sine on a row reads 0 dB.

/** Sample rate the sound is read at; the top row's kernels need it. */
export const SPECTROGRAM_RATE = 48_000;
/** Periods of a row's pitch in its window. */
export const CYCLES = 60;
const SUBS = [-1 / 3, 0, 1 / 3];
/** Brightness covers this many dB below 0 dBFS; quieter is black. */
export const FLOOR_DB = -90;

/** Seconds of the window a row is measured with. */
export function windowSeconds(pitch: number): number {
  return CYCLES / pitchHz(pitch);
}

/** Mono samples at SPECTROGRAM_RATE of [from, until) seconds of a file (channels mixed). */
export function decodeMono(
  file: string,
  from: number,
  until: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
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
        '-ss',
        String(from),
        '-t',
        String(Math.max(0, until - from)),
        '-i',
        `file:${file}`,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(SPECTROGRAM_RATE),
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
    const kill = () => {
      killTree(ff);
      setTimeout(() => reject(new CfError('cancelled', 'Cancelled')), KILL_SETTLE_MS).unref();
    };
    signal?.addEventListener('abort', kill, { once: true });
    ff.on('error', (e) =>
      reject(new CfError('engine_error', `Could not run ffmpeg: ${e.message}`)),
    );
    ff.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(new CfError('cancelled', 'Cancelled'));
      if (code !== 0)
        return reject(
          new CfError('engine_error', 'Could not read the sound', { detail: { stderr: err } }),
        );
      const buf = Buffer.concat(chunks);
      const out = new Float32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

/** Seconds of sound a picture of [from, until) reads either side, for the bottom row's window. */
export function spectrogramPad(): number {
  return windowSeconds(LOW_PITCH) / 2 + 0.05;
}

// Kaiser-windowed low-pass, cut at a quarter of the input rate, for halving the rate: what is
// kept (up to 0.4 of the new rate) is clean of folded-back sound to about -90 dB.
const HALF_TAPS = 65;
const HALF = halfBandTaps();

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

function halfBandTaps(): Float64Array {
  const beta = 9;
  const n = HALF_TAPS;
  const mid = (n - 1) / 2;
  const h = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 0.5 : Math.sin(Math.PI * 0.5 * x) / (Math.PI * x);
    const w = besselI0(beta * Math.sqrt(1 - (x / mid) ** 2)) / besselI0(beta);
    h[i] = sinc * w;
    sum += h[i] as number;
  }
  for (let i = 0; i < n; i++) h[i] = (h[i] as number) / sum;
  return h;
}

/** The sound low-passed and at half the rate; sample m sits at the time of input sample 2m. */
function halve(x: Float32Array): Float32Array {
  const out = new Float32Array(Math.ceil(x.length / 2));
  const mid = (HALF_TAPS - 1) / 2;
  for (let m = 0; m < out.length; m++) {
    const c = 2 * m - mid;
    let acc = 0;
    const k0 = Math.max(0, -c);
    const k1 = Math.min(HALF_TAPS, x.length - c);
    for (let k = k0; k < k1; k++) acc += (HALF[k] as number) * (x[c + k] as number);
    out[m] = acc;
  }
  return out;
}

interface RowKernel {
  level: number;
  length: number;
  /** Window sum, for amplitude. */
  norm: number;
  cos: Float64Array[];
  sin: Float64Array[];
}

function rowKernel(pitch: number): RowKernel {
  const f = pitchHz(pitch);
  // The rate a row is measured at: halved while the kernels' highest reach stays under 0.38 of it.
  const reach = pitchHz(pitch + 1 / 3) * (1 + 3 / CYCLES);
  let level = 0;
  while (0.38 * (SPECTROGRAM_RATE / 2 ** (level + 1)) >= reach) level++;
  const rate = SPECTROGRAM_RATE / 2 ** level;
  const length = Math.max(8, Math.round((CYCLES * rate) / f));
  const w = new Float64Array(length);
  let norm = 0;
  for (let n = 0; n < length; n++) {
    const a = (2 * Math.PI * n) / (length - 1);
    w[n] = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
    norm += w[n] as number;
  }
  const cos: Float64Array[] = [];
  const sin: Float64Array[] = [];
  for (const sub of SUBS) {
    const fs = pitchHz(pitch + sub);
    const c = new Float64Array(length);
    const s = new Float64Array(length);
    for (let n = 0; n < length; n++) {
      const ph = (2 * Math.PI * fs * n) / rate;
      c[n] = (w[n] as number) * Math.cos(ph);
      s[n] = (w[n] as number) * Math.sin(ph);
    }
    cos.push(c);
    sin.push(s);
  }
  return { level, length, norm, cos, sin };
}

let kernels: RowKernel[] | undefined;

/**
 * The level in dBFS of every pitch row (C1 to B9) in each of `columns` equal slices of
 * [from, until) seconds. `samples` are mono at SPECTROGRAM_RATE, the first at `start` seconds;
 * sound outside them counts as silence. Row 0 is C1. Returns rows × columns, row-major.
 */
export function pitchLevels(
  samples: Float32Array,
  start: number,
  from: number,
  until: number,
  columns: number,
): Float32Array {
  kernels ??= Array.from({ length: PITCH_ROWS }, (_, r) => rowKernel(LOW_PITCH + r));
  const levels: Float32Array[] = [samples];
  const deepest = Math.max(...kernels.map((k) => k.level));
  for (let j = 1; j <= deepest; j++) levels.push(halve(levels[j - 1] as Float32Array));
  const out = new Float32Array(PITCH_ROWS * columns);
  const dt = (until - from) / columns;
  const power = new Float64Array(SUBS.length);
  for (let r = 0; r < PITCH_ROWS; r++) {
    const k = kernels[r] as RowKernel;
    const x = levels[k.level] as Float32Array;
    const rate = SPECTROGRAM_RATE / 2 ** k.level;
    const win = k.length / rate;
    const per = win / 3 >= dt ? 1 : Math.ceil(dt / (win / 3));
    const scale = 2 / k.norm;
    for (let c = 0; c < columns; c++) {
      power.fill(0);
      for (let i = 0; i < per; i++) {
        const t = from + c * dt + ((i + 0.5) * dt) / per;
        const n0 = Math.round((t - start) * rate - (k.length - 1) / 2);
        const a = Math.max(0, -n0);
        const b = Math.min(k.length, x.length - n0);
        for (let s = 0; s < SUBS.length; s++) {
          const kc = k.cos[s] as Float64Array;
          const ks = k.sin[s] as Float64Array;
          let re = 0;
          let im = 0;
          for (let n = a; n < b; n++) {
            const v = x[n0 + n] as number;
            re += v * (kc[n] as number);
            im += v * (ks[n] as number);
          }
          power[s] = (power[s] as number) + (re * re + im * im) * scale * scale;
        }
      }
      let best = 0;
      for (let s = 0; s < SUBS.length; s++) best = Math.max(best, (power[s] as number) / per);
      out[r * columns + c] = 10 * Math.log10(best + 1e-30);
    }
  }
  return out;
}

// Brightness: matplotlib's inferno (black, purple, red, orange, pale yellow), perceptually even.
const INFERNO: Rgb[] = [
  [0, 0, 4],
  [22, 11, 57],
  [66, 10, 104],
  [106, 23, 110],
  [147, 38, 103],
  [188, 55, 84],
  [221, 81, 58],
  [243, 120, 25],
  [252, 165, 10],
  [246, 215, 70],
  [252, 255, 164],
];

/** The colour of a level in dBFS. */
export function levelColour(db: number): Rgb {
  const v = Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB)) * (INFERNO.length - 1);
  const i = Math.min(INFERNO.length - 2, Math.floor(v));
  const f = v - i;
  const a = INFERNO[i] as Rgb;
  const b = INFERNO[i + 1] as Rgb;
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

const LOOKUP = Array.from({ length: 1001 }, (_, i) => {
  const db = FLOOR_DB + (i / 1000) * -FLOOR_DB;
  return { db, c: levelColour(db) };
});

/** The level a spectrogram colour stands for (the nearest on the scale): for reading a picture back. */
export function colourLevel(c: Rgb): number {
  let best = LOOKUP[0] as { db: number; c: Rgb };
  let dist = Number.POSITIVE_INFINITY;
  for (const e of LOOKUP) {
    const d = (e.c[0] - c[0]) ** 2 + (e.c[1] - c[1]) ** 2 + (e.c[2] - c[2]) ** 2;
    if (d < dist) {
      dist = d;
      best = e;
    }
  }
  return best.db;
}

export interface Spectrogram {
  image: Raster;
  layout: SoundLayout;
  /** Where each bar line was drawn. */
  bars: Array<{ bar: number; seconds: number; x: number }>;
  /** Beat lines drawn (none when closer than 4 pixels). */
  beatLines: number;
  /** The loudest level in the picture, dBFS. */
  peakDb: number;
}

/**
 * Draws a spectrogram of [from, until) seconds `longEdge` pixels wide: `samples` are mono at
 * SPECTROGRAM_RATE starting at `start` seconds (read spectrogramPad() either side of the range
 * for the bottom rows). With a grid, bar and beat lines.
 */
export function drawSpectrogram(
  samples: Float32Array,
  start: number,
  options: { from: number; until: number; longEdge: number; grid?: Grid | null },
): Spectrogram {
  const l = soundLayout(options.longEdge, options.from, options.until);
  const columns = l.plotWidth;
  const db = pitchLevels(samples, start, options.from, options.until, columns);
  const img = blankPicture(l, () => INFERNO[0] as Rgb);
  let peakDb = Number.NEGATIVE_INFINITY;
  for (let r = 0; r < PITCH_ROWS; r++) {
    const y = yOf(l, LOW_PITCH + r);
    for (let c = 0; c < columns; c++) {
      const v = db[r * columns + c] as number;
      if (v > peakDb) peakDb = v;
      fillRect(img, l.left + c, y, 1, l.rowPx, levelColour(v));
    }
  }
  const { bars, beatLines } = drawGrid(img, l, options.grid ?? null);
  drawLevelKey(img, l);
  return { image: img, layout: l, bars, beatLines, peakDb };
}

/** The brightness key along the bottom: the colour scale from FLOOR_DB to 0 dBFS. */
function drawLevelKey(img: Raster, l: SoundLayout): void {
  const s = l.scale;
  const th = textHeight(s);
  const y = l.keyTop + 2 * s;
  let x = l.left;
  const lead = `${FLOOR_DB} dB`;
  drawText(img, x, y, lead, COLOURS.dim, s);
  x += textWidth(lead, s) + 4 * s;
  const w = Math.min(Math.round(l.plotWidth * 0.3), 360 * s);
  for (let i = 0; i < w; i++)
    fillRect(img, x + i, y, 1, th, levelColour(FLOOR_DB + (i / (w - 1)) * -FLOOR_DB));
  x += w + 4 * s;
  drawText(img, x, y, '0 dBFS (a full-scale sine)', COLOURS.dim, s);
}

const WORKER = fileURLToPath(new URL('./spectrogram-worker.ts', import.meta.url));

/** What the worker reports besides the picture. */
export interface SpectrogramSummary {
  width: number;
  height: number;
  layout: SoundLayout;
  bars: Array<{ bar: number; seconds: number; x: number }>;
  beatLines: number;
  peakDb: number | null;
}

/**
 * A spectrogram of [from, until) seconds of a file as a PNG, made in a process of its own (the
 * transform is seconds of arithmetic, kept off the server's thread). `start` is the time of the
 * file's first sample: 0 for media, the range's padded start for a rendered excerpt.
 */
export async function renderSpectrogram(
  file: string,
  options: { start: number; from: number; until: number; longEdge: number; grid: Grid | null },
  signal?: AbortSignal,
): Promise<{ png: Buffer } & SpectrogramSummary> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-spectrogram-'));
  try {
    const out = join(dir, 'spectrogram.png');
    const { stdout } = await run(
      process.execPath,
      [WORKER, JSON.stringify({ file, ...options }), out],
      {
        heavy: true,
        timeoutMs: 5 * 60_000,
        ...(signal ? { signal } : {}),
      },
    );
    const summary = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as SpectrogramSummary;
    return { png: await readFile(out), ...summary };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
