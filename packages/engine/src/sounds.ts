import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfError, SOUND_LABELS, type Stem } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';

// Sounds: what can be heard and when, on the CPU, with no provider. Three models, exported to
// ONNX in the image (tools/sounds) and run by sounds-worker.ts in a process of its own:
//   PretrainedSED frame_mn10 (MIT; arXiv 2409.09546): the 447 AudioSet-strong sounds, per 40 ms.
//   FlexSED (MIT; arXiv 2509.18606) with the CLAP text encoder (Apache-2.0): a sound described
//     in words, per 40 ms.
//   Demucs v4 htdemucs (MIT): drums, bass, other and vocals as separate audio.
// What counts as present (the cut-off) is always the caller's.

const MODELS = process.env.CUTTINGFLOOR_SOUND_MODELS ?? '/usr/share/cuttingfloor/models';
const WORKER = fileURLToPath(new URL('./sounds-worker.ts', import.meta.url));

/** Model names kept in results and recipes, so a model change shows and makes new media. */
export const SOUND_MODELS = {
  sounds: 'pretrainedsed-frame_mn10-strong-1aa47e48',
  listen: 'flexsed-eefe52b7',
  stems: 'htdemucs-8726e21a',
} as const;

/** Frames a second the detectors give (40 ms each). */
export const SOUND_RATE = 25;

/** Probabilities per 40 ms frame, frame-major, as bytes (probability × 255). */
export interface FrameScores {
  /** What each column is: sound labels, or the caller's query names. */
  columns: string[];
  frames: number;
  data: Uint8Array;
  /** Seconds of frame 0, on the clock of what was listened to (media or timeline). */
  start: number;
}

/** A stretch where one column stays at or above the cut-off. */
export interface SoundSpan {
  start: number;
  end: number;
  peak_seconds: number;
  peak_probability: number;
}

/** The words FlexSED was trained on: "The sound of <words>", first letter capitalised. */
export function listenText(words: string): string {
  const t = words.trim().replaceAll('_', ' ');
  return `The sound of ${t.charAt(0).toUpperCase()}${t.slice(1).toLowerCase()}`;
}

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

/** The probability of `column` at `frame`. */
export function scoreAt(scores: FrameScores, column: number, frame: number): number {
  return (scores.data[frame * scores.columns.length + column] ?? 0) / 255;
}

/** The highest probability a column reaches. */
export function peakOf(scores: FrameScores, column: number): number {
  let best = 0;
  for (let f = 0; f < scores.frames; f++) best = Math.max(best, scoreAt(scores, column, f));
  return best;
}

/** Runs of consecutive frames at or above `min`, each with its loudest frame. */
export function soundSpans(scores: FrameScores, column: number, min: number): SoundSpan[] {
  const spans: SoundSpan[] = [];
  const step = 1 / SOUND_RATE;
  let open: { from: number; to: number; peak: number; at: number } | null = null;
  const close = () => {
    if (!open) return;
    spans.push({
      start: round(scores.start + open.from * step),
      end: round(scores.start + (open.to + 1) * step),
      peak_seconds: round(scores.start + (open.at + 0.5) * step),
      peak_probability: round(open.peak, 2),
    });
    open = null;
  };
  for (let f = 0; f < scores.frames; f++) {
    const p = scoreAt(scores, column, f);
    if (p < min) {
      close();
      continue;
    }
    if (!open) open = { from: f, to: f, peak: p, at: f };
    open.to = f;
    if (p > open.peak) {
      open.peak = p;
      open.at = f;
    }
  }
  close();
  return spans;
}

/**
 * A column's probabilities every `step` seconds (a whole number of frames), each the highest in
 * its step so nothing short is missed, to two places.
 */
export function scoreSeries(scores: FrameScores, column: number, step: number): number[] {
  const per = Math.max(1, Math.round(step * SOUND_RATE));
  const out: number[] = [];
  for (let f = 0; f < scores.frames; f += per) {
    let best = 0;
    for (let g = f; g < Math.min(scores.frames, f + per); g++) {
      best = Math.max(best, scoreAt(scores, column, g));
    }
    out.push(round(best, 2));
  }
  return out;
}

/** The smallest step (a multiple of 40 ms, at least `wanted`) that keeps values under `budget`. */
export function seriesStep(frames: number, columns: number, budget: number, wanted = 0): number {
  let per = Math.max(1, Math.round(wanted * SOUND_RATE));
  while (Math.ceil(frames / per) * columns > budget) per += 1;
  return round(per / SOUND_RATE);
}

function threads(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

/** FFmpeg decodes the sound to raw float32 at the model's rate and channels. */
async function decode(
  file: string,
  dest: string,
  format: { rate: number; channels: number; from?: number; until?: number },
  signal: AbortSignal,
): Promise<void> {
  await run(
    BIN.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      ...(format.from ? ['-ss', String(format.from)] : []),
      ...(format.until !== undefined ? ['-to', String(format.until)] : []),
      '-i',
      `file:${file}`,
      '-vn',
      '-map',
      '0:a:0',
      '-ac',
      String(format.channels),
      '-ar',
      String(format.rate),
      '-f',
      'f32le',
      '-y',
      dest,
    ],
    { signal, timeoutMs: 60 * 60_000 },
  );
}

async function worker(
  job: Record<string, unknown>,
  signal: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  try {
    await run(process.execPath, [WORKER, JSON.stringify({ threads: threads(), ...job })], {
      heavy: true,
      signal,
      timeoutMs: 4 * 60 * 60_000,
      onLine: (line) => {
        const m = /^progress ([\d.]+)/.exec(line);
        if (m) onProgress?.(Number(m[1]));
      },
    });
  } catch (error) {
    if (error instanceof CfError && error.code === 'engine_error') {
      const stderr = String((error.detail as { stderr?: string } | undefined)?.stderr ?? '');
      if (/ENOENT|no such file|Load model .* failed/i.test(stderr)) {
        throw new CfError('engine_error', 'The sound models are not installed here', {
          hint: 'They ship in the cuttingfloor Docker image; run the server there',
          detail: { stderr },
        });
      }
    }
    throw error;
  }
}

/**
 * Every AudioSet-strong sound's probability per 40 ms, between `from` and `until` (seconds of
 * `file`; default its whole sound).
 */
export async function detectSounds(
  file: string,
  options: {
    from?: number;
    until?: number;
    signal: AbortSignal;
    onProgress?: (fraction: number) => void;
  },
): Promise<FrameScores> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-sounds-'));
  try {
    const raw = join(dir, 'mono.f32');
    await decode(
      file,
      raw,
      {
        rate: 16_000,
        channels: 1,
        ...(options.from ? { from: options.from } : {}),
        ...(options.until !== undefined ? { until: options.until } : {}),
      },
      options.signal,
    );
    options.onProgress?.(0.1);
    const out = join(dir, 'scores.u8');
    await worker(
      { mode: 'sed', model: join(MODELS, 'sounds', 'sed-mn10.onnx'), input: raw, output: out },
      options.signal,
      (f) => options.onProgress?.(0.1 + 0.9 * f),
    );
    const data = new Uint8Array(await readFile(out));
    return {
      columns: [...SOUND_LABELS],
      frames: Math.floor(data.length / SOUND_LABELS.length),
      data,
      start: options.from ?? 0,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Each described sound's probability per 40 ms, between `from` and `until` (media seconds).
 * `queries` maps the caller's names to their words.
 */
export async function listenFor(
  file: string,
  queries: Record<string, string>,
  options: {
    from?: number;
    until?: number;
    signal: AbortSignal;
    onProgress?: (fraction: number) => void;
  },
): Promise<FrameScores> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-listen-'));
  const names = Object.keys(queries);
  try {
    const raw = join(dir, 'mono.f32');
    await decode(
      file,
      raw,
      {
        rate: 16_000,
        channels: 1,
        ...(options.from ? { from: options.from } : {}),
        ...(options.until !== undefined ? { until: options.until } : {}),
      },
      options.signal,
    );
    options.onProgress?.(0.05);
    const out = join(dir, 'scores.u8');
    await worker(
      {
        mode: 'listen',
        model: join(MODELS, 'sounds', 'flexsed.onnx'),
        clapDir: MODELS,
        clapModel: 'Xenova/clap-htsat-unfused',
        texts: names.map((n) => listenText(queries[n] as string)),
        input: raw,
        output: out,
      },
      options.signal,
      (f) => options.onProgress?.(0.05 + 0.95 * f),
    );
    const data = new Uint8Array(await readFile(out));
    return {
      columns: names,
      frames: Math.floor(data.length / names.length),
      data,
      start: options.from ?? 0,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Separates the sound of `file` into the stems asked for, one 32-bit float WAV each. */
export async function splitStems(
  file: string,
  outputs: Partial<Record<Stem, string>>,
  options: { workDir: string; signal: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<void> {
  const raw = join(options.workDir, 'stereo.f32');
  try {
    await decode(file, raw, { rate: 44_100, channels: 2 }, options.signal);
    options.onProgress?.(0.03);
    await worker(
      { mode: 'stems', model: join(MODELS, 'sounds', 'htdemucs.onnx'), input: raw, outputs },
      options.signal,
      (f) => options.onProgress?.(0.03 + 0.97 * f),
    );
  } finally {
    await rm(raw, { force: true });
  }
}
