import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { CfError, VOICES } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';
import { download } from './fetch.ts';
import { sha256File, type Transcript, type TranscriptWord, transcribe } from './transcribe.ts';

// Local voiceover: Kokoro-82M v1.0 (Apache-2.0) through sherpa-onnx's offline TTS (CPU). The
// model downloads once into the models folder, checked against a pinned SHA-256, and unpacks
// there. Word timings come from transcribing the result and aligning it to the text given.

export const KOKORO = {
  name: 'kokoro-multi-lang-v1_0',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2',
  sha256: 'c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298',
  bytes: 349_906_910,
} as const;

export type Voice = (typeof VOICES)[number];

const unpacking = new Map<string, Promise<string>>();

/** The unpacked Kokoro model folder, downloading it the first time. */
export function ensureVoiceModel(
  dir: string,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<string> {
  const target = join(dir, KOKORO.name);
  const pending = unpacking.get(target);
  if (pending) return pending;
  const work = (async () => {
    try {
      await stat(join(target, 'model.onnx'));
      return target;
    } catch {
      // not there yet
    }
    await mkdir(dir, { recursive: true });
    const archive = join(dir, `${KOKORO.name}.tar.bz2.part`);
    await download(KOKORO.url, archive, {
      maxBytes: KOKORO.bytes + 1024,
      timeoutMs: 30 * 60_000,
      allowPrivate: false,
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (bytes) => options.onProgress?.(Math.min(1, bytes / KOKORO.bytes)),
    });
    try {
      if ((await sha256File(archive)) !== KOKORO.sha256) {
        throw new CfError('engine_error', 'The voice model failed its checksum', {
          hint: 'Try again; if it keeps failing the download is being altered on the way',
        });
      }
      const scratch = await mkdtemp(join(dir, '.unpack-'));
      try {
        await run(BIN.tar, ['-xjf', archive, '-C', scratch, '--no-same-owner'], {
          timeoutMs: 10 * 60_000,
        });
        await rename(join(scratch, KOKORO.name), target);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    } finally {
      await rm(archive, { force: true });
    }
    return target;
  })();
  unpacking.set(target, work);
  return work.finally(() => unpacking.delete(target));
}

/** Speaks `text` in a Kokoro voice into `dest` (24 kHz mono WAV). */
export async function speak(
  text: string,
  dest: string,
  options: {
    voice: Voice;
    speed: number;
    modelsDir: string;
    signal?: AbortSignal;
    onProgress?: (fraction: number, message: string) => void;
  },
): Promise<void> {
  const sid = VOICES.indexOf(options.voice);
  if (sid < 0) throw new CfError('bad_request', `No voice ${options.voice}`);
  const model = await ensureVoiceModel(options.modelsDir, {
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: (f) => options.onProgress?.(0.5 * f, 'downloading the voice model'),
  });
  options.onProgress?.(0.5, 'speaking');
  // One argument, never read as an option.
  const said = text.replace(/\s+/g, ' ').trim();
  await run(
    BIN.tts,
    [
      `--num-threads=${Math.max(1, Math.min(4, availableParallelism()))}`,
      `--kokoro-model=${join(model, 'model.onnx')}`,
      `--kokoro-voices=${join(model, 'voices.bin')}`,
      `--kokoro-tokens=${join(model, 'tokens.txt')}`,
      `--kokoro-data-dir=${join(model, 'espeak-ng-data')}`,
      `--kokoro-lexicon=${join(model, options.voice.startsWith('b') ? 'lexicon-gb-en.txt' : 'lexicon-us-en.txt')}`,
      `--sid=${sid}`,
      `--speed=${options.speed}`,
      `--output-filename=${dest}`,
      said.startsWith('-') ? ` ${said}` : said,
    ],
    {
      timeoutMs: 30 * 60_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The words of `text` with times from a transcript of it being spoken: an edit-distance
 * alignment of the two word lists, so the result keeps the text exactly as given; words the
 * transcript missed share the time between their neighbours.
 */
export function alignWords(text: string, heard: TranscriptWord[]): TranscriptWord[] {
  const words = text.split(/\s+/).filter((w) => norm(w));
  const n = words.length;
  const m = heard.length;
  if (!n) return [];
  // cost[i][j]: aligning the first i words with the first j heard ones.
  const cost = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Uint32Array(m + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= m; j++) (cost[0] as Uint32Array)[j] = j;
  for (let i = 1; i <= n; i++) {
    const row = cost[i] as Uint32Array;
    const prev = cost[i - 1] as Uint32Array;
    const a = norm(words[i - 1] as string);
    for (let j = 1; j <= m; j++) {
      const same = a === norm((heard[j - 1] as TranscriptWord).text) ? 0 : 1;
      row[j] = Math.min(
        (prev[j - 1] as number) + same,
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
      );
    }
  }
  const match: Array<TranscriptWord | undefined> = new Array(n);
  for (let i = n, j = m; i > 0; ) {
    const here = (cost[i] as Uint32Array)[j] as number;
    if (j > 0) {
      const same = norm(words[i - 1] as string) === norm((heard[j - 1] as TranscriptWord).text);
      if (here === ((cost[i - 1] as Uint32Array)[j - 1] as number) + (same ? 0 : 1)) {
        match[i - 1] = heard[j - 1];
        i -= 1;
        j -= 1;
        continue;
      }
      if (here === ((cost[i] as Uint32Array)[j - 1] as number) + 1) {
        j -= 1;
        continue;
      }
    }
    i -= 1;
  }
  const out: TranscriptWord[] = words.map((w, i) => {
    const h = match[i];
    return h
      ? { text: w, start: h.start, end: h.end, confidence: h.confidence }
      : { text: w, start: Number.NaN, end: Number.NaN, confidence: 0 };
  });
  // Unheard runs share the gap between the heard words around them.
  const total = heard.length ? (heard[heard.length - 1] as TranscriptWord).end : 0;
  for (let i = 0; i < n; ) {
    if (!Number.isNaN((out[i] as TranscriptWord).start)) {
      i += 1;
      continue;
    }
    let k = i;
    while (k < n && Number.isNaN((out[k] as TranscriptWord).start)) k += 1;
    const from = i > 0 ? (out[i - 1] as TranscriptWord).end : 0;
    const to = k < n ? (out[k] as TranscriptWord).start : Math.max(total, from);
    const step = (to - from) / (k - i);
    for (let x = i; x < k; x++) {
      const w = out[x] as TranscriptWord;
      w.start = Math.round((from + step * (x - i)) * 1000) / 1000;
      w.end = Math.round((from + step * (x - i + 1)) * 1000) / 1000;
    }
    i = k;
  }
  return out;
}

/** Word timings for spoken `text` in `file`, via whisper. */
export async function voiceWords(
  file: string,
  text: string,
  options: {
    modelsDir: string;
    signal?: AbortSignal;
    onProgress?: (fraction: number, message: string) => void;
  },
): Promise<Transcript> {
  // The text is known, so the smallest model is enough to place it.
  const heard = await transcribe(file, {
    model: 'tiny',
    modelsDir: options.modelsDir,
    language: 'en',
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  const words = alignWords(text, heard.words);
  return { model: 'tiny', language: 'en', text: words.map((w) => w.text).join(' '), words };
}
