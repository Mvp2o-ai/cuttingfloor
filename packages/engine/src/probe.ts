import { open } from 'node:fs/promises';
import { CfError } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';

/** What import needs to know about a file. Durations are seconds. */
export interface Probe {
  format: string;
  kind: 'video' | 'audio' | 'image' | 'font' | 'lut';
  /** Font family, for fonts. */
  family?: string;
  duration: number | null;
  video: {
    codec: string;
    width: number;
    height: number;
    fps: { num: number; den: number };
    vfr: boolean;
    rotation: number;
    transfer: string | null;
    primaries: string | null;
    pix_fmt: string | null;
    frames: number | null;
  } | null;
  audio: { codec: string; sample_rate: number; channels: number } | null;
}

// Demuxers user media may use. Playlists, concat and network protocols are never opened.
const ALLOWED_FORMATS = new Set([
  'mov',
  'mp4',
  'm4a',
  '3gp',
  '3g2',
  'mj2',
  'matroska',
  'webm',
  'avi',
  'mpegts',
  'mxf',
  'mpeg',
  'flv',
  'wav',
  'mp3',
  'flac',
  'ogg',
  'aiff',
  'aac',
  'caf',
  'w64',
  'png_pipe',
  'jpeg_pipe',
  'webp_pipe',
  'tiff_pipe',
  'bmp_pipe',
  'image2',
]);
const IMAGE_FORMATS = new Set([
  'png_pipe',
  'jpeg_pipe',
  'webp_pipe',
  'tiff_pipe',
  'bmp_pipe',
  'image2',
]);
const MAX_STREAMS = 32;
const MAX_PIXELS = 8192 * 8192;
const MAX_DURATION = 12 * 60 * 60;

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  color_transfer?: string;
  color_primaries?: string;
  pix_fmt?: string;
  nb_frames?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: Array<{ rotation?: number }>;
  tags?: { rotate?: string };
}

const FONT_MAGIC = ['00010000', '4f54544f', '74746366', '74727565']; // TrueType, OTTO, ttcf, true
const MAX_FONT_BYTES = 64 * 1024 * 1024;

/** A TrueType/OpenType font (by its first bytes), with the family fontconfig reads from it. */
async function probeFont(path: string, signal?: AbortSignal): Promise<Probe | undefined> {
  const handle = await open(path, 'r');
  let magic: string;
  let size: number;
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    magic = head.toString('hex');
    size = (await handle.stat()).size;
  } finally {
    await handle.close();
  }
  if (!FONT_MAGIC.includes(magic)) return undefined;
  if (size > MAX_FONT_BYTES) throw new CfError('limit_exceeded', 'Font files are limited to 64 MB');
  const { stdout } = await run(BIN.fcScan, ['--format', '%{family[0]}\n', path], {
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  }).catch(() => ({ stdout: '' }));
  const family = stdout.split('\n')[0]?.trim();
  if (!family) throw new CfError('bad_request', 'The font file could not be read');
  return { format: 'font', kind: 'font', family, duration: null, video: null, audio: null };
}

const MAX_LUT_BYTES = 32 * 1024 * 1024;

/** A .cube 3D LUT: text with a LUT_3D_SIZE line near the top. */
async function probeLut(path: string): Promise<Probe | undefined> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const text = head.subarray(0, bytesRead).toString('latin1');
    const size = /^\s*LUT_3D_SIZE\s+(\d+)\s*$/m.exec(text);
    if (!size) return undefined;
    const n = Number(size[1]);
    if (n < 2 || n > 256)
      throw new CfError('bad_request', `LUT_3D_SIZE ${n} is out of range (2 to 256)`);
    if ((await handle.stat()).size > MAX_LUT_BYTES) {
      throw new CfError('limit_exceeded', 'LUT files are limited to 32 MB');
    }
    return { format: 'cube', kind: 'lut', duration: null, video: null, audio: null };
  } finally {
    await handle.close();
  }
}

export async function probe(path: string, signal?: AbortSignal): Promise<Probe> {
  const font = await probeFont(path, signal);
  if (font) return font;
  const lut = await probeLut(path);
  if (lut) return lut;
  let out: string;
  try {
    ({ stdout: out } = await run(
      BIN.ffprobe,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        '-i',
        `file:${path}`,
      ],
      { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
    ));
  } catch (error) {
    if (error instanceof CfError && error.code === 'engine_error') {
      throw new CfError('bad_request', 'The file is not a readable media file', {
        detail: error.detail ?? {},
      });
    }
    throw error;
  }
  const json = JSON.parse(out) as {
    format?: { format_name?: string; duration?: string };
    streams?: FfStream[];
  };
  const formatNames = (json.format?.format_name ?? '').split(',');
  const format = formatNames.find((f) => ALLOWED_FORMATS.has(f));
  if (!format) {
    throw new CfError(
      'bad_request',
      `Unsupported container: ${json.format?.format_name ?? 'unknown'}`,
      {
        hint: 'Supported: MP4/MOV, MKV/WebM, AVI, MXF, MPEG-TS, WAV, MP3, FLAC, Ogg, AIFF, PNG, JPEG, WebP, TIFF',
      },
    );
  }
  const streams = json.streams ?? [];
  if (streams.length > MAX_STREAMS)
    throw new CfError('limit_exceeded', `Too many streams (${streams.length})`);
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new CfError('bad_request', 'The file has no video or audio stream');

  const isImage =
    IMAGE_FORMATS.has(format) ||
    (v !== undefined &&
      !a &&
      ['png', 'mjpeg', 'webp', 'tiff', 'bmp'].includes(v.codec_name ?? '') &&
      Number(v.nb_frames ?? 1) <= 1 &&
      formatNames.some((f) => IMAGE_FORMATS.has(f)));
  const duration = isImage
    ? null
    : Number(json.format?.duration ?? v?.duration ?? a?.duration ?? Number.NaN);
  if (duration !== null && !(duration > 0))
    throw new CfError('bad_request', 'Could not read the media duration');
  if (duration !== null && duration > MAX_DURATION)
    throw new CfError('limit_exceeded', 'Media longer than 12 hours');

  let video: Probe['video'] = null;
  if (v) {
    const width = v.width ?? 0;
    const height = v.height ?? 0;
    if (!width || !height || width * height > MAX_PIXELS) {
      throw new CfError('limit_exceeded', `Unsupported frame size ${width}x${height}`);
    }
    const r = rational(v.r_frame_rate);
    const avg = rational(v.avg_frame_rate);
    const vfr = Boolean(
      r && avg && Math.abs(r.num / r.den - avg.num / avg.den) / (avg.num / avg.den) > 0.01,
    );
    // VFR media is conformed to its nominal rate (phones record "30 fps" with gaps): the finer
    // grid keeps every frame on time. Otherwise the average rate is the true one.
    const nominal = r && r.num / r.den <= 120 ? r : null;
    const fps = vfr && nominal ? nominal : avg && avg.num > 0 ? avg : (r ?? { num: 25, den: 1 });
    const rotation = Number(
      v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0,
    );
    video = {
      codec: v.codec_name ?? 'unknown',
      width,
      height,
      fps: standardRate(fps),
      vfr,
      rotation: ((Math.round(rotation) % 360) + 360) % 360,
      transfer: v.color_transfer ?? null,
      primaries: v.color_primaries ?? null,
      pix_fmt: v.pix_fmt ?? null,
      frames: v.nb_frames ? Number(v.nb_frames) : null,
    };
  }
  const audio = a
    ? {
        codec: a.codec_name ?? 'unknown',
        sample_rate: Number(a.sample_rate ?? 48_000),
        channels: a.channels ?? 2,
      }
    : null;
  return { format, kind: isImage ? 'image' : video ? 'video' : 'audio', duration, video, audio };
}

function rational(s?: string): { num: number; den: number } | null {
  if (!s) return null;
  const [n, d] = s.split('/').map(Number);
  if (!n || !d) return null;
  return { num: n, den: d };
}

/** Snaps measured rates (e.g. 29.97003) to the standard rational they mean. */
export function standardRate(r: { num: number; den: number }): { num: number; den: number } {
  const value = r.num / r.den;
  const standard = [
    { num: 24000, den: 1001 },
    { num: 24, den: 1 },
    { num: 25, den: 1 },
    { num: 30000, den: 1001 },
    { num: 30, den: 1 },
    { num: 48, den: 1 },
    { num: 50, den: 1 },
    { num: 60000, den: 1001 },
    { num: 60, den: 1 },
    { num: 120, den: 1 },
    { num: 15, den: 1 },
    { num: 12, den: 1 },
  ];
  // The nearest one: 30 and 29.97 are only 0.1% apart, so the first within tolerance can be wrong.
  const off = (s: { num: number; den: number }) => Math.abs(s.num / s.den - value) / value;
  const near = standard.reduce((a, b) => (off(b) < off(a) ? b : a));
  return off(near) < 0.002 ? near : { num: Math.max(1, Math.round(value)), den: 1 };
}

/** Why a file needs a mezzanine before MLT reads it frame-accurately. */
export function conformReasons(p: Probe): string[] {
  const v = p.video;
  if (!v || p.kind === 'image') return [];
  const reasons: string[] = [];
  if (v.vfr) reasons.push('vfr');
  if (v.rotation !== 0) reasons.push('rotation');
  if (v.transfer === 'smpte2084' || v.transfer === 'arib-std-b67') reasons.push('hdr');
  const native = [
    'h264',
    'hevc',
    'prores',
    'dnxhd',
    'mpeg2video',
    'mpeg4',
    'mjpeg',
    'vp8',
    'vp9',
    'av1',
    'ffv1',
    'rawvideo',
    'png',
    'qtrle',
    'cfhd',
  ];
  if (!native.includes(v.codec)) reasons.push('codec');
  return reasons;
}
