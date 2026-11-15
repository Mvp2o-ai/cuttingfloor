import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfError } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';
import { mediaStills } from './render.ts';

// The picture index media.search reads: keyframes of a video (or the one picture of an image),
// each as the JPEG Jev judges and a SigLIP2 embedding (Apache-2.0, google/siglip2-base-patch16-224
// as ONNX) for local similarity. Built once per media, on the CPU, with no provider; kept in the
// media's `search` folder: index.json (written last, so its presence means complete),
// vectors.f32 and frames.jpg (the keyframe JPEGs end to end).

const MODELS = process.env.CUTTINGFLOOR_SEARCH_MODELS ?? '/usr/share/cuttingfloor/models';
const WORKER = fileURLToPath(new URL('./search-worker.ts', import.meta.url));

export const SEARCH_MODEL = 'onnx-community/siglip2-base-patch16-224-ONNX';

/**
 * How keyframes are picked: a frame a second; a new keyframe when a frame's embedding moves this
 * far (cosine distance) from the current keyframe's, or this long after it. On 2026-11-15 this
 * caught every 3 s cut-in while judging ~11 frames a minute of static footage in an eval of real and inserted moments.
 */
export const KEYFRAMES = { everySeconds: 1, distance: 0.1, maxGapSeconds: 10 } as const;

/** Changes to how an index is built; an older index is built again. */
export const INDEX_VERSION = 1;

export interface Keyframe {
  /** Seconds of the media where this keyframe's view starts. */
  seconds: number;
  /** Where it ends: the next keyframe, or the end of the media. */
  end: number;
  /** Its JPEG within frames.jpg. */
  offset: number;
  bytes: number;
}

export interface PictureIndex {
  version: number;
  model: string;
  dims: number;
  keyframes: Keyframe[];
}

/**
 * Threads the model takes. Indexing runs beside the owner's own jobs, not in a render slot, so it
 * keeps to a few cores whatever the machine.
 */
function threads(): number {
  return Math.max(1, Math.min(2, Math.floor(availableParallelism() / 4)));
}

async function worker(
  job: Record<string, unknown>,
  signal: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  try {
    await run(
      process.execPath,
      [WORKER, JSON.stringify({ threads: threads(), dir: MODELS, model: SEARCH_MODEL, ...job })],
      {
        signal,
        timeoutMs: 60 * 60_000,
        onLine: (line) => {
          const m = /^progress ([\d.]+)/.exec(line);
          if (m) onProgress?.(Number(m[1]));
        },
      },
    );
  } catch (error) {
    if (error instanceof CfError && error.code === 'engine_error') {
      const stderr = String((error.detail as { stderr?: string } | undefined)?.stderr ?? '');
      if (/ENOENT|no such file|Could not locate file|Load model .* failed/i.test(stderr)) {
        throw new CfError('engine_error', 'The search model is not installed here', {
          hint: 'It ships in the cuttingfloor Docker image; run the server there',
          detail: { stderr },
        });
      }
    }
    throw error;
  }
}

function rows(buf: Buffer, count: number): Float32Array[] {
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const dims = count ? all.length / count : 0;
  return Array.from({ length: count }, (_, i) => all.slice(i * dims, (i + 1) * dims));
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** Indices of the keyframes among frames sampled every `step` seconds (see KEYFRAMES). */
export function pickKeyframes(
  vectors: Float32Array[],
  step: number,
  rule: { distance: number; maxGapSeconds: number } = KEYFRAMES,
): number[] {
  if (!vectors.length) return [];
  const picked = [0];
  for (let i = 1; i < vectors.length; i++) {
    const k = picked.at(-1) as number;
    const moved = 1 - dot(vectors[i] as Float32Array, vectors[k] as Float32Array);
    if (moved > rule.distance || (i - k) * step >= rule.maxGapSeconds) picked.push(i);
  }
  return picked;
}

/** Unit-length embeddings of texts, for similarity to an index's keyframes. */
export async function embedTexts(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-search-'));
  try {
    const output = join(dir, 'texts.f32');
    await worker({ mode: 'texts', texts, output }, signal);
    return rows(await readFile(output), texts.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A frame every `step` seconds as JPEGs at the size Jev takes, in one FFmpeg pass. */
async function sampleVideo(
  file: string,
  size: { width: number; height: number },
  picture: { longEdge: number; minEdge: number },
  step: number,
  dir: string,
  signal: AbortSignal,
): Promise<string[]> {
  const long = Math.max(size.width, size.height);
  const short = Math.max(1, Math.min(size.width, size.height));
  const scale = Math.max(picture.longEdge / long, picture.minEdge / short);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  await run(
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
      '-an',
      '-vf',
      `fps=1/${step},scale=${even(size.width * scale)}:${even(size.height * scale)}`,
      '-q:v',
      '3',
      join(dir, 'f_%06d.jpg'),
    ],
    { signal, timeoutMs: 60 * 60_000 },
  );
  return (await readdir(dir))
    .filter((n) => n.startsWith('f_') && n.endsWith('.jpg'))
    .sort()
    .map((n) => join(dir, n));
}

/**
 * Builds the index of a video's or image's picture into `out` (the media's search folder):
 * samples, embeds, keeps the keyframes. `file` is what to read (a video's proxy will do), `size`
 * the picture's upright size.
 */
export async function buildPictureIndex(options: {
  file: string;
  kind: 'video' | 'image';
  size: { width: number; height: number };
  duration: number | null;
  picture: { longEdge: number; minEdge: number };
  checker?: boolean;
  out: string;
  signal: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<PictureIndex> {
  const step = KEYFRAMES.everySeconds;
  const tmp = await mkdtemp(join(tmpdir(), 'cf-index-'));
  try {
    let stills: string[];
    if (options.kind === 'video') {
      stills = await sampleVideo(
        options.file,
        options.size,
        options.picture,
        step,
        tmp,
        options.signal,
      );
    } else {
      const [jpeg] = await mediaStills(options.file, options.size, [0], {
        ...options.picture,
        signal: options.signal,
        ...(options.checker ? { checker: true } : {}),
      });
      const one = join(tmp, 'f_000001.jpg');
      await writeFile(one, jpeg as Buffer);
      stills = [one];
    }
    if (!stills.length) throw new CfError('engine_error', 'No frames could be read for the index');
    options.onProgress?.(0.2);
    const output = join(tmp, 'images.f32');
    await worker({ mode: 'images', inputs: stills, output }, options.signal, (f) =>
      options.onProgress?.(0.2 + 0.75 * f),
    );
    const vectors = rows(await readFile(output), stills.length);
    const picked = pickKeyframes(vectors, step);
    const end = options.duration ?? stills.length * step;

    await mkdir(options.out, { recursive: true });
    const keyframes: Keyframe[] = [];
    const jpegs: Buffer[] = [];
    let offset = 0;
    for (const [n, i] of picked.entries()) {
      const jpeg = await readFile(stills[i] as string);
      const next = picked[n + 1];
      keyframes.push({
        seconds: i * step,
        end: next === undefined ? Math.max(i * step, end) : next * step,
        offset,
        bytes: jpeg.length,
      });
      jpegs.push(jpeg);
      offset += jpeg.length;
    }
    const dims = vectors[0]?.length ?? 0;
    const kept = new Float32Array(picked.length * dims);
    for (const [n, i] of picked.entries()) kept.set(vectors[i] as Float32Array, n * dims);
    const index: PictureIndex = { version: INDEX_VERSION, model: SEARCH_MODEL, dims, keyframes };
    const put = async (name: string, data: string | Buffer) => {
      const part = join(options.out, `${name}.part`);
      await writeFile(part, data);
      await rename(part, join(options.out, name));
    };
    await put('frames.jpg', Buffer.concat(jpegs));
    await put('vectors.f32', Buffer.from(kept.buffer));
    await put('index.json', JSON.stringify(index));
    options.onProgress?.(1);
    return index;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The index in a search folder; null when there is none, or it was built another way. */
export async function readPictureIndex(dir: string): Promise<PictureIndex | null> {
  try {
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as PictureIndex;
    return index.version === INDEX_VERSION && index.model === SEARCH_MODEL ? index : null;
  } catch {
    return null;
  }
}

/** An index's keyframe embeddings, in keyframe order. */
export async function keyframeVectors(dir: string, index: PictureIndex): Promise<Float32Array[]> {
  return rows(await readFile(join(dir, 'vectors.f32')), index.keyframes.length);
}

/** The JPEGs of the keyframes at `which` (indices into index.keyframes). */
export async function keyframePictures(
  dir: string,
  index: PictureIndex,
  which: number[],
): Promise<Buffer[]> {
  const fh = await open(join(dir, 'frames.jpg'), 'r');
  try {
    return await Promise.all(
      which.map(async (i) => {
        const k = index.keyframes[i] as Keyframe;
        const buf = Buffer.alloc(k.bytes);
        await fh.read(buf, 0, k.bytes, k.offset);
        return buf;
      }),
    );
  } finally {
    await fh.close();
  }
}
