import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfError } from '@cuttingfloor/schema';
import type { Offset } from './correlate.ts';
import { BIN, run } from './exec.ts';
import type { TranscriptWord } from './transcribe.ts';

// Speech and sound facts: where speech is (Silero VAD), where each transcript word's letters
// sound (wav2vec2 CTC forced alignment), loudness (FFmpeg ebur128 and astats) and the sync
// offset between two sounds (cross-correlation). The models ship in the image; they run in
// sound-worker.ts, a subprocess, on the CPU.

const MODELS = process.env.CUTTINGFLOOR_SPEECH_MODELS ?? '/usr/share/cuttingfloor/models';

/** The model files and the names kept with results, so a model change shows. */
export const SPEECH_MODELS = {
  vad: { file: 'silero-vad-v6.2.3.onnx', name: 'silero-vad-v6.2.3' },
  align: { file: 'wav2vec2-base-960h/model.onnx', name: 'wav2vec2-base-960h' },
} as const;

/** Languages the alignment model knows (English letters only). */
export const ALIGN_LANGUAGES = new Set(['en']);

const WORKER = fileURLToPath(new URL('./sound-worker.ts', import.meta.url));
const INPUT = ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file'];
const LONG_MS = 6 * 60 * 60_000;

export interface Range {
  /** Seconds into the file; absent means its start. */
  from?: number;
  /** Seconds into the file; absent means its end. */
  until?: number;
  /** What the file is, for errors: "media m_…", "b (timeline t_…)". Default "the file". */
  label?: string;
}

/** The typed error for a source or range with no sound to measure, naming which. */
export function noAudio(range: Range, why?: string): CfError {
  const label = range.label ?? 'the file';
  const span =
    range.from !== undefined || range.until !== undefined
      ? ` from ${range.from ?? 0} s to ${range.until ?? 'the end'}`
      : '';
  return new CfError('no_audio', `No sound in ${label}${span}${why ? `: ${why}` : ''}`, {
    hint: span
      ? 'Check the range against the duration (media.get, timeline.get) and that it covers sound'
      : 'Give a source with sound: media.get has_audio, or a timeline with audio clips',
    detail: {
      source: label,
      ...(range.from !== undefined ? { from_seconds: range.from } : {}),
      ...(range.until !== undefined ? { until_seconds: range.until } : {}),
    },
  });
}

/** An engine failure that means the input had no audio stream at all. */
function isNoStream(error: unknown): boolean {
  const tail = String((error as CfError)?.detail?.stderr ?? '');
  return (
    error instanceof CfError &&
    error.code === 'engine_error' &&
    /does not contain any stream|matches no streams|no audio|Output file is empty/i.test(tail)
  );
}

function checkRange(range: Range): void {
  if (range.until !== undefined && range.until <= (range.from ?? 0)) {
    throw noAudio(range, 'the range is empty');
  }
}

interface Common {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

async function modelPath(kind: keyof typeof SPEECH_MODELS): Promise<string> {
  const file = join(MODELS, SPEECH_MODELS[kind].file);
  try {
    await access(file);
  } catch {
    throw new CfError('engine_error', `The ${SPEECH_MODELS[kind].name} model is not installed`, {
      hint: 'It ships in the Docker image; run cuttingfloor there',
    });
  }
  return file;
}

function rangeArgs(range: Range): string[] {
  return [
    ...(range.from ? ['-ss', String(range.from)] : []),
    ...(range.until !== undefined ? ['-to', String(range.until)] : []),
  ];
}

/** The sound of `file` (over a range) as raw mono 32-bit float at `rate`, written into `dir`. */
export async function extractSound(
  file: string,
  dir: string,
  options: Range & { rate: number; name?: string; filter?: string; signal?: AbortSignal },
): Promise<string> {
  checkRange(options);
  const out = join(dir, options.name ?? 'sound.f32');
  try {
    await run(
      BIN.ffmpeg,
      [
        ...INPUT,
        ...rangeArgs(options),
        '-i',
        `file:${file}`,
        '-vn',
        ...(options.filter ? ['-af', options.filter] : []),
        '-ac',
        '1',
        '-ar',
        String(options.rate),
        '-f',
        'f32le',
        '-y',
        `file:${out}`,
      ],
      { timeoutMs: LONG_MS, ...(options.signal ? { signal: options.signal } : {}) },
    );
  } catch (error) {
    if (isNoStream(error)) throw noAudio(options, 'it has no audio stream');
    throw error;
  }
  // FFmpeg succeeds with nothing written when the range starts past the end of the sound.
  const bytes = await stat(out).then(
    (s) => s.size,
    () => 0,
  );
  if (bytes < 4) throw noAudio(options, 'no samples there (past the end, or no audio)');
  return out;
}

async function worker(args: string[], options: Common): Promise<unknown> {
  const { stdout } = await run(process.execPath, [WORKER, ...args], {
    heavy: true,
    timeoutMs: LONG_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    onLine: (line) => {
      const m = /^progress ([\d.]+)/.exec(line);
      if (m) options.onProgress?.(Number(m[1]));
    },
  });
  return JSON.parse(stdout);
}

export interface SpeechProbabilities {
  model: string;
  /** Seconds each probability covers; the first starts at `from`. */
  frame_seconds: number;
  from: number;
  probabilities: number[];
}

/** Silero VAD: the probability of speech every 32 ms, over a range of the file. */
export async function speechProbabilities(
  file: string,
  options: Range & Common = {},
): Promise<SpeechProbabilities> {
  const model = await modelPath('vad');
  const dir = await mkdtemp(join(tmpdir(), 'cf-vad-'));
  try {
    const sound = await extractSound(file, dir, {
      ...options,
      rate: 16_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const out = (await worker(['vad', model, sound], options)) as {
      frame_seconds: number;
      probabilities: number[];
    };
    return { model: SPEECH_MODELS.vad.name, from: options.from ?? 0, ...out };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Spans where the speech probability is at least `min`, in seconds. A span covers whole frames,
 * from the first frame at or above `min` to the end of the last.
 */
export function speechSpans(
  p: Pick<SpeechProbabilities, 'frame_seconds' | 'from' | 'probabilities'>,
  min: number,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const at = (i: number) => Math.round((p.from + i * p.frame_seconds) * 1000) / 1000;
  let open = -1;
  p.probabilities.forEach((v, i) => {
    if (v >= min && open < 0) open = i;
    if (v < min && open >= 0) {
      spans.push({ start: at(open), end: at(i) });
      open = -1;
    }
  });
  if (open >= 0) spans.push({ start: at(open), end: at(p.probabilities.length) });
  return spans;
}

export interface AlignedWord extends TranscriptWord {
  /** 0–1: how clearly the word's letters were heard at start–end; null when not aligned. */
  timing_confidence: number | null;
}

/**
 * Moves each word's start and end to where its letters sound (wav2vec2 CTC forced alignment).
 * Words with no letters to align (digits, symbols) keep their times, fitted between their
 * aligned neighbours. Every time is clamped to [0, duration].
 */
export async function alignTranscriptWords(
  file: string,
  words: TranscriptWord[],
  options: Common & { duration?: number },
): Promise<AlignedWord[]> {
  const model = await modelPath('align');
  const dir = await mkdtemp(join(tmpdir(), 'cf-align-'));
  try {
    const sound = await extractSound(file, dir, {
      rate: 16_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const list = join(dir, 'words.json');
    await writeFile(
      list,
      JSON.stringify(words.map(({ text, start, end }) => ({ text, start, end }))),
    );
    const out = (await worker(['align', model, sound, list], options)) as {
      duration: number;
      words: Array<{ start: number; end: number; score: number } | null>;
    };
    return fitWords(words, out.words, options.duration ?? out.duration);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Aligned times where there are some; the rest fitted between aligned neighbours; clamped. */
export function fitWords(
  words: TranscriptWord[],
  timed: Array<{ start: number; end: number; score: number } | null>,
  duration: number,
): AlignedWord[] {
  const clamp = (t: number) => Math.min(duration, Math.max(0, t));
  const out: AlignedWord[] = words.map((w, i) => {
    const t = timed[i];
    return t
      ? {
          ...w,
          start: clamp(t.start),
          end: clamp(Math.max(t.start, t.end)),
          timing_confidence: t.score,
        }
      : { ...w, start: clamp(w.start), end: clamp(w.end), timing_confidence: null };
  });
  // Unaligned words sit between the words around them, in order.
  for (let i = 0; i < out.length; i++) {
    const w = out[i] as AlignedWord;
    if (w.timing_confidence !== null) continue;
    const lo = i > 0 ? (out[i - 1] as AlignedWord).end : 0;
    let hi = duration;
    for (let k = i + 1; k < out.length; k++) {
      const next = out[k] as AlignedWord;
      if (next.timing_confidence !== null) {
        hi = next.start;
        break;
      }
    }
    const start = Math.min(Math.max(w.start, lo), hi);
    out[i] = { ...w, start, end: Math.min(Math.max(w.end, start), hi) };
  }
  return out;
}

export interface LoudnessFacts {
  /** EBU R128 integrated loudness, LUFS; null below its -70 LUFS gate. */
  integrated_lufs: number | null;
  /** True peak, dBTP; null when silent. */
  true_peak_dbtp: number | null;
  /** EBU R128 loudness range, LU. */
  loudness_range_lu: number | null;
  /** RMS level over the whole stretch, dBFS. */
  rms_dbfs: number | null;
  /** Quietest short window's level, dBFS (astats noise floor): the room or hiss under speech. */
  noise_floor_dbfs: number | null;
}

const num = (s: string | undefined) => {
  const n = Number(s);
  return s !== undefined && Number.isFinite(n) ? n : null;
};

/** Loudness facts of a file's sound over a range. */
export async function measureLoudness(
  file: string,
  options: Range & { signal?: AbortSignal } = {},
): Promise<LoudnessFacts> {
  checkRange(options);
  let stderr: string;
  try {
    ({ stderr } = await run(
      BIN.ffmpeg,
      [
        ...INPUT,
        ...rangeArgs(options),
        '-i',
        `file:${file}`,
        '-vn',
        '-af',
        'ebur128=peak=true:framelog=quiet,astats=measure_perchannel=none:measure_overall=RMS_level+Noise_floor+Number_of_samples',
        '-f',
        'null',
        '-',
      ],
      { timeoutMs: LONG_MS, ...(options.signal ? { signal: options.signal } : {}) },
    ));
  } catch (error) {
    if (isNoStream(error)) throw noAudio(options, 'it has no audio stream');
    throw error;
  }
  const overall = stderr.slice(stderr.lastIndexOf('Overall'));
  const samples = Number(/Number of samples:\s*(\d+)/.exec(overall)?.[1] ?? 0);
  if (!stderr.includes('Overall') || !samples) {
    throw noAudio(options, 'no samples there (past the end, or no audio)');
  }
  return parseLoudness(stderr);
}

/** Reads ebur128's summary and astats' overall lines. */
export function parseLoudness(stderr: string): LoudnessFacts {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const lufs = num(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  const overall = stderr.slice(stderr.lastIndexOf('Overall'));
  const rms = num(/RMS level dB:\s*(-?[\d.]+)/.exec(overall)?.[1]);
  const floor = num(/Noise floor dB:\s*(-?[\d.]+)/.exec(overall)?.[1]);
  return {
    integrated_lufs: lufs !== null && lufs > -70 ? lufs : null,
    true_peak_dbtp: num(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]),
    loudness_range_lu: num(/LRA:\s+(-?[\d.]+) LU/.exec(summary)?.[1]),
    rms_dbfs: rms,
    noise_floor_dbfs: floor,
  };
}

/** Sample rate the offset is measured at: fine enough for a fraction of a frame. */
const OFFSET_RATE = 8000;

/**
 * B's sync offset against A by cross-correlation of their sound (each over its own range),
 * searching up to `maxSeconds` either way.
 */
export async function soundOffset(
  a: { file: string } & Range,
  b: { file: string } & Range,
  options: Common & { maxSeconds: number },
): Promise<Offset> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-offset-'));
  try {
    // Rumble and hiss carry no timing; speech and transients do.
    const filter = 'highpass=f=100,lowpass=f=3500';
    const sig = options.signal ? { signal: options.signal } : {};
    const fa = await extractSound(a.file, dir, {
      ...a,
      rate: OFFSET_RATE,
      name: 'a.f32',
      filter,
      ...sig,
    });
    const fb = await extractSound(b.file, dir, {
      ...b,
      rate: OFFSET_RATE,
      name: 'b.f32',
      filter,
      ...sig,
    });
    const out = (await worker(
      ['offset', fa, fb, String(OFFSET_RATE), String(options.maxSeconds)],
      options,
    )) as Offset | { silent: 'a' | 'b' } | null;
    if (out && 'silent' in out) {
      throw noAudio(out.silent === 'a' ? a : b, 'it is silent (every sample is zero)');
    }
    if (!out) {
      throw new CfError(
        'bad_request',
        `${a.label ?? 'a'} and ${b.label ?? 'b'} can't overlap by half of the shorter sound within ${options.maxSeconds} s`,
        {
          hint: 'Raise max_offset_seconds, or give ranges that cover the same moment in both',
        },
      );
    }
    // Back to each file's own clock: the ranges' starts.
    const shift = (a.from ?? 0) - (b.from ?? 0);
    const r = (x: number) => Math.round(x * 1e4) / 1e4;
    return {
      ...out,
      offset_seconds: r(out.offset_seconds + shift),
      next_best: out.next_best
        ? { ...out.next_best, offset_seconds: r(out.next_best.offset_seconds + shift) }
        : null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
