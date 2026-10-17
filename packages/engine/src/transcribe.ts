import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CfError } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';
import { download } from './fetch.ts';

// Local transcription with whisper.cpp (CPU). Models download on first use into the models
// folder and are checked against pinned SHA-256s before they are used.

export const WHISPER_MODELS = {
  tiny: {
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    bytes: 77_691_713,
  },
  base: {
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    bytes: 147_951_465,
  },
  small: {
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    bytes: 487_601_967,
  },
} as const;
export type WhisperModel = keyof typeof WHISPER_MODELS;

const MODEL_URL = (name: string) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;

export interface TranscriptWord {
  text: string;
  /** Seconds in the media. */
  start: number;
  end: number;
  /** 0–1. */
  confidence: number;
}

export interface Transcript {
  model: WhisperModel;
  language: string;
  text: string;
  words: TranscriptWord[];
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Downloads under way, and everyone waiting on each: they all hear its progress. */
const fetching = new Map<string, { work: Promise<string>; listeners: Set<(f: number) => void> }>();

/** The model file, downloading and checking it the first time it is needed. */
export function ensureModel(
  name: WhisperModel,
  dir: string,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<string> {
  const file = join(dir, `ggml-${name}.bin`);
  const listen = options.onProgress;
  const pending = fetching.get(file);
  if (pending) {
    if (listen) pending.listeners.add(listen);
    return pending.work.finally(() => listen && pending.listeners.delete(listen));
  }
  const listeners = new Set<(f: number) => void>(listen ? [listen] : []);
  const work = (async () => {
    const spec = WHISPER_MODELS[name];
    try {
      if ((await stat(file)).size === spec.bytes) return file;
    } catch {
      // not downloaded yet
    }
    await mkdir(dir, { recursive: true });
    const part = `${file}.part`;
    await download(MODEL_URL(name), part, {
      maxBytes: spec.bytes + 1024,
      timeoutMs: 30 * 60_000,
      allowPrivate: false,
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (bytes) => {
        for (const l of listeners) l(Math.min(1, bytes / spec.bytes));
      },
    });
    const digest = await sha256File(part);
    if (digest !== spec.sha256) {
      await rm(part, { force: true });
      throw new CfError('engine_error', `The ${name} transcription model failed its checksum`, {
        hint: 'Try again; if it keeps failing the download is being altered on the way',
      });
    }
    await rename(part, file);
    return file;
  })();
  fetching.set(file, { work, listeners });
  return work.finally(() => fetching.delete(file));
}

/** Transcribes a media file's sound with word timings. */
export async function transcribe(
  file: string,
  options: {
    model: WhisperModel;
    modelsDir: string;
    language?: string;
    signal?: AbortSignal;
    onProgress?: (fraction: number, message: string) => void;
  },
): Promise<Transcript> {
  const model = await ensureModel(options.model, options.modelsDir, {
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: (f) => options.onProgress?.(0.4 * f, `downloading the ${options.model} model`),
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-whisper-'));
  try {
    options.onProgress?.(0.4, 'extracting sound');
    await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-protocol_whitelist',
        'file',
        '-i',
        `file:${file}`,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-y',
        'speech.wav',
      ],
      { cwd: dir, timeoutMs: 30 * 60_000, ...(options.signal ? { signal: options.signal } : {}) },
    );
    options.onProgress?.(0.45, 'transcribing');
    await run(
      BIN.whisper,
      [
        '-m',
        model,
        '-f',
        'speech.wav',
        '-l',
        options.language ?? 'auto',
        '-ml',
        '1',
        '-sow',
        '-ojf',
        '-of',
        'out',
        '-np',
        '-t',
        String(Math.max(1, Math.min(8, availableParallelism()))),
      ],
      {
        cwd: dir,
        timeoutMs: 6 * 60 * 60_000,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const json = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8')) as {
      result?: { language?: string };
      transcription?: Array<{
        offsets: { from: number; to: number };
        text: string;
        tokens?: Array<{ p?: number; text?: string }>;
      }>;
    };
    const words: TranscriptWord[] = [];
    for (const seg of json.transcription ?? []) {
      const text = seg.text.trim();
      if (!text || /^\[.*\]$/.test(text)) continue;
      const probs = (seg.tokens ?? []).filter((t) => !t.text?.startsWith('[')).map((t) => t.p ?? 0);
      const confidence = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;
      words.push({
        text,
        start: seg.offsets.from / 1000,
        end: seg.offsets.to / 1000,
        confidence: Math.round(confidence * 1000) / 1000,
      });
    }
    return {
      model: options.model,
      language: json.result?.language ?? options.language ?? 'unknown',
      text: words.map((w) => w.text).join(' '),
      words,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
