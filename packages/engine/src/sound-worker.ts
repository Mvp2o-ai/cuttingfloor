// Sound measures, run in a subprocess of their own (speech.ts starts it) so a model's memory
// and threads never sit in the server and a cancel can kill it. ONNX Runtime on the CPU.
//
//   node sound-worker.ts vad <silero.onnx> <sound.f32>
//     → {"frame_seconds":0.032,"probabilities":[...]}   Silero VAD speech probability per 32 ms
//   node sound-worker.ts align <wav2vec2.onnx> <sound.f32> <words.json>
//     → {"words":[{"start","end","score"} | null, ...]}  each word's edges, or null if not timed
//   node sound-worker.ts offset <a.f32> <b.f32> <rate> <max_offset_seconds>
//     → {"offset_seconds","strength","next_best":{...}|null}  b's offset against a
//
// Sound is raw 32-bit float, mono, 16 kHz (offset: at <rate>). Progress goes to stderr as
// "progress <0–1>".

import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import * as ort from 'onnxruntime-node';
import { crossCorrelate } from './correlate.ts';
import {
  alignGroups,
  FRAME_SECONDS,
  forcedAlign,
  logSoftmax,
  type TimedWord,
  wordTokens,
} from './ctc.ts';

const RATE = 16_000;

function readSound(file: string): Float32Array {
  const buf = readFileSync(file);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

const progress = (f: number) => process.stderr.write(`progress ${f.toFixed(3)}\n`);

/** Silero VAD v6: 512-sample windows with the previous 64 samples as context. */
async function vad(model: string, sound: Float32Array) {
  const session = await ort.InferenceSession.create(model, {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  const WINDOW = 512;
  const CONTEXT = 64;
  let state: ort.Tensor = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
  const input = new Float32Array(CONTEXT + WINDOW);
  const probabilities: number[] = [];
  const count = Math.ceil(sound.length / WINDOW);
  for (let i = 0; i < count; i++) {
    input.copyWithin(0, WINDOW, WINDOW + CONTEXT);
    input.fill(0, CONTEXT);
    input.set(sound.subarray(i * WINDOW, (i + 1) * WINDOW), CONTEXT);
    const out = await session.run({
      input: new ort.Tensor('float32', input.slice(), [1, CONTEXT + WINDOW]),
      state,
      sr,
    });
    probabilities.push(Math.round(((out.output as ort.Tensor).data[0] as number) * 1000) / 1000);
    state = out.stateN as ort.Tensor;
    if (i % 2000 === 0) progress(i / count);
  }
  return { frame_seconds: WINDOW / RATE, probabilities };
}

/** wav2vec2 CTC emissions over a stretch of sound, as log-probabilities per 20 ms frame. */
async function emissions(session: ort.InferenceSession, sound: Float32Array) {
  // The feature extractor's normalisation: zero mean, unit variance.
  let mean = 0;
  for (const v of sound) mean += v;
  mean /= sound.length || 1;
  let variance = 0;
  for (const v of sound) variance += (v - mean) ** 2;
  const scale = 1 / Math.sqrt(variance / (sound.length || 1) + 1e-7);
  const x = new Float32Array(sound.length);
  for (let i = 0; i < sound.length; i++) x[i] = ((sound[i] as number) - mean) * scale;
  const out = await session.run({
    input_values: new ort.Tensor('float32', x, [1, x.length]),
  });
  const logits = out.logits as ort.Tensor;
  const [, frames, classes] = logits.dims as [number, number, number];
  return {
    logp: logSoftmax(Float32Array.from(logits.data as Float32Array), frames, classes),
    frames,
    classes,
  };
}

async function align(model: string, sound: Float32Array, words: TimedWord[]) {
  const session = await ort.InferenceSession.create(model, {
    intraOpNumThreads: Math.max(1, Math.min(8, availableParallelism())),
  });
  const duration = sound.length / RATE;
  const groups = alignGroups(words, duration, { maxSeconds: 20, pad: 1 });
  const timed: Array<{ start: number; end: number; score: number } | null> = words.map(() => null);
  for (const [gi, g] of groups.entries()) {
    const a = Math.floor(g.start * RATE);
    const b = Math.min(sound.length, Math.ceil(g.end * RATE));
    // wav2vec2 needs at least one 25 ms receptive field.
    if (b - a < 400) continue;
    const { logp, frames, classes } = await emissions(session, sound.subarray(a, b));
    const index: number[] = [];
    for (let i = g.from; i <= g.to; i++)
      if (wordTokens((words[i] as TimedWord).text).length) index.push(i);
    const spans = forcedAlign(
      logp,
      frames,
      classes,
      index.map((i) => wordTokens((words[i] as TimedWord).text)),
    );
    if (spans) {
      index.forEach((wi, k) => {
        const sp = spans[k];
        if (!sp || wi < g.first || wi > g.last) return;
        timed[wi] = {
          start: Math.round((g.start + sp.start * FRAME_SECONDS) * 1000) / 1000,
          end: Math.round((g.start + sp.end * FRAME_SECONDS) * 1000) / 1000,
          score: Math.round(sp.score * 1000) / 1000,
        };
      });
    }
    progress((gi + 1) / groups.length);
  }
  return { duration, words: timed };
}

const [op, ...args] = process.argv.slice(2);
const usage = () => {
  process.stderr.write(
    'usage: sound-worker.ts vad <model> <sound.f32> | align <model> <sound.f32> <words.json> | offset <a.f32> <b.f32> <rate> <max_seconds>\n',
  );
  process.exit(2);
};
let result: unknown;
if (op === 'vad' && args.length === 2) {
  result = await vad(args[0] as string, readSound(args[1] as string));
} else if (op === 'align' && args.length === 3) {
  result = await align(
    args[0] as string,
    readSound(args[1] as string),
    JSON.parse(readFileSync(args[2] as string, 'utf8')),
  );
} else if (op === 'offset' && args.length === 4) {
  const rate = Number(args[2]);
  const a = readSound(args[0] as string);
  const b = readSound(args[1] as string);
  // Digital silence has no timing to find: say which side it is.
  const silent = (x: Float32Array) => x.every((v) => v === 0);
  result = silent(a)
    ? { silent: 'a' }
    : silent(b)
      ? { silent: 'b' }
      : crossCorrelate(a, b, rate, { maxLag: Math.round(Number(args[3]) * rate) });
} else usage();
process.stdout.write(JSON.stringify(result));
