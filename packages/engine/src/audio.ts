import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CfError, type TimelineDoc } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';
import { lengthFrames, type MltSource, writeMltProject } from './mlt.ts';

// The mix as sound: rendered with melt (audio only), measured with ebur128, and drawn as a
// waveform image for audio edits, since an agent reads images, not sound.

export interface Loudness {
  /** Integrated loudness, LUFS; null when there is nothing measurable. */
  lufs: number | null;
  /** True peak, dBTP; null when silent. */
  peak: number | null;
}

const MIX_TIMEOUT_MS = 30 * 60_000;

/** Renders the mix of [start, end) frames to a WAV in `dir` and returns its path. */
async function renderMix(
  doc: TimelineDoc,
  sources: Map<string, MltSource>,
  dir: string,
  range: { start: number; end: number },
  signal?: AbortSignal,
): Promise<string> {
  const project = await writeMltProject(dir, doc, { width: 64, height: 36, sources, range });
  await run(
    BIN.melt,
    [
      '-silent',
      ...project,
      '-consumer',
      'avformat:mix.wav',
      'acodec=pcm_s16le',
      `frequency=${doc.sequence.audio_rate}`,
      `channels=${doc.sequence.channels}`,
      'video_off=1',
      'real_time=-1',
    ],
    { cwd: dir, timeoutMs: MIX_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
  return join(dir, 'mix.wav');
}

async function ebur128(file: string, signal?: AbortSignal): Promise<Loudness> {
  const { stderr } = await run(
    BIN.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-af',
      'ebur128=peak=true:framelog=quiet',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: MIX_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
  return {
    lufs: Number.isFinite(lufs) && lufs > -70 ? lufs : null,
    peak: Number.isFinite(peak) ? peak : null,
  };
}

function wholeRange(doc: TimelineDoc): { start: number; end: number } {
  const end = lengthFrames(doc);
  if (!end) throw new CfError('bad_request', 'The timeline is empty', { hint: 'Add a clip first' });
  return { start: 0, end };
}

/** Integrated loudness and true peak of the mix over a range (default: all of it). */
export async function measureMix(
  doc: TimelineDoc,
  sources: Map<string, MltSource>,
  options: { range?: { start: number; end: number }; signal?: AbortSignal } = {},
): Promise<Loudness> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-mix-'));
  try {
    const file = await renderMix(
      doc,
      sources,
      dir,
      options.range ?? wholeRange(doc),
      options.signal,
    );
    return await ebur128(file, options.signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A waveform image of the mix over [start, end) frames, with its measured loudness. */
export async function renderWaveform(
  doc: TimelineDoc,
  sources: Map<string, MltSource>,
  range: { start: number; end: number },
  options: { width?: number; height?: number; format?: 'webp' | 'png'; signal?: AbortSignal } = {},
): Promise<{ image: Buffer } & Loudness> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-wave-'));
  const width = options.width ?? 640;
  const height = options.height ?? 200;
  const format = options.format ?? 'webp';
  try {
    const file = await renderMix(doc, sources, dir, range, options.signal);
    const out = `wave.${format}`;
    await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-i',
        file,
        '-filter_complex',
        `showwavespic=s=${width}x${height}:split_channels=1:colors=0x4fc3f7|0x81c784:scale=sqrt,pad=${width}:${height}:0:0:0x101418,format=rgb24`,
        '-frames:v',
        '1',
        ...(format === 'webp' ? ['-c:v', 'libwebp', '-quality', '82'] : ['-c:v', 'png']),
        '-y',
        out,
      ],
      { cwd: dir, timeoutMs: 120_000, ...(options.signal ? { signal: options.signal } : {}) },
    );
    const loudness = await ebur128(file, options.signal);
    return { image: await readFile(join(dir, out)), ...loudness };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
