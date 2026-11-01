import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CfError, type TimelineDoc } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';
import { lengthFrames, type MltSource, scaledSize, writeMltProject } from './mlt.ts';

// Picture measurement: colour statistics of whole frames and regions (computed here from the
// decoded RGB), FFmpeg signalstats for every frame over a stretch (brightness, colour and the
// change from the frame before), and a timeline's picture rendered to a file so the media
// analyses can read an edit.

const INPUT = ['-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file'];

/** A box in fractions of the picture: top-left x, y and size. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChannelStats {
  mean: number;
  /** Percentile (as given, e.g. "5") to value. */
  percentiles: Record<string, number>;
}

export interface ColourStats {
  /** The region measured, in pixels of the picture. */
  pixels: { x: number; y: number; w: number; h: number };
  r: ChannelStats;
  g: ChannelStats;
  b: ChannelStats;
  /** Rec. 709 luma of the gamma-encoded values: 0.2126 R + 0.7152 G + 0.0722 B. */
  luma: ChannelStats;
  /** Mean R, G and B of the brightest 1% of pixels by luma: an estimate of the white point. */
  white_point: { r: number; g: number; b: number };
  /** Share of pixels with a channel at 255, and with every channel at 0. */
  clipped_high: number;
  clipped_low: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Colour statistics of one region of an 8-bit RGB picture. */
export function colourStats(
  rgb: Uint8Array,
  width: number,
  height: number,
  box: Box,
  percentiles: number[],
): ColourStats {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(box.x * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(box.y * height)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.round((box.x + box.w) * width)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.round((box.y + box.h) * height)));
  const hr = new Float64Array(256);
  const hg = new Float64Array(256);
  const hb = new Float64Array(256);
  // Luma in tenths, so its percentiles keep a decimal.
  const lumaHist = new Float64Array(2551);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let lumaSum = 0;
  let high = 0;
  let low = 0;
  const n = (x1 - x0) * (y1 - y0);
  for (let y = y0; y < y1; y++) {
    let i = (y * width + x0) * 3;
    for (let x = x0; x < x1; x++, i += 3) {
      const r = rgb[i] as number;
      const g = rgb[i + 1] as number;
      const b = rgb[i + 2] as number;
      hr[r] = (hr[r] as number) + 1;
      hg[g] = (hg[g] as number) + 1;
      hb[b] = (hb[b] as number) + 1;
      sr += r;
      sg += g;
      sb += b;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += l;
      const k = Math.round(l * 10);
      lumaHist[k] = (lumaHist[k] as number) + 1;
      if (r === 255 || g === 255 || b === 255) high++;
      if (r === 0 && g === 0 && b === 0) low++;
    }
  }
  const pct = (h: Float64Array, scale: number) => {
    const out: Record<string, number> = {};
    for (const p of percentiles) {
      const target = (p / 100) * (n - 1);
      let acc = 0;
      let v = 0;
      for (; v < h.length; v++) {
        acc += h[v] as number;
        if (acc > target) break;
      }
      out[String(p)] = r2(Math.min(v, h.length - 1) / scale);
    }
    return out;
  };
  const channel = (sum: number, h: Float64Array): ChannelStats => ({
    mean: r2(sum / n),
    percentiles: pct(h, 1),
  });
  // White point: the mean colour of the brightest 1% of pixels (at least one).
  let cut = lumaHist.length - 1;
  for (let acc = 0; cut > 0; cut--) {
    acc += lumaHist[cut] as number;
    if (acc >= Math.max(1, n * 0.01)) break;
  }
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let wn = 0;
  for (let y = y0; y < y1; y++) {
    let i = (y * width + x0) * 3;
    for (let x = x0; x < x1; x++, i += 3) {
      const r = rgb[i] as number;
      const g = rgb[i + 1] as number;
      const b = rgb[i + 2] as number;
      if (Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) * 10) < cut) continue;
      wr += r;
      wg += g;
      wb += b;
      wn++;
    }
  }
  return {
    pixels: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    r: channel(sr, hr),
    g: channel(sg, hg),
    b: channel(sb, hb),
    luma: { mean: r2(lumaSum / n), percentiles: pct(lumaHist, 10) },
    white_point: {
      r: r2(wr / Math.max(1, wn)),
      g: r2(wg / Math.max(1, wn)),
      b: r2(wb / Math.max(1, wn)),
    },
    clipped_high: r4(high / n),
    clipped_low: r4(low / n),
  };
}

/** A picture decoded to 8-bit RGB at its own (upright) size. */
export interface RgbFrame {
  width: number;
  height: number;
  rgb: Uint8Array;
}

async function decodeRgb(
  args: string[],
  size: { width: number; height: number },
  dir: string,
  name: string,
  signal?: AbortSignal,
): Promise<RgbFrame> {
  const out = join(dir, `${name}.rgb`);
  await run(
    BIN.ffmpeg,
    [
      ...INPUT,
      ...args,
      '-frames:v',
      '1',
      '-vf',
      `scale=${size.width}:${size.height}:flags=neighbor`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-y',
      `file:${out}`,
    ],
    { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
  );
  const rgb = await readFile(out).catch(() => Buffer.alloc(0));
  if (rgb.length < size.width * size.height * 3) {
    throw new CfError('bad_request', `No picture at ${name}`, {
      hint: 'Sample times inside the picture: media.get gives its duration_seconds',
    });
  }
  return { ...size, rgb: new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.length) };
}

/** Frames of a media file at exact times, decoded to RGB at its own size, a few at once. */
export async function mediaRgbFrames(
  file: string,
  size: { width: number; height: number },
  times: number[],
  options: { signal?: AbortSignal; onFrame?: (done: number) => void } = {},
): Promise<RgbFrame[]> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-rgb-'));
  try {
    const out: RgbFrame[] = new Array(times.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < times.length) {
        const i = next++;
        const t = times[i] as number;
        out[i] = await decodeRgb(
          ['-ss', t.toFixed(6), '-i', `file:${file}`],
          size,
          dir,
          `${t} s`,
          options.signal,
        );
        options.onFrame?.(++done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, times.length) }, worker));
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** PNG pictures (rendered timeline frames) decoded to RGB at their own size. */
export async function pngsToRgb(
  pngs: Buffer[],
  size: { width: number; height: number },
  signal?: AbortSignal,
): Promise<RgbFrame[]> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-rgb-'));
  try {
    const out: RgbFrame[] = [];
    for (const [i, png] of pngs.entries()) {
      const file = join(dir, `f_${i}.png`);
      await writeFile(file, png);
      out.push(await decodeRgb(['-i', `file:${file}`], size, dir, `frame ${i}`, signal));
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every frame's signalstats over a stretch, as columns. */
export interface PictureSeries {
  method: string;
  from: number;
  /** Per signalstats value (time, yavg, ydif …), one number per frame in order. */
  columns: Record<string, number[]>;
}

/** Parses `metadata=mode=print` output into columns, times moved by `shift`. */
export function parseSignalstats(
  text: string,
  shift: number,
): Omit<PictureSeries, 'method' | 'from'> {
  const columns: Record<string, number[]> = { time: [] };
  let row = -1;
  for (const line of text.split('\n')) {
    const head = /^frame:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*(-?[\d.]+)/.exec(line);
    if (head) {
      row++;
      (columns.time as number[]).push(Math.round((Number(head[1]) + shift) * 10_000) / 10_000);
      continue;
    }
    const kv = /^lavfi\.signalstats\.([A-Z]+)=(-?[\d.]+(?:e-?\d+)?)/.exec(line);
    if (!kv || row < 0) continue;
    const key = (kv[1] as string).toLowerCase();
    const value = Number(kv[2]);
    if (!columns[key]) columns[key] = [];
    (columns[key] as number[])[row] = Math.round(value * 100) / 100;
  }
  return { columns };
}

/** signalstats for every frame of a file over a range, on the file's clock. */
export async function pictureSeries(
  file: string,
  options: { from?: number; until?: number; signal?: AbortSignal } = {},
): Promise<PictureSeries> {
  const from = options.from ?? 0;
  const { stdout } = await run(
    BIN.ffmpeg,
    [
      ...INPUT,
      ...(from ? ['-ss', String(from)] : []),
      ...(options.until !== undefined ? ['-to', String(options.until)] : []),
      '-i',
      `file:${file}`,
      '-an',
      '-vf',
      'signalstats,metadata=mode=print:file=-',
      '-f',
      'null',
      '-',
    ],
    {
      heavy: true,
      timeoutMs: 6 * 60 * 60_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return { method: 'ffmpeg-signalstats', from, ...parseSignalstats(stdout, from) };
}

/**
 * A timeline's picture over [start, end) frames rendered losslessly (FFV1) at its sequence size,
 * fitted inside `longEdge`, without sound, for the media analyses to read.
 */
export async function renderPictureFile(
  doc: TimelineDoc,
  sources: Map<string, MltSource>,
  dir: string,
  range: { start: number; end: number },
  options: { longEdge?: number; signal?: AbortSignal } = {},
): Promise<{ file: string; width: number; height: number }> {
  const length = lengthFrames(doc);
  if (range.end <= range.start || range.end > length) {
    throw new CfError(
      'bad_request',
      `Frames ${range.start}-${range.end} are not inside the timeline (0-${length})`,
    );
  }
  const { width: W, height: H } = doc.sequence;
  const size =
    options.longEdge && Math.max(W, H) > options.longEdge
      ? scaledSize(W, H, options.longEdge)
      : { width: W, height: H };
  const project = await writeMltProject(dir, doc, { ...size, sources, range });
  const file = join(dir, 'picture.mkv');
  await run(
    BIN.melt,
    [
      '-silent',
      ...project,
      '-consumer',
      `avformat:${file}`,
      'vcodec=ffv1',
      'pix_fmt=yuv420p',
      'f=matroska',
      'an=1',
      'audio_off=1',
      `width=${size.width}`,
      `height=${size.height}`,
      'real_time=-1',
      'progressive=1',
      'threads=0',
    ],
    {
      cwd: dir,
      heavy: true,
      timeoutMs: 4 * 60 * 60_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return { file, ...size };
}
