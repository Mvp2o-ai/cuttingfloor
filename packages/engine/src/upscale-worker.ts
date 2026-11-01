// Super-resolution for create.upscaled, in a subprocess of its own (upscale.ts starts it) so the
// model's memory and threads never sit in the server and a cancel can kill it. ONNX Runtime on
// the CPU runs Real-ESRGAN's compact model (four times the size) on every frame; FFmpeg decodes
// the source before it and resizes to the size asked for and encodes after it.
//
//   node upscale-worker.ts <model.onnx> <spec.json>
//
// spec: {input, output, width, height, out_width, out_height, frames, image, audio, fps}. Progress
// goes to stderr as "progress <0–1>".

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import * as ort from 'onnxruntime-node';

interface Spec {
  input: string;
  output: string;
  width: number;
  height: number;
  out_width: number;
  out_height: number;
  /** Frames expected, for progress; null when unknown. */
  frames: number | null;
  image: boolean;
  audio: boolean;
  /** The source's frame rate as num/den; null for a still. */
  fps: string | null;
}

const [model, specFile] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specFile as string, 'utf8')) as Spec;
const FFMPEG = process.env.CUTTINGFLOOR_FFMPEG ?? 'ffmpeg';

const session = await ort.InferenceSession.create(model as string, {
  intraOpNumThreads: availableParallelism(),
  interOpNumThreads: 1,
  graphOptimizationLevel: 'all',
});

const { width: W, height: H } = spec;
const frameBytes = W * H * 3;
const decoder = spawn(
  FFMPEG,
  [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    spec.input,
    '-map',
    '0:v:0',
    '-vf',
    `scale=${W}:${H}`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
const resize = `scale=${spec.out_width}:${spec.out_height}:flags=lanczos`;
const encoder = spawn(
  FFMPEG,
  [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-s',
    `${W * 4}x${H * 4}`,
    ...(spec.fps ? ['-framerate', spec.fps] : []),
    '-i',
    '-',
    ...(spec.image
      ? ['-vf', resize, '-frames:v', '1', '-c:v', 'png', '-y', spec.output]
      : [
          '-i',
          spec.input,
          '-map',
          '0:v',
          ...(spec.audio ? ['-map', '1:a:0?'] : []),
          '-vf',
          resize,
          '-c:v',
          'prores_ks',
          '-profile:v',
          '3',
          '-pix_fmt',
          'yuv422p10le',
          '-c:a',
          'pcm_s16le',
          '-shortest',
          '-y',
          spec.output,
        ]),
  ],
  { stdio: ['pipe', 'ignore', 'inherit'] },
);
const stop = () => {
  decoder.kill('SIGKILL');
  encoder.kill('SIGKILL');
  process.exit(1);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

/** One frame through the model: rgb24 in, rgb24 four times the size out. */
async function upscale(rgb: Buffer): Promise<Buffer> {
  const plane = W * H;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = (rgb[3 * i] as number) / 255;
    input[plane + i] = (rgb[3 * i + 1] as number) / 255;
    input[2 * plane + i] = (rgb[3 * i + 2] as number) / 255;
  }
  const out = await session.run({ image: new ort.Tensor('float32', input, [1, 3, H, W]) });
  const data = (out.upscaled as ort.Tensor).data as Float32Array;
  const big = 16 * plane;
  const result = Buffer.alloc(3 * big);
  for (let i = 0; i < big; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.round((data[c * big + i] as number) * 255);
      result[3 * i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return result;
}

const write = (buf: Buffer) =>
  new Promise<void>((resolve, reject) => {
    if (encoder.stdin.write(buf)) resolve();
    else {
      encoder.stdin.once('drain', resolve);
      encoder.stdin.once('error', reject);
    }
  });

const exited = (p: ReturnType<typeof spawn>, name: string) =>
  new Promise<void>((resolve, reject) =>
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)))),
  );
const decoded = exited(decoder, 'decoder');
const encoded = exited(encoder, 'encoder');

let pending: Buffer = Buffer.alloc(0);
let done = 0;
for await (const chunk of decoder.stdout as AsyncIterable<Buffer>) {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (pending.length >= frameBytes) {
    const frame = pending.subarray(0, frameBytes);
    pending = pending.subarray(frameBytes);
    await write(await upscale(Buffer.from(frame)));
    done++;
    if (spec.frames)
      process.stderr.write(`progress ${Math.min(1, done / spec.frames).toFixed(3)}\n`);
    if (spec.image) break;
  }
  if (spec.image && done) break;
}
if (spec.image) decoder.kill();
else await decoded;
encoder.stdin.end();
await encoded;
process.stdout.write(`${JSON.stringify({ frames: done })}\n`);
