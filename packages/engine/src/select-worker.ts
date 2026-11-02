// Picture models for selections, run in a subprocess of their own (select.ts starts it) so a
// model's memory and threads never sit in the server and a cancel can kill it. ONNX Runtime on
// the CPU.
//
//   node select-worker.ts track <edgetam dir> <seed frame> <prompt.json> <out.gray> <tmp dir> <w> <h>
//     stdin: RGB24 frames at 1024 × 1024, every frame of the video in order.
//     out.gray: an 8-bit matte of the prompted item for every frame, <w> × <h>, in frame order.
//     EdgeTAM's video pipeline: the item is found on the seed frame from the prompt (a box and/or
//     points), then followed forward to the end and backward to the start through its memory.
//
//   node select-worker.ts fill <lama.onnx> <w> <h>
//     stdin: RGBA frames <w> × <h>, alpha 255 where the picture is to be filled.
//     stdout: RGB24 frames <w> × <h>, the selection painted in by LaMa from its surroundings.
//
// Progress goes to stderr as "progress <0–1>" (track: frames done over frames read).

import { closeSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';

const progress = (f: number) => process.stderr.write(`progress ${f.toFixed(3)}\n`);

function threads(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

/** Reads stdin in fixed-size frames; resolves null at the end. */
function frameReader(size: number) {
  const stdin = process.stdin;
  let chunks: Buffer[] = [];
  let have = 0;
  let ended = false;
  let wake: (() => void) | undefined;
  stdin.on('data', (d: Buffer) => {
    chunks.push(d);
    have += d.length;
    if (have >= size * 2) stdin.pause();
    wake?.();
  });
  stdin.on('end', () => {
    ended = true;
    wake?.();
  });
  return async (): Promise<Buffer | null> => {
    while (have < size && !ended) {
      stdin.resume();
      await new Promise<void>((r) => {
        wake = r;
      });
      wake = undefined;
    }
    if (have < size) return null;
    const all = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
    const frame = Buffer.from(all.subarray(0, size));
    const rest = all.subarray(size);
    chunks = rest.length ? [rest] : [];
    have = rest.length;
    if (have < size * 2) stdin.resume();
    return frame;
  };
}

// ------------------------------------------------------------------------------------ track

const SIDE = 1024;
const FEAT = 64 * 64;
const MEM_DIM = 64;
const HIDDEN = 256;
const NUM_MASKMEM = 7;
const MAX_POINTERS = 16;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

interface Prompt {
  box?: { x: number; y: number; w: number; h: number };
  points?: Array<{ x: number; y: number; keep: boolean }>;
}

interface Step {
  /** Spatial memory tokens and their position encoding, [512, 1, 64] each. */
  tokens: Float32Array;
  pos: Float32Array;
  /** The object pointer, 256 values. */
  pointer: Float32Array;
}

const tensor = (data: Float32Array, dims: number[]) => new ort.Tensor('float32', data, dims);
const f32 = (t: ort.OnnxValue | undefined) => (t as ort.Tensor).data as Float32Array;

/**
 * EdgeTAM (Apache-2.0) as ONNX graphs (jax-image-tools/edgetam-video-onnx), with the memory
 * bank kept here as upstream keeps it (transformers' EdgeTamVideoModel): the seed frame's
 * memory, then up to six most recent frames, oldest first, each with its temporal position;
 * then the object pointers of the seed and the fifteen most recent frames, four tokens each.
 */
async function track(
  dir: string,
  seed: number,
  promptFile: string,
  outFile: string,
  tmpDir: string,
  w: number,
  h: number,
) {
  const weights = JSON.parse(readFileSync(join(dir, 'weights.json'), 'utf8')) as Record<
    string,
    { values: number[] }
  >;
  const tpe = Float32Array.from(weights.memory_temporal_positional_encoding?.values ?? []);
  const noMemory = Float32Array.from(weights.no_memory_embedding?.values ?? []);
  const prompt = JSON.parse(readFileSync(promptFile, 'utf8')) as Prompt;
  const opts: ort.InferenceSession.SessionOptions = {
    intraOpNumThreads: threads(),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  };
  const [encoder, decoder, memEncoder, memAttention] = await Promise.all(
    ['vision_encoder', 'mask_decoder', 'memory_encoder', 'memory_attention'].map((n) =>
      ort.InferenceSession.create(join(dir, `${n}.onnx`), opts),
    ),
  );
  if (!encoder || !decoder || !memEncoder || !memAttention) throw new Error('models');

  const pixels = new Float32Array(3 * SIDE * SIDE);
  const encode = (rgb: Buffer) => {
    const plane = SIDE * SIDE;
    for (let c = 0; c < 3; c++) {
      const m = MEAN[c] as number;
      const sd = STD[c] as number;
      for (let i = 0; i < plane; i++)
        pixels[c * plane + i] = ((rgb[i * 3 + c] as number) / 255 - m) / sd;
    }
    return encoder.run({ pixel_values: tensor(pixels, [1, 3, SIDE, SIDE]) });
  };
  /** [1, C, 64, 64] → [4096, 1, C]. */
  const flat = (src: Float32Array) => {
    const out = new Float32Array(FEAT * HIDDEN);
    for (let c = 0; c < HIDDEN; c++)
      for (let i = 0; i < FEAT; i++) out[i * HIDDEN + c] = src[c * FEAT + i] as number;
    return out;
  };

  const promptPoints: number[] = [];
  const promptLabels: number[] = [];
  if (prompt.box) {
    const b = prompt.box;
    promptPoints.push(b.x * SIDE, b.y * SIDE, (b.x + b.w) * SIDE, (b.y + b.h) * SIDE);
    promptLabels.push(2, 3);
  }
  for (const p of prompt.points ?? []) {
    promptPoints.push(p.x * SIDE, p.y * SIDE);
    promptLabels.push(p.keep ? 1 : 0);
  }

  const decode = (
    feats: ort.InferenceSession.OnnxValueMapType,
    top: Float32Array,
    points: number[],
    labels: number[],
  ) => {
    const n = labels.length;
    return decoder.run({
      feats0: feats.feats0 as ort.Tensor,
      feats1: feats.feats1 as ort.Tensor,
      feats2: tensor(top, [1, HIDDEN, 64, 64]),
      input_points: tensor(Float32Array.from(points), [1, 1, n, 2]),
      input_labels: new ort.Tensor('int32', Int32Array.from(labels), [1, 1, n]),
    });
  };

  const remember = async (
    feats2: Float32Array,
    highRes: Float32Array,
    pointer: Float32Array,
    fromPrompt: boolean,
  ): Promise<Step> => {
    const out = await memEncoder.run({
      vision_features: tensor(feats2, [1, HIDDEN, 64, 64]),
      pred_masks_high_res: tensor(highRes, [1, 1, SIDE, SIDE]),
      is_mask_from_pts: new ort.Tensor('bool', [fromPrompt], [1]),
    });
    return {
      tokens: Float32Array.from(f32(out.memory_tokens)),
      pos: Float32Array.from(f32(out.memory_pos_enc)),
      pointer: Float32Array.from(pointer),
    };
  };

  // The matte for one frame: the 1024² mask logits resized to w × h (bilinear), through a sigmoid.
  const matte = new Uint8Array(w * h);
  const writeMatte = (fd: number, frame: number, logits: Float32Array) => {
    const sx = SIDE / w;
    const sy = SIDE / h;
    for (let y = 0; y < h; y++) {
      const fy = Math.min(SIDE - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(SIDE - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(SIDE - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(SIDE - 1, x0 + 1);
        const tx = fx - x0;
        const a = logits[y0 * SIDE + x0] as number;
        const b = logits[y0 * SIDE + x1] as number;
        const c = logits[y1 * SIDE + x0] as number;
        const d = logits[y1 * SIDE + x1] as number;
        const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
        matte[y * w + x] = Math.round(255 / (1 + Math.exp(-v)));
      }
    }
    writeSync(fd, matte, 0, matte.length, frame * w * h);
  };

  /** One direction of tracking from the seed. */
  const follow = (seedStep: Step) => {
    const history: Step[] = [];
    return async (feats: ort.InferenceSession.OnnxValueMapType) => {
      const feats2 = f32(feats.feats2);
      const recent = history.slice(-(NUM_MASKMEM - 1));
      const blocks: Array<{ s: Step; row: number }> = [{ s: seedStep, row: NUM_MASKMEM - 1 }];
      recent.forEach((s, k) => {
        blocks.push({ s, row: recent.length - k - 1 });
      });
      const tokens = 512;
      const spatial = new Float32Array(blocks.length * tokens * MEM_DIM);
      const spatialPos = new Float32Array(blocks.length * tokens * MEM_DIM);
      blocks.forEach((b, i) => {
        const base = i * tokens * MEM_DIM;
        spatial.set(b.s.tokens, base);
        const row = tpe.subarray(b.row * MEM_DIM, (b.row + 1) * MEM_DIM);
        for (let j = 0; j < tokens; j++)
          for (let c = 0; c < MEM_DIM; c++)
            spatialPos[base + j * MEM_DIM + c] =
              (b.s.pos[j * MEM_DIM + c] as number) + (row[c] as number);
      });
      const pointers = [seedStep, ...history.slice(-(MAX_POINTERS - 1)).reverse()];
      const pointerMem = new Float32Array(pointers.length * HIDDEN);
      pointers.forEach((p, i) => {
        pointerMem.set(p.pointer, i * HIDDEN);
      });
      const attended = await memAttention.run({
        current_vision_features: tensor(flat(feats2), [FEAT, 1, HIDDEN]),
        current_vision_position_embeddings: tensor(flat(f32(feats.pos2)), [FEAT, 1, HIDDEN]),
        spatial_memory: tensor(spatial, [blocks.length * tokens, 1, MEM_DIM]),
        spatial_memory_position_embeddings: tensor(spatialPos, [
          blocks.length * tokens,
          1,
          MEM_DIM,
        ]),
        pointer_memory: tensor(pointerMem, [pointers.length * 4, 1, MEM_DIM]),
        pointer_memory_position_embeddings: tensor(
          new Float32Array(pointers.length * 4 * MEM_DIM),
          [pointers.length * 4, 1, MEM_DIM],
        ),
      });
      // [1, 1, 4096, 256] → [1, 256, 64, 64]
      const flatOut = f32(attended.conditioned_features);
      const top = new Float32Array(HIDDEN * FEAT);
      for (let i = 0; i < FEAT; i++)
        for (let c = 0; c < HIDDEN; c++) top[c * FEAT + i] = flatOut[i * HIDDEN + c] as number;
      const out = await decode(feats, top, [0, 0], [-1]);
      const highRes = f32(out.high_res_masks);
      history.push(await remember(feats2, highRes, f32(out.object_pointer), false));
      if (history.length > MAX_POINTERS) history.shift();
      return highRes;
    };
  };

  const frameSize = SIDE * SIDE * 3;
  const read = frameReader(frameSize);
  const beforeFd = openSync(join(tmpDir, 'before.rgb'), 'w+');
  const outFd = openSync(outFile, 'w');
  let index = 0;
  let seedStep: Step | undefined;
  let forward: ReturnType<typeof follow> | undefined;
  let done = 0;
  for (;;) {
    const rgb = await read();
    if (!rgb) break;
    if (index < seed) {
      writeSync(beforeFd, rgb, 0, rgb.length, index * frameSize);
    } else {
      const feats = await encode(rgb);
      let logits: Float32Array;
      if (index === seed) {
        const feats2 = f32(feats.feats2);
        const top = new Float32Array(feats2.length);
        for (let c = 0; c < HIDDEN; c++) {
          const add = noMemory[c] as number;
          for (let i = 0; i < FEAT; i++) top[c * FEAT + i] = (feats2[c * FEAT + i] as number) + add;
        }
        const out = await decode(feats, top, promptPoints, promptLabels);
        logits = f32(out.high_res_masks);
        seedStep = await remember(feats2, logits, f32(out.object_pointer), true);
        forward = follow(seedStep);
      } else {
        logits = await (forward as ReturnType<typeof follow>)(feats);
      }
      writeMatte(outFd, index, logits);
      done += 1;
      progress(done / Math.max(index + 1, seed + 1));
    }
    index += 1;
  }
  if (!seedStep) {
    closeSync(beforeFd);
    closeSync(outFd);
    throw new Error(`The video has ${index} frames; the seed frame ${seed} is past its end`);
  }
  const total = index;
  const backward = follow(seedStep);
  const rgb = Buffer.alloc(frameSize);
  for (let i = seed - 1; i >= 0; i--) {
    readSync(beforeFd, rgb, 0, frameSize, i * frameSize);
    writeMatte(outFd, i, await backward(await encode(rgb)));
    done += 1;
    progress(done / total);
  }
  closeSync(beforeFd);
  closeSync(outFd);
  process.stdout.write(`${JSON.stringify({ frames: total })}\n`);
}

// ------------------------------------------------------------------------------------- fill

const LAMA = 512;

/** Bilinear resample of an interleaved `channels` image. */
function resize(
  src: Uint8Array | Float32Array,
  sw: number,
  sh: number,
  channels: number,
  dw: number,
  dh: number,
  out: Float32Array,
) {
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < channels; c++) {
        const a = src[(y0 * sw + x0) * channels + c] as number;
        const b = src[(y0 * sw + x1) * channels + c] as number;
        const cc = src[(y1 * sw + x0) * channels + c] as number;
        const d = src[(y1 * sw + x1) * channels + c] as number;
        out[(y * dw + x) * channels + c] =
          (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
      }
    }
  }
}

interface Area {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The selection's separate parts, as boxes: selected cells of a coarse grid joined to their
 * neighbours, then boxes that come within a cell of each other merged.
 */
function areas(rgba: Buffer, w: number, h: number): Area[] {
  const cell = 16;
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const grid = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if ((rgba[(y * w + x) * 4 + 3] as number) > 8)
        grid[Math.floor(y / cell) * gw + Math.floor(x / cell)] = 1;
  const seen = new Uint8Array(gw * gh);
  const boxes: Area[] = [];
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i] || seen[i]) continue;
    const box = { x0: gw, y0: gh, x1: -1, y1: -1 };
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop() as number;
      const gx = j % gw;
      const gy = Math.floor(j / gw);
      box.x0 = Math.min(box.x0, gx);
      box.x1 = Math.max(box.x1, gx);
      box.y0 = Math.min(box.y0, gy);
      box.y1 = Math.max(box.y1, gy);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const k = ny * gw + nx;
        if (grid[k] && !seen[k]) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    boxes.push(box);
  }
  for (let merged = true; merged; ) {
    merged = false;
    for (let a = 0; a < boxes.length && !merged; a++)
      for (let b = a + 1; b < boxes.length && !merged; b++) {
        const p = boxes[a] as Area;
        const q = boxes[b] as Area;
        if (p.x0 <= q.x1 + 2 && q.x0 <= p.x1 + 2 && p.y0 <= q.y1 + 2 && q.y0 <= p.y1 + 2) {
          boxes[a] = {
            x0: Math.min(p.x0, q.x0),
            y0: Math.min(p.y0, q.y0),
            x1: Math.max(p.x1, q.x1),
            y1: Math.max(p.y1, q.y1),
          };
          boxes.splice(b, 1);
          merged = true;
        }
      }
  }
  return boxes.map((b) => ({
    x0: b.x0 * cell,
    y0: b.y0 * cell,
    x1: Math.min(w, (b.x1 + 1) * cell) - 1,
    y1: Math.min(h, (b.y1 + 1) * cell) - 1,
  }));
}

/**
 * How far the picture around an area moved since the last frame: the whole-pixel shift (up to
 * 24 px each way) that best lines the unselected pixels around it up with the last output.
 */
function shiftSince(
  prev: Buffer,
  rgba: Buffer,
  w: number,
  h: number,
  box: { left: number; top: number; cw: number; ch: number },
): [number, number] {
  const step = 4;
  const range = 6;
  let best: [number, number] = [0, 0];
  let bestCost = Number.POSITIVE_INFINITY;
  for (let dy = -range; dy <= range; dy++)
    for (let dx = -range; dx <= range; dx++) {
      let cost = 0;
      let count = 0;
      for (let y = box.top; y < box.top + box.ch; y += step)
        for (let x = box.left; x < box.left + box.cw; x += step) {
          const at = y * w + x;
          if ((rgba[at * 4 + 3] as number) > 0) continue;
          const px = x - dx * step;
          const py = y - dy * step;
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          const pa = (py * w + px) * 3;
          cost +=
            Math.abs((rgba[at * 4] as number) - (prev[pa] as number)) +
            Math.abs((rgba[at * 4 + 1] as number) - (prev[pa + 1] as number)) +
            Math.abs((rgba[at * 4 + 2] as number) - (prev[pa + 2] as number));
          count += 1;
        }
      if (count < 16) continue;
      const mean = cost / count + (Math.abs(dx) + Math.abs(dy)) * 0.05;
      if (mean < bestCost) {
        bestCost = mean;
        best = [dx * step, dy * step];
      }
    }
  return best;
}

/**
 * How much to add to each channel of a part's fill so it sits at the level of the picture
 * around it this frame: the mean of the unselected band just outside the selection less the
 * mean of the fill just inside it. Parts of the fill taken from earlier frames (and LaMa's
 * own drift) then follow a change of the whole picture's brightness, such as a flash.
 */
function levelShift(
  rgba: Buffer,
  w: number,
  box: { left: number; top: number; cw: number; ch: number },
  fillsAt: Uint8Array,
  values: Float32Array,
): [number, number, number] {
  const { left, top, cw, ch } = box;
  const band = Math.max(2, Math.round(Math.min(cw, ch) * 0.02));
  const outside = new Uint8Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) outside[i] = fillsAt[i] ? 0 : 1;
  const nearFill = reach(fillsAt, cw, ch, band);
  const nearOutside = reach(outside, cw, ch, band);
  const ring = [0, 0, 0];
  const inner = [0, 0, 0];
  let nr = 0;
  let ni = 0;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      const at = (top + y) * w + left + x;
      if (!fillsAt[i] && nearFill[i] && !(rgba[at * 4 + 3] as number)) {
        for (let c = 0; c < 3; c++) ring[c] = (ring[c] as number) + (rgba[at * 4 + c] as number);
        nr += 1;
      } else if (fillsAt[i] && nearOutside[i]) {
        for (let c = 0; c < 3; c++) inner[c] = (inner[c] as number) + (values[i * 3 + c] as number);
        ni += 1;
      }
    }
  if (nr < 16 || ni < 16) return [0, 0, 0];
  return [0, 1, 2].map((c) => (ring[c] as number) / nr - (inner[c] as number) / ni) as [
    number,
    number,
    number,
  ];
}

/** Frames a remembered pixel is used for after it was last seen. */
const MEMORY_FRAMES = 120;

/** Which pixels are set or within `r` pixels of a set one (a square reach), in a bw × bh grid. */
function reach(set: Uint8Array, bw: number, bh: number, r: number): Uint8Array {
  // A running count along each row, then each column: any set pixel within r.
  const rows = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    let count = 0;
    for (let x = -r; x < bw; x++) {
      if (x + r < bw) count += set[y * bw + x + r] as number;
      if (x - r - 1 >= 0) count -= set[y * bw + x - r - 1] as number;
      if (x >= 0) rows[y * bw + x] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(bw * bh);
  for (let x = 0; x < bw; x++) {
    let count = 0;
    for (let y = -r; y < bh; y++) {
      if (y + r < bh) count += rows[(y + r) * bw + x] as number;
      if (y - r - 1 >= 0) count -= rows[(y - r - 1) * bw + x] as number;
      if (y >= 0) out[y * bw + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/** Which pixels of a part are selected or within `r` pixels of the selection. */
function nearSelection(rgba: Buffer, w: number, a: Area, r: number): Uint8Array {
  const bw = a.x1 - a.x0 + 1;
  const bh = a.y1 - a.y0 + 1;
  const sel = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++)
      sel[y * bw + x] = (rgba[((a.y0 + y) * w + a.x0 + x) * 4 + 3] as number) > 0 ? 1 : 0;
  return reach(sel, bw, bh, r);
}

/** Moves the remembered picture within a part by the picture's shift since the last frame. */
function moveMemory(
  memory: Uint8Array,
  seen: Uint16Array,
  w: number,
  h: number,
  a: Area,
  dx: number,
  dy: number,
): void {
  const bw = a.x1 - a.x0 + 1;
  const bh = a.y1 - a.y0 + 1;
  const m = new Uint8Array(bw * bh * 3);
  const s = new Uint16Array(bw * bh);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const px = a.x0 + x - dx;
      const py = a.y0 + y - dy;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const from = py * w + px;
      const to = y * bw + x;
      s[to] = seen[from] as number;
      m[to * 3] = memory[from * 3] as number;
      m[to * 3 + 1] = memory[from * 3 + 1] as number;
      m[to * 3 + 2] = memory[from * 3 + 2] as number;
    }
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const at = (a.y0 + y) * w + a.x0 + x;
      const from = y * bw + x;
      seen[at] = s[from] as number;
      memory[at * 3] = m[from * 3] as number;
      memory[at * 3 + 1] = m[from * 3 + 1] as number;
      memory[at * 3 + 2] = m[from * 3 + 2] as number;
    }
}

/**
 * Fills each frame's selection with LaMa (Apache-2.0; Carve/LaMa-ONNX, 512 × 512). Each part of
 * the selection gets a square crop around it with as much surrounding picture again on each
 * side. Where an earlier frame showed the area (the item has moved off it, or the picture
 * moved), that real picture is used instead, moved along with the picture. Elsewhere, to keep
 * the fill from shimmering, each frame's fill is blended half and half with the last frame's
 * output moved by how far the picture around it moved. Only selected pixels change, blended
 * by the selection's own softness.
 */
async function fill(model: string, w: number, h: number) {
  const session = await ort.InferenceSession.create(model, {
    intraOpNumThreads: threads(),
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  const read = frameReader(w * h * 4);
  const image = new Float32Array(3 * LAMA * LAMA);
  const mask = new Float32Array(LAMA * LAMA);
  const crop = new Float32Array(LAMA * LAMA * 4);
  const plane = LAMA * LAMA;
  let prev: Buffer | undefined;
  // Where the last output was painted in fully: only those pixels are blended into this one,
  // never pixels that kept their own picture (the item itself, where it was not selected).
  let prevFilled: Uint8Array | undefined;
  const painted01 = new Uint8Array(w * h);
  // What the picture showed where each pixel is now, from the last frame it was not selected,
  // moved along with the picture: an area the item has moved off is shown as it really was.
  // seen[i] counts the frames since (0: never seen).
  const memory = new Uint8Array(w * h * 3);
  const seen = new Uint16Array(w * h);
  let n = 0;
  for (;;) {
    const rgba = await read();
    if (!rgba) break;
    const out = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      out[i * 3] = rgba[i * 4] as number;
      out[i * 3 + 1] = rgba[i * 4 + 1] as number;
      out[i * 3 + 2] = rgba[i * 4 + 2] as number;
    }
    const parts = areas(rgba, w, h);
    for (const a of parts) {
      const side = Math.min(
        Math.max(w, h),
        Math.max(64, 2 * Math.max(a.x1 - a.x0 + 1, a.y1 - a.y0 + 1)),
      );
      const cx = (a.x0 + a.x1 + 1) / 2;
      const cy = (a.y0 + a.y1 + 1) / 2;
      const cw = Math.min(w, side);
      const ch = Math.min(h, side);
      const left = Math.round(Math.min(Math.max(0, cx - cw / 2), w - cw));
      const top = Math.round(Math.min(Math.max(0, cy - ch / 2), h - ch));
      const region = new Uint8Array(cw * ch * 4);
      for (let y = 0; y < ch; y++)
        region.set(
          rgba.subarray(((top + y) * w + left) * 4, ((top + y) * w + left + cw) * 4),
          y * cw * 4,
        );
      resize(region, cw, ch, 4, LAMA, LAMA, crop);
      for (let i = 0; i < plane; i++) {
        const m = (crop[i * 4 + 3] as number) > 8 ? 1 : 0;
        mask[i] = m;
        for (let c = 0; c < 3; c++)
          image[c * plane + i] = m ? 0 : (crop[i * 4 + c] as number) / 255;
      }
      const result = await session.run({
        image: tensor(image, [1, 3, LAMA, LAMA]),
        mask: tensor(mask, [1, 1, LAMA, LAMA]),
      });
      const painted = f32(result.output);
      const inter = new Float32Array(plane * 3);
      for (let i = 0; i < plane; i++)
        for (let c = 0; c < 3; c++) inter[i * 3 + c] = painted[c * plane + i] as number;
      const filled = new Float32Array(cw * ch * 3);
      resize(inter, LAMA, LAMA, 3, cw, ch, filled);
      const [dx, dy] = prev ? shiftSince(prev, rgba, w, h, { left, top, cw, ch }) : [0, 0];
      if (!prev) seen.fill(0);
      else if (dx || dy) moveMemory(memory, seen, w, h, a, dx, dy);
      // Each pixel's fill first, then the fill's level matched to the picture around it.
      const values = new Float32Array(cw * ch * 3);
      const fillsAt = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++)
        for (let x = 0; x < cw; x++) {
          const gx = left + x;
          const gy = top + y;
          // Each part writes only its own pixels; a neighbour's crop may reach into it.
          if (gx < a.x0 || gx > a.x1 || gy < a.y0 || gy > a.y1) continue;
          const at = gy * w + gx;
          if (!(rgba[at * 4 + 3] as number)) continue;
          fillsAt[y * cw + x] = 1;
          const px = gx - dx;
          const py = gy - dy;
          const inside = prev && px >= 0 && py >= 0 && px < w && py < h;
          const held = inside && prevFilled?.[py * w + px] ? (py * w + px) * 3 : -1;
          const real = seen[at] ? at * 3 : -1;
          for (let c = 0; c < 3; c++) {
            let v = filled[(y * cw + x) * 3 + c] as number;
            if (real >= 0) v = memory[real + c] as number;
            else if (held >= 0) v = 0.5 * v + 0.5 * ((prev as Buffer)[held + c] as number);
            values[(y * cw + x) * 3 + c] = v;
          }
        }
      const level = levelShift(rgba, w, { left, top, cw, ch }, fillsAt, values);
      for (let y = 0; y < ch; y++)
        for (let x = 0; x < cw; x++) {
          if (!fillsAt[y * cw + x]) continue;
          const at = (top + y) * w + left + x;
          const alpha = (rgba[at * 4 + 3] as number) / 255;
          if (alpha >= 0.98) painted01[at] = 1;
          for (let c = 0; c < 3; c++) {
            const v = (values[(y * cw + x) * 3 + c] as number) + (level[c] as number);
            const o = rgba[at * 4 + c] as number;
            out[at * 3 + c] = Math.max(0, Math.min(255, Math.round(o + (v - o) * alpha)));
          }
        }
    }
    // Remember what shows around each part now, keeping clear of the selection's edge (where
    // a selection that is a little off would let the item itself in); age what is hidden.
    const margin = Math.max(4, Math.round(Math.min(w, h) * 0.02));
    for (const a of parts) {
      const near = nearSelection(rgba, w, a, margin);
      const bw = a.x1 - a.x0 + 1;
      for (let y = a.y0; y <= a.y1; y++)
        for (let x = a.x0; x <= a.x1; x++) {
          const at = y * w + x;
          if (!near[(y - a.y0) * bw + x - a.x0]) {
            memory[at * 3] = rgba[at * 4] as number;
            memory[at * 3 + 1] = rgba[at * 4 + 1] as number;
            memory[at * 3 + 2] = rgba[at * 4 + 2] as number;
            seen[at] = 1;
          } else if (seen[at] && rgba[at * 4 + 3])
            seen[at] = (seen[at] as number) >= MEMORY_FRAMES ? 0 : (seen[at] as number) + 1;
        }
    }
    prev = parts.length ? out : undefined;
    prevFilled = parts.length ? Uint8Array.from(painted01) : undefined;
    painted01.fill(0);
    process.stdout.write(out);
    n += 1;
    if (n % 10 === 0) process.stderr.write(`frames ${n}\n`);
  }
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'track') {
    const [dir, seed, prompt, out, tmp, w, h] = args;
    await track(
      dir as string,
      Number(seed),
      prompt as string,
      out as string,
      tmp as string,
      Number(w),
      Number(h),
    );
  } else if (cmd === 'fill') {
    const [model, w, h] = args;
    await fill(model as string, Number(w), Number(h));
  } else {
    process.stderr.write('usage: select-worker.ts track|fill ...\n');
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
