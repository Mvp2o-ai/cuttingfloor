import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CfError, type TimelineDoc } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';
import { lengthFrames, type MltSource, scaledSize, writeMltProject } from './mlt.ts';

export interface ImageOptions {
  longEdge: number;
  format: 'webp' | 'png';
  /** Contact sheet of all frames, or one image per frame. */
  layout: 'single' | 'grid';
  signal?: AbortSignal;
}

const MELT_FRAME_TIMEOUT_MS = 120_000;

/**
 * Renders timeline frames with melt: one process renders every requested frame (a playlist of
 * single-frame entries), then FFmpeg encodes WebP/PNG, tiling them for a grid.
 */
export async function renderTimelineFrames(
  doc: TimelineDoc,
  frames: number[],
  sources: Map<string, MltSource>,
  options: ImageOptions,
): Promise<Buffer[]> {
  const length = lengthFrames(doc);
  const bad = frames.find((f) => f >= Math.max(1, length));
  if (bad !== undefined) {
    throw new CfError('bad_request', `Frame ${bad} is past the end of the timeline`, {
      hint: length
        ? `The timeline has ${length} frames (0 to ${length - 1})`
        : 'The timeline is empty; add a clip first',
    });
  }
  const size = scaledSize(doc.sequence.width, doc.sequence.height, options.longEdge);
  const dir = await mkdtemp(join(tmpdir(), 'cf-frames-'));
  try {
    const project = await writeMltProject(dir, doc, { ...size, sources, frames });
    await run(
      BIN.melt,
      [
        '-silent',
        ...project,
        '-consumer',
        'avformat:f_%04d.png',
        'vcodec=png',
        'real_time=0',
        'progressive=1',
        'audio_off=1',
        `width=${size.width}`,
        `height=${size.height}`,
      ],
      {
        cwd: dir,
        timeoutMs: MELT_FRAME_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const rendered = (await readdir(dir)).filter((f) => /^f_\d{4}\.png$/.test(f)).sort();
    if (rendered.length < frames.length) {
      throw new CfError(
        'render_failed',
        `melt rendered ${rendered.length} of ${frames.length} frames`,
      );
    }
    return await encodeImages(dir, rendered.slice(0, frames.length), options);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Renders frames of one media file (at its own rate) with FFmpeg. */
export async function renderMediaFrames(
  file: string,
  fps: { num: number; den: number },
  frames: number[],
  options: ImageOptions,
): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-mframes-'));
  try {
    const names: string[] = [];
    for (const [i, f] of frames.entries()) {
      const name = `f_${String(i + 1).padStart(4, '0')}.png`;
      const t = (f * fps.den) / fps.num;
      await run(
        BIN.ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-protocol_whitelist',
          'file',
          '-ss',
          t.toFixed(6),
          '-i',
          `file:${file}`,
          '-frames:v',
          '1',
          '-vf',
          `scale='if(gte(iw,ih),${options.longEdge},-2)':'if(gte(iw,ih),-2,${options.longEdge})'`,
          '-y',
          name,
        ],
        { cwd: dir, timeoutMs: 60_000, ...(options.signal ? { signal: options.signal } : {}) },
      );
      try {
        await stat(join(dir, name));
      } catch {
        throw new CfError('bad_request', `Frame ${f} is past the end of the media`);
      }
      names.push(name);
    }
    return await encodeImages(dir, names, options);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function encodeImages(dir: string, pngs: string[], options: ImageOptions): Promise<Buffer[]> {
  const codec = options.format === 'webp' ? ['-c:v', 'libwebp', '-quality', '82'] : ['-c:v', 'png'];
  if (options.layout === 'grid' && pngs.length > 1) {
    const cols = Math.ceil(Math.sqrt(pngs.length));
    const rows = Math.ceil(pngs.length / cols);
    const list = pngs.map((p) => `file '${p}'`).join('\n');
    await writeFile(join(dir, 'list.txt'), `${list}\n`);
    const out = `grid.${options.format}`;
    await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-f',
        'concat',
        '-safe',
        '0',
        '-protocol_whitelist',
        'file',
        '-i',
        'list.txt',
        '-vf',
        `tile=${cols}x${rows}:padding=4:color=black`,
        '-frames:v',
        '1',
        ...codec,
        '-y',
        out,
      ],
      { cwd: dir, timeoutMs: 60_000 },
    );
    return [await readFile(join(dir, out))];
  }
  const out: Buffer[] = [];
  for (const p of pngs) {
    if (options.format === 'png') {
      out.push(await readFile(join(dir, p)));
      continue;
    }
    const name = p.replace(/\.png$/, '.webp');
    await run(BIN.ffmpeg, ['-hide_banner', '-nostdin', '-i', p, ...codec, '-y', name], {
      cwd: dir,
      timeoutMs: 60_000,
    });
    out.push(await readFile(join(dir, name)));
  }
  return out;
}

export interface ExportPresetSpec {
  extension: string;
  mime: string;
  size: (w: number, h: number) => { width: number; height: number };
  consumer: string[];
}

export const PRESETS: Record<'web_1080p_h264' | 'master_prores_422hq', ExportPresetSpec> = {
  web_1080p_h264: {
    extension: 'mp4',
    mime: 'video/mp4',
    size: (w, h) => {
      const scale = w >= h ? Math.min(1920 / w, 1080 / h) : Math.min(1080 / w, 1920 / h);
      const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
      return { width: even(w), height: even(h) };
    },
    consumer: [
      'vcodec=libx264',
      'preset=medium',
      'crf=20',
      'pix_fmt=yuv420p',
      'g=120',
      'acodec=aac',
      'ab=192k',
      'f=mp4',
      'movflags=+faststart',
      'color_primaries=bt709',
      'color_trc=bt709',
      'colorspace=709',
    ],
  },
  master_prores_422hq: {
    extension: 'mov',
    mime: 'video/quicktime',
    size: (w, h) => ({ width: w, height: h }),
    consumer: [
      'vcodec=prores_ks',
      'vprofile=3',
      'vendor=apl0',
      'pix_fmt=yuv422p10le',
      'acodec=pcm_s24le',
      'f=mov',
      'color_primaries=bt709',
      'color_trc=bt709',
      'colorspace=709',
    ],
  },
};

/** Exports a timeline (or a frame range) with melt. Reports progress as a fraction. */
export async function exportTimeline(
  doc: TimelineDoc,
  preset: keyof typeof PRESETS,
  sources: Map<string, MltSource>,
  dest: string,
  options: {
    range?: { start: number; end: number };
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
  },
): Promise<{ frames: number }> {
  const spec = PRESETS[preset];
  const length = lengthFrames(doc);
  if (length === 0)
    throw new CfError('bad_request', 'The timeline is empty', {
      hint: 'Add clips with clip.add first',
    });
  const range = options.range ?? { start: 0, end: length };
  if (range.end <= range.start || range.end > length) {
    throw new CfError(
      'bad_request',
      `Range ${range.start}-${range.end} is not inside the timeline (0-${length})`,
    );
  }
  const size = spec.size(doc.sequence.width, doc.sequence.height);
  const dir = await mkdtemp(join(tmpdir(), 'cf-export-'));
  try {
    const project = await writeMltProject(dir, doc, { ...size, sources, range });
    await mkdir(join(dest, '..'), { recursive: true });
    const total = range.end - range.start;
    await run(
      BIN.melt,
      [
        '-silent',
        '-progress',
        ...project,
        '-consumer',
        `avformat:${dest}`,
        ...spec.consumer,
        `width=${size.width}`,
        `height=${size.height}`,
        `frequency=${doc.sequence.audio_rate}`,
        `channels=${doc.sequence.channels}`,
        'real_time=-1',
        'progressive=1',
        'threads=0',
      ],
      {
        cwd: dir,
        ...(options.signal ? { signal: options.signal } : {}),
        onLine: (line) => {
          const m = /Current Frame:\s+(\d+)/.exec(line);
          if (m && options.onProgress) options.onProgress(Math.min(1, Number(m[1]) / total));
        },
      },
    );
    return { frames: total };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Probe-free frame count of a rendered file (for QA). */
export async function countFrames(file: string): Promise<number> {
  const { stdout } = await run(BIN.ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-count_packets',
    '-show_entries',
    'stream=nb_read_packets',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number(stdout.trim());
}
