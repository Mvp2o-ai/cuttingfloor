import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CfError, type TimelineDoc } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';
import { lengthFrames, type MltSource, scaledSize, writeMltProject } from './mlt.ts';
import { ffmpegArgs, meltArgs, type Overrides, type PresetName, resolvePreset } from './presets.ts';

export type ImageFormat = 'webp' | 'png' | 'jpeg';

export interface ImageOptions {
  longEdge: number;
  format: ImageFormat;
  /** WebP and JPEG, 1–100. Default 82 (WebP) and 85 (JPEG). */
  quality?: number;
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
        heavy: true,
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

/**
 * Stills of one media file as baseline JPEGs at exact times, sized for a judgment model: the long
 * edge `longEdge`, raised so the short edge is at least `minEdge`. Runs a few FFmpeg seeks at once.
 */
export async function mediaStills(
  file: string,
  size: { width: number; height: number },
  times: number[],
  options: {
    longEdge: number;
    minEdge: number;
    signal?: AbortSignal;
    onFrame?: (done: number) => void;
  },
): Promise<Buffer[]> {
  const long = Math.max(size.width, size.height);
  const short = Math.max(1, Math.min(size.width, size.height));
  const scale = Math.max(options.longEdge / long, options.minEdge / short);
  const w = Math.round(size.width * scale);
  const h = Math.round(size.height * scale);
  const dir = await mkdtemp(join(tmpdir(), 'cf-stills-'));
  try {
    const out: Buffer[] = new Array(times.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < times.length) {
        const i = next++;
        const name = join(dir, `s_${i}.jpg`);
        await run(
          BIN.ffmpeg,
          [
            '-hide_banner',
            '-nostdin',
            '-v',
            'error',
            '-protocol_whitelist',
            'file',
            '-ss',
            (times[i] as number).toFixed(6),
            '-i',
            `file:${file}`,
            '-frames:v',
            '1',
            '-vf',
            `scale=${w}:${h}:flags=area,format=yuvj420p`,
            '-q:v',
            '3',
            '-y',
            name,
          ],
          { timeoutMs: 60_000, ...(options.signal ? { signal: options.signal } : {}) },
        );
        const data = await readFile(name).catch(() => null);
        if (!data?.length) {
          throw new CfError('bad_request', `No picture at ${times[i]} s`, {
            hint: 'Sample times inside the media: media.get gives its duration_seconds',
          });
        }
        out[i] = data;
        options.onFrame?.(++done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, times.length) }, worker));
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** FFmpeg's encoder arguments for an image format at a quality (1–100). */
function imageCodec(options: ImageOptions): string[] {
  if (options.format === 'webp')
    return ['-c:v', 'libwebp', '-quality', String(options.quality ?? 82)];
  if (options.format === 'jpeg') {
    // mjpeg's scale runs 2 (best) to 31; full-range 4:2:0, which every viewer reads.
    const q = Math.round(2 + ((100 - (options.quality ?? 85)) * 29) / 99);
    return ['-c:v', 'mjpeg', '-q:v', String(q), '-pix_fmt', 'yuvj420p'];
  }
  return ['-c:v', 'png'];
}

/** The file extension for an image format. */
export const imageExtension = (format: ImageFormat): string => (format === 'jpeg' ? 'jpg' : format);

async function encodeImages(dir: string, pngs: string[], options: ImageOptions): Promise<Buffer[]> {
  const codec = imageCodec(options);
  if (options.layout === 'grid' && pngs.length > 1) {
    const cols = Math.ceil(Math.sqrt(pngs.length));
    const rows = Math.ceil(pngs.length / cols);
    const list = pngs.map((p) => `file '${p}'`).join('\n');
    await writeFile(join(dir, 'list.txt'), `${list}\n`);
    const out = `grid.${imageExtension(options.format)}`;
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
    const name = p.replace(/\.png$/, `.${imageExtension(options.format)}`);
    await run(BIN.ffmpeg, ['-hide_banner', '-nostdin', '-i', p, ...codec, '-y', name], {
      cwd: dir,
      timeoutMs: 60_000,
    });
    out.push(await readFile(join(dir, name)));
  }
  return out;
}

/** Exports a timeline (or a frame range) with melt, plus an FFmpeg pass for GIFs and rate changes. */
export async function exportTimeline(
  doc: TimelineDoc,
  preset: PresetName,
  sources: Map<string, MltSource>,
  dest: string,
  options: {
    range?: { start: number; end: number };
    overrides?: Overrides;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
    /** While it waits for a render slot: how many renders are ahead. */
    onQueue?: (ahead: number) => void;
  },
): Promise<{ frames: number; width: number | null; height: number | null }> {
  const { spec, settings, width, height } = resolvePreset(preset, doc.sequence, options.overrides);
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
  const fps = spec.gif ? (options.overrides?.fps ?? spec.gif.fps) : options.overrides?.fps;
  // A second pass: melt writes a lossless file, FFmpeg makes the output from it.
  const twoPass = Boolean(spec.gif || fps);
  const dir = await mkdtemp(join(tmpdir(), 'cf-export-'));
  try {
    const project = await writeMltProject(dir, doc, { width, height, sources, range });
    await mkdir(join(dest, '..'), { recursive: true });
    const total = range.end - range.start;
    const share = twoPass ? 0.8 : 1;
    const first = twoPass ? join(dir, 'master.mkv') : dest;
    const consumer = twoPass
      ? meltArgs({
          vcodec: 'ffv1',
          pix_fmt: 'yuv444p',
          ...(spec.gif ? { an: '1' } : { acodec: 'pcm_s24le' }),
          f: 'matroska',
        })
      : meltArgs({ ...settings, ...(spec.audioOnly ? { vn: '1' } : {}) });
    await run(
      BIN.melt,
      [
        // Not -silent: it suppresses -progress too, and the job then shows no progress at all.
        '-progress',
        ...project,
        '-consumer',
        `avformat:${first}`,
        ...consumer,
        `width=${width}`,
        `height=${height}`,
        `frequency=${spec.audioOnly && preset === 'audio_wav_48k' ? 48000 : doc.sequence.audio_rate}`,
        `channels=${doc.sequence.channels}`,
        'real_time=-1',
        'progressive=1',
        'threads=0',
      ],
      {
        cwd: dir,
        heavy: true,
        ...(options.onQueue ? { onQueue: options.onQueue } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onLine: (line) => {
          const m = /Current Frame:\s+(\d+)/.exec(line);
          if (m && options.onProgress)
            options.onProgress(share * Math.min(1, Number(m[1]) / total));
        },
      },
    );
    if (!twoPass) {
      return {
        frames: spec.audioOnly ? 0 : total,
        width: spec.audioOnly ? null : width,
        height: spec.audioOnly ? null : height,
      };
    }
    const rate = fps as number;
    const vf = spec.gif
      ? `fps=${rate},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`
      : `fps=${rate}`;
    await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-i',
        first,
        ...(spec.gif
          ? ['-filter_complex', vf, '-loop', '0', '-f', 'gif']
          : ['-vf', vf, ...ffmpegArgs(settings)]),
        dest,
      ],
      {
        heavy: true,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: 4 * 60 * 60_000,
      },
    );
    options.onProgress?.(1);
    const seconds = (total * doc.sequence.fps.den) / doc.sequence.fps.num;
    return { frames: Math.round(seconds * rate), width, height };
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
