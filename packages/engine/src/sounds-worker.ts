// The sound-event and stem models, run in a process of their own (one per job) so a crash, a hang or the
// memory they take never reaches the server. sounds.ts starts it with one JSON argument and
// reads `progress <fraction>` lines from stderr. Inputs are raw float32 files FFmpeg decoded;
// outputs are files too, so nothing large crosses a pipe.
//
//   sed:    PretrainedSED frame_mn10 over 10 s windows of 16 kHz mono, overlapping by half,
//           each giving the middle half of its frames (sound-windows.ts): one byte
//           (probability × 255) per 40 ms frame per AudioSet-strong class, frame-major.
//   listen: FlexSED over the same windows, for query embeddings from the CLAP text encoder:
//           one byte per frame per query, frame-major.
//   embed:  CLAP embeddings (512 floats each) of texts, or of sounds (48 kHz mono, at most
//           10 s a window; a longer sound is the mean of its windows), one after another as
//           float32 in the output file. Texts and sounds land in one space, so a description
//           finds a sound by how it sounds.
//   stems:  Demucs v4 over 7.8 s segments of 44.1 kHz stereo, overlapped by a quarter and
//           blended with triangular weights (as demucs.apply does), normalised by the mix's
//           mean and spread; writes a 32-bit float WAV per stem asked for.

import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { SED_FRAME, SED_WINDOW, windowPlan } from './sound-windows.ts';

type Job =
  | { mode: 'sed'; model: string; input: string; output: string; threads: number }
  | {
      mode: 'listen';
      model: string;
      clapDir: string;
      clapModel: string;
      texts: string[];
      input: string;
      output: string;
      threads: number;
    }
  | {
      mode: 'embed';
      clapDir: string;
      clapModel: string;
      texts?: string[];
      /** Raw float32 48 kHz mono files. */
      sounds?: string[];
      output: string;
      threads: number;
    }
  | {
      mode: 'stems';
      model: string;
      input: string;
      /** Stem name to WAV path; names are the model's sources, or no_vocals. */
      outputs: Record<string, string>;
      threads: number;
    };

const WINDOW = SED_WINDOW;

function say(fraction: number): void {
  process.stderr.write(`progress ${Math.min(1, Math.max(0, fraction)).toFixed(4)}\n`);
}

async function session(model: string, threads: number): Promise<InferenceSession> {
  return InferenceSession.create(model, {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    // Peak memory, not speed, is what runs out in a container.
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
}

/** Reads `count` float32 samples from `offset` (in samples); zeros past either end. */
function readFloats(fd: number, total: number, offset: number, count: number): Float32Array {
  const out = new Float32Array(count);
  const from = Math.max(0, offset);
  const to = Math.min(total, offset + count);
  if (to > from) {
    const bytes = Buffer.from(out.buffer, (from - offset) * 4, (to - from) * 4);
    let got = 0;
    while (got < bytes.length) {
      const n = readSync(fd, bytes, got, bytes.length - got, from * 4 + got);
      if (!n) break;
      got += n;
    }
  }
  return out;
}

function sampleCount(path: string, channels: number): number {
  const fd = openSync(path, 'r');
  try {
    return Math.floor(fstatSync(fd).size / 4 / channels);
  } finally {
    closeSync(fd);
  }
}

/**
 * Frame-level probabilities over 10 s windows that overlap by half, each giving the middle of
 * its frames, so a sound carrying across a window's edge is scored where the window has sound
 * around it (MVP-321). Written as bytes, frame-major.
 */
async function windows(
  input: string,
  output: string,
  run: (wave: Float32Array) => Promise<{ data: Float32Array; classes: number; frames: number }>,
): Promise<void> {
  const total = sampleCount(input, 1);
  const fd = openSync(input, 'r');
  const out = openSync(output, 'w');
  try {
    const plan = windowPlan(total);
    for (const [w, part] of plan.entries()) {
      const wave = readFloats(fd, total, part.at, WINDOW);
      const { data, classes, frames } = await run(wave);
      const first = part.at / SED_FRAME;
      const bytes = Buffer.alloc((part.to - part.from) * classes);
      for (let f = part.from; f < part.to; f++) {
        const local = f - first;
        for (let c = 0; c < classes; c++) {
          bytes[(f - part.from) * classes + c] = Math.round((data[c * frames + local] ?? 0) * 255);
        }
      }
      writeSync(out, bytes);
      say((w + 1) / plan.length);
    }
  } finally {
    closeSync(fd);
    closeSync(out);
  }
}

async function sed(job: Extract<Job, { mode: 'sed' }>): Promise<void> {
  const s = await session(job.model, job.threads);
  await windows(job.input, job.output, async (wave) => {
    const r = await s.run({ wave: new Tensor('float32', wave, [1, WINDOW]) });
    const p = r.probabilities as Tensor;
    const [, classes, frames] = p.dims as number[];
    return { data: p.data as Float32Array, classes: classes ?? 0, frames: frames ?? 0 };
  });
}

/** CLAP text embeddings, one text at a time (padding a batch moves them slightly). */
async function embed(job: {
  clapDir: string;
  clapModel: string;
  texts?: string[];
}): Promise<Float32Array> {
  const { env, AutoTokenizer, ClapTextModelWithProjection } = await import(
    '@huggingface/transformers'
  );
  env.localModelPath = job.clapDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  const tokenizer = await AutoTokenizer.from_pretrained(job.clapModel);
  const model = await ClapTextModelWithProjection.from_pretrained(job.clapModel, {
    dtype: 'fp32',
  });
  const dims = 512;
  const texts = job.texts ?? [];
  const out = new Float32Array(texts.length * dims);
  for (const [i, text] of texts.entries()) {
    const { text_embeds } = await model(tokenizer([text], { truncation: true }));
    const v = text_embeds.data as Float32Array;
    if (v.length !== dims) throw new Error(`CLAP gave ${v.length} dimensions, not ${dims}`);
    out.set(v, i * dims);
  }
  await model.dispose();
  return out;
}

const CLAP_RATE = 48_000;
const CLAP_WINDOW = 10 * CLAP_RATE;
/** The most windows a long sound is embedded from, spread across it. */
const CLAP_WINDOWS = 6;

async function embedAll(job: Extract<Job, { mode: 'embed' }>): Promise<void> {
  const fd = openSync(job.output, 'w');
  try {
    if (job.texts?.length) writeSync(fd, new Uint8Array((await embed(job)).buffer));
    if (job.sounds?.length) {
      const { env, AutoProcessor, ClapAudioModelWithProjection } = await import(
        '@huggingface/transformers'
      );
      env.localModelPath = job.clapDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      const processor = await AutoProcessor.from_pretrained(job.clapModel);
      const model = await ClapAudioModelWithProjection.from_pretrained(job.clapModel, {
        dtype: 'fp32',
      });
      for (const [i, file] of job.sounds.entries()) {
        const input = openSync(file, 'r');
        const total = Math.floor(fstatSync(input).size / 4);
        const count = Math.max(1, Math.min(CLAP_WINDOWS, Math.ceil(total / CLAP_WINDOW)));
        // Windows spread evenly from the start to the end of the sound.
        const step = count > 1 ? (total - CLAP_WINDOW) / (count - 1) : 0;
        const sum = new Float32Array(512);
        for (let w = 0; w < count; w++) {
          const at = Math.round(w * step);
          const wave = readFloats(input, total, at, Math.min(CLAP_WINDOW, total - at));
          const { audio_embeds } = await model(await processor(wave));
          const v = audio_embeds.data as Float32Array;
          if (v.length !== 512) throw new Error(`CLAP gave ${v.length} dimensions, not 512`);
          let norm = 0;
          for (const x of v) norm += x * x;
          norm = Math.sqrt(norm) || 1;
          for (let d = 0; d < 512; d++) sum[d] = (sum[d] ?? 0) + (v[d] ?? 0) / norm;
        }
        closeSync(input);
        writeSync(fd, new Uint8Array(sum.buffer));
        say((i + 1) / job.sounds.length);
      }
      await model.dispose();
    }
  } finally {
    closeSync(fd);
  }
}

async function listen(job: Extract<Job, { mode: 'listen' }>): Promise<void> {
  const queries = await embed(job);
  const s = await session(job.model, job.threads);
  const query = new Tensor('float32', queries, [1, job.texts.length, 512]);
  await windows(job.input, job.output, async (wave) => {
    const r = await s.run({ wave: new Tensor('float32', wave, [1, WINDOW]), query });
    const p = r.probabilities as Tensor;
    const [, classes, frames] = p.dims as number[];
    return { data: p.data as Float32Array, classes: classes ?? 0, frames: frames ?? 0 };
  });
}

const STEM_SOURCES = ['drums', 'bass', 'other', 'vocals'];

/** A 32-bit float stereo WAV of a known length, written as it goes. */
function wavWriter(path: string, frames: number, rate: number) {
  const fd = openSync(path, 'w');
  const data = frames * 2 * 4;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); // IEEE float
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 8, 28);
  h.writeUInt16LE(8, 32);
  h.writeUInt16LE(32, 34);
  h.write('data', 36);
  h.writeUInt32LE(data, 40);
  writeSync(fd, h);
  return {
    write: (interleaved: Float32Array) =>
      writeSync(
        fd,
        Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength),
      ),
    close: () => closeSync(fd),
  };
}

async function stems(job: Extract<Job, { mode: 'stems' }>): Promise<void> {
  const rate = 44_100;
  const total = sampleCount(job.input, 2);
  const fd = openSync(job.input, 'r');
  // The mix's mean and spread (of its mono sum), as demucs normalises it.
  let sum = 0;
  let sq = 0;
  const block = 1 << 20;
  for (let at = 0; at < total; at += block) {
    const n = Math.min(block, total - at);
    const x = readFloats(fd, total * 2, at * 2, n * 2);
    for (let i = 0; i < n; i++) {
      const m = ((x[2 * i] ?? 0) + (x[2 * i + 1] ?? 0)) / 2;
      sum += m;
      sq += m * m;
    }
  }
  const mean = total ? sum / total : 0;
  const std = total > 1 ? Math.sqrt(Math.max(0, (sq - total * mean * mean) / (total - 1))) : 1;
  const scale = std > 1e-8 ? std : 1;
  say(0.02);

  const s = await session(job.model, job.threads);
  const L = 343_980; // 7.8 s, the model's training segment
  const stride = Math.floor(0.75 * L);
  const half = Math.floor(L / 2);
  const weight = new Float32Array(L);
  for (let i = 0; i < L; i++) weight[i] = (i < half ? i + 1 : L - i) / half;
  const S = STEM_SOURCES.length;
  const acc = new Float32Array(S * 2 * L);
  const accW = new Float32Array(L);
  const writers = Object.fromEntries(
    Object.entries(job.outputs).map(([name, path]) => [name, wavWriter(path, total, rate)]),
  );
  const flush = (count: number) => {
    for (const [name, w] of Object.entries(writers)) {
      const out = new Float32Array(count * 2);
      const sources = name === 'no_vocals' ? [0, 1, 2] : [STEM_SOURCES.indexOf(name)];
      for (let i = 0; i < count; i++) {
        const wsum = accW[i] || 1;
        for (let ch = 0; ch < 2; ch++) {
          let v = 0;
          for (const src of sources) v += acc[(src * 2 + ch) * L + i] ?? 0;
          // Each source is denormalised on its own, so a sum carries the mean once each.
          out[2 * i + ch] = (v / wsum) * scale + mean * sources.length;
        }
      }
      w.write(out);
    }
  };
  try {
    const count = Math.max(1, Math.ceil(total / stride));
    for (let k = 0, offset = 0; offset < total || k === 0; k++, offset += stride) {
      const cl = Math.min(L, total - offset);
      const start = offset - Math.floor((L - cl) / 2);
      const x = readFloats(fd, total * 2, start * 2, L * 2);
      const planar = new Float32Array(2 * L);
      for (let i = 0; i < L; i++) {
        const inside = start + i >= 0 && start + i < total;
        planar[i] = inside ? ((x[2 * i] ?? 0) - mean) / scale : 0;
        planar[L + i] = inside ? ((x[2 * i + 1] ?? 0) - mean) / scale : 0;
      }
      const r = await s.run({ mix: new Tensor('float32', planar, [1, 2, L]) });
      const y = (r.sources as Tensor).data as Float32Array; // [1, 4, 2, L]
      const lt = Math.floor((L - cl) / 2);
      for (let c = 0; c < S * 2; c++) {
        for (let i = 0; i < cl; i++) {
          acc[c * L + i] = (acc[c * L + i] ?? 0) + (weight[i] ?? 0) * (y[c * L + lt + i] ?? 0);
        }
      }
      for (let i = 0; i < cl; i++) accW[i] = (accW[i] ?? 0) + (weight[i] ?? 0);
      say(0.02 + (0.98 * (k + 1)) / count);
      if (offset + stride >= total) {
        flush(Math.max(0, cl));
        break;
      }
      flush(stride);
      for (let c = 0; c < S * 2; c++) {
        acc.copyWithin(c * L, c * L + stride, (c + 1) * L);
        acc.fill(0, (c + 1) * L - stride, (c + 1) * L);
      }
      accW.copyWithin(0, stride);
      accW.fill(0, L - stride);
    }
  } finally {
    closeSync(fd);
    for (const w of Object.values(writers)) w.close();
  }
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;
try {
  if (job.mode === 'sed') await sed(job);
  else if (job.mode === 'listen') await listen(job);
  else if (job.mode === 'embed') await embedAll(job);
  else if (job.mode === 'stems') await stems(job);
  else throw new Error(`unknown mode ${(job as { mode?: string }).mode}`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}
