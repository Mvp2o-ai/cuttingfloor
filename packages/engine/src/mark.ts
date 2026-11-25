import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfError } from '@cuttingfloor/schema';
import { BIN, heavyThreads, run } from './exec.ts';

// The cuttingfloor mark: what every exported picture carries until its clean copy is paid for.
// Pieces of the brand (wordmark, badge, ribbon, tiles, seal, stacked lockup) fade in and out at
// 25–35% opacity in a new spot every 4–6 s. They come from a 60-second alpha loop per canvas
// shape, built once from a fixed seed (scripts/build-mark.ts), so marking any length is one
// overlay pass; a still, a GIF or a clip too short for the loop gets one piece, held.

const ASSETS = fileURLToPath(new URL('../assets/mark/', import.meta.url));

interface Placement {
  piece: string;
  start: number;
  end: number;
  angle: number;
  size: number;
  opacity: number;
  zone: number;
}
interface Manifest {
  loop: number;
  fps: number;
  fade: number;
  pieces: Array<{ name: string; width: number; height: number; angles: number[] }>;
  loops: Record<string, { file: string; width: number; height: number; placements: Placement[] }>;
}

let manifest: Manifest | undefined;
function markAssets(): Manifest {
  manifest ??= JSON.parse(readFileSync(`${ASSETS}mark.json`, 'utf8')) as Manifest;
  return manifest;
}

/** Clips shorter than this get one held piece: the loop has gaps between its pieces. */
const SHORTEST_LOOPED = 8;

// The review copy's cards (scripts/build-cards.ts): before the video, that it is a review copy
// and making is free; after it, how to get the clean copy. Seconds each, and their fade.
export const REVIEW_CARDS = { open: 3, end: 4 } as const;
const CARD_FADE = 0.3;

export interface MarkOptions {
  /** Picks where the loop starts, or which piece a still gets (the file's id). */
  seed: string;
  /** Put the opening and end cards around a video (not a still, a GIF or one with alpha). */
  cards?: boolean;
  signal?: AbortSignal;
}

interface Stream {
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  nb_frames?: string;
  duration?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: Array<{ rotation?: number }>;
  tags?: Record<string, string>;
}

const STILL_FORMATS = ['png_pipe', 'jpeg_pipe', 'webp_pipe', 'tiff_pipe', 'bmp_pipe', 'image2'];

/**
 * Burns the cuttingfloor mark into a finished picture file: a video (with its sound copied), an
 * animated GIF or a still. The output keeps the input's container (by `output`'s extension,
 * which should be the input's), codec family, size, frame timing, pixel format and alpha.
 */
export async function burnMark(input: string, output: string, opts: MarkOptions): Promise<void> {
  const { signal } = opts;
  const { stdout } = await run(
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
      `file:${input}`,
    ],
    { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
  );
  const info = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string };
    streams?: Stream[];
  };
  const streams = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v?.width || !v.height) {
    throw new CfError('bad_request', 'The file has no picture to mark');
  }
  const formats = (info.format?.format_name ?? '').split(',');
  const codec = v.codec_name ?? '';
  const gif = codec === 'gif';
  const duration = Number(info.format?.duration ?? v.duration ?? Number.NaN);
  const still =
    !gif &&
    (formats.some((f) => STILL_FORMATS.includes(f)) ||
      (['png', 'mjpeg', 'webp', 'tiff', 'bmp'].includes(codec) && Number(v.nb_frames ?? 1) <= 1));
  // Frames come out of the decoder upright, so a phone's rotated clip is marked as it plays.
  const rotation = Math.abs(
    Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate) ||
      0,
  );
  const turned = rotation % 180 === 90;
  const width = turned ? v.height : v.width;
  const height = turned ? v.width : v.height;
  const alphaWebm = codec === 'vp9' || codec === 'vp8' ? v.tags?.alpha_mode === '1' : false;

  const rand = seeded(opts.seed);
  const looped = !still && !gif && duration >= SHORTEST_LOOPED;
  const args = ['-v', 'error', '-nostdin', '-y'];
  if (alphaWebm) args.push('-c:v', codec === 'vp9' ? 'libvpx-vp9' : 'libvpx');
  args.push('-i', `file:${input}`);

  let graph: string;
  if (looped) {
    const m = markAssets();
    const loop = m.loops[shapeOf(width, height)] as Manifest['loops'][string];
    // Start where a piece is fully in, so the first frame carries the mark.
    const first = loop.placements[Math.floor(rand() * loop.placements.length)] as Placement;
    const offset = first.start + m.fade;
    // Cover the frame: the loop's short side spans the frame's, so pieces keep their size.
    const k = Math.max(width / loop.width, height / loop.height);
    const sw = Math.max(width, even(Math.ceil(loop.width * k)));
    const sh = Math.max(height, even(Math.ceil(loop.height * k)));
    args.push(
      '-stream_loop',
      '-1',
      '-ss',
      offset.toFixed(3),
      '-c:v',
      'libvpx-vp9',
      '-i',
      `file:${ASSETS}${loop.file}`,
    );
    graph =
      `[1:v]setpts=PTS-STARTPTS,scale=${sw}:${sh}:flags=bicubic,crop=${width}:${height}[m];` +
      `[0:v][m]overlay=0:0:shortest=1:eof_action=pass${overlayFormat(v.pix_fmt)}`;
  } else {
    const piece = onePiece(rand, width, height);
    args.push('-loop', '1', '-i', `file:${ASSETS}pieces/${piece.name}.png`);
    graph =
      `[1:v]format=rgba,scale=${piece.w}:${piece.h}:flags=lanczos,` +
      `rotate=${piece.a}:ow=rotw(${piece.a}):oh=roth(${piece.a}):c=none,` +
      `colorchannelmixer=aa=${piece.opacity}[m];` +
      `[0:v][m]overlay=${piece.x}:${piece.y}:shortest=1${overlayFormat(v.pix_fmt)}`;
  }

  const ext = extname(output).toLowerCase();
  const enc = encoder(codec, v, ext, alphaWebm);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const cards =
    opts.cards &&
    !still &&
    !gif &&
    !alphaWebm &&
    !/^(yuva|rgba|argb|bgra|abgr|gbrap)/.test(v.pix_fmt ?? '');
  if (cards) {
    const shape = shapeOf(width, height);
    const rate = v.r_frame_rate && !v.r_frame_rate.startsWith('0') ? v.r_frame_rate : '25';
    const sar = /^[1-9]\d*:[1-9]\d*$/.test(v.sample_aspect_ratio ?? '')
      ? v.sample_aspect_ratio
      : '1';
    const card = (name: string, seconds: number, n: number) => {
      args.push(
        '-loop',
        '1',
        '-framerate',
        rate,
        '-t',
        String(seconds),
        '-i',
        `file:${ASSETS}cards/${name}-${shape}.png`,
      );
      return (
        `[${n}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x080A09,setsar=${sar},format=yuv420p,` +
        `fade=t=in:d=${CARD_FADE},fade=t=out:st=${seconds - CARD_FADE}:d=${CARD_FADE}[${name}]`
      );
    };
    graph += `,setsar=${sar}[main];${card('open', REVIEW_CARDS.open, 2)};${card('end', REVIEW_CARDS.end, 3)}`;
    if (audio) {
      const sr = Number(audio.sample_rate) || 48_000;
      const layout = audio.channel_layout ?? (audio.channels === 1 ? 'mono' : 'stereo');
      const quiet = (seconds: number, label: string) =>
        `anullsrc=r=${sr}:cl=${layout},atrim=duration=${seconds}[${label}]`;
      graph +=
        `;${quiet(REVIEW_CARDS.open, 'a0')};${quiet(REVIEW_CARDS.end, 'a2')}` +
        `;[0:a]aformat=sample_rates=${sr}:channel_layouts=${layout}[a1]` +
        `;[open][a0][main][a1][end][a2]concat=n=3:v=1:a=1[cv][ca]`;
    } else {
      graph += ';[open][main][end]concat=n=3:v=1:a=0[cv]';
    }
    graph += enc.tail ? `;[cv]${enc.tail}[v]` : ';[cv]null[v]';
  } else {
    graph += enc.tail ? `,${enc.tail}[v]` : '[v]';
  }
  args.push('-filter_complex', graph, '-map', '[v]');
  if (still) {
    args.push('-frames:v', '1', '-update', '1');
  } else if (cards) {
    // The cards' silence joins the sound, so it is encoded again, in the container's own codec.
    if (audio) args.push('-map', '[ca]', ...audioCodec(audio.codec_name ?? '', ext));
  } else {
    args.push('-map', '0:a?', '-c:a', 'copy', '-fps_mode', 'passthrough');
  }
  args.push('-map_metadata', '0', ...enc.args, ...colourArgs(v));
  args.push('-threads', String(heavyThreads()));
  if (['.mp4', '.mov', '.m4v'].includes(extname(output).toLowerCase())) {
    args.push('-movflags', '+faststart');
  }
  args.push(`file:${output}`);
  const seconds = Number.isFinite(duration) ? duration : 0;
  await run(BIN.ffmpeg, args, {
    heavy: true,
    timeoutMs: 120_000 + (seconds + REVIEW_CARDS.open + REVIEW_CARDS.end) * 10_000,
    ...(signal ? { signal } : {}),
  });
}

/** The canvas a loop or card is drawn for: landscape, portrait or square. */
function shapeOf(width: number, height: number): 'landscape' | 'portrait' | 'square' {
  const aspect = width / height;
  return aspect > 1.2 ? 'landscape' : aspect < 1 / 1.2 ? 'portrait' : 'square';
}

/** Sound encoded again (after the cards join it): PCM stays PCM, else the container's codec. */
function audioCodec(codec: string, ext: string): string[] {
  if (codec.startsWith('pcm_')) return ['-c:a', codec];
  if (ext === '.webm') return ['-c:a', 'libopus', '-b:a', '192k'];
  return ['-c:a', 'aac', '-b:a', '256k'];
}

/** One piece for a still, a GIF or a short clip: which, how big, at what angle, where. */
function onePiece(rand: () => number, width: number, height: number) {
  const m = markAssets();
  const def = m.pieces[Math.floor(rand() * m.pieces.length)] as Manifest['pieces'][number];
  const short = Math.min(width, height);
  const size = 0.22 + rand() * 0.12;
  const k = (size * short) / Math.sqrt(def.width * def.height);
  const w = even(def.width * k);
  const h = even(def.height * k);
  const angle = def.angles[Math.floor(rand() * def.angles.length)] ?? 0;
  const a = (angle * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
  const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  const zone = Math.floor(rand() * 9);
  const mx = width * 0.06;
  const my = height * 0.06;
  const cx = mx + ((width - 2 * mx) * ((zone % 3) + 0.5)) / 3;
  const cy = my + ((height - 2 * my) * (Math.floor(zone / 3) + 0.5)) / 3;
  const x = Math.round(clamp(cx - bw / 2, Math.min(mx, width - bw), width - mx - bw));
  const y = Math.round(clamp(cy - bh / 2, Math.min(my, height - bh), height - my - bh));
  const opacity = (0.25 + rand() * 0.1).toFixed(3);
  return { name: def.name, w, h, a: a.toFixed(5), x: Math.max(0, x), y: Math.max(0, y), opacity };
}

/** Overlay in the main picture's own family: RGB for RGB, else its YUV layout. */
function overlayFormat(pixFmt: string | undefined): string {
  const p = pixFmt ?? '';
  if (/^(rgb|bgr|argb|abgr|rgba|bgra|gbr|pal8|gray|ya)/.test(p)) return ':format=rgb';
  if (/^yuva?444/.test(p)) return ':format=yuv444';
  if (/^yuva?422/.test(p)) return ':format=yuv422';
  if (/^yuva?420p1\d/.test(p)) return ':format=yuv420p10';
  return ':format=yuv420';
}

interface Encoder {
  args: string[];
  /** Filters after the overlay (a pixel format, a GIF palette). */
  tail?: string;
}

const PRORES_PROFILES: Record<string, string> = {
  Proxy: '0',
  LT: '1',
  Standard: '2',
  HQ: '3',
  '4444': '4',
  '4444 XQ': '5',
};

/** The same codec family as the input, at a quality that keeps the picture. */
function encoder(codec: string, v: Stream, ext: string, alphaWebm: boolean): Encoder {
  const pix = v.pix_fmt ?? '';
  const keep = (allowed: string[], fallback: string) =>
    `format=${allowed.includes(pix) ? pix : fallback}`;
  switch (codec) {
    case 'h264':
      return {
        args: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-tag:v', 'avc1'],
        tail: keep(
          ['yuv420p', 'yuvj420p', 'yuv422p', 'yuv444p', 'yuv420p10le', 'yuv422p10le'],
          'yuv420p',
        ),
      };
    case 'hevc':
      return {
        args: [
          '-c:v',
          'libx265',
          '-preset',
          'fast',
          '-crf',
          '18',
          '-tag:v',
          v.codec_tag_string === 'hev1' ? 'hev1' : 'hvc1',
          '-x265-params',
          'log-level=error',
        ],
        tail: keep(['yuv420p', 'yuv422p', 'yuv444p', 'yuv420p10le', 'yuv422p10le'], 'yuv420p'),
      };
    case 'prores': {
      const profile = PRORES_PROFILES[v.profile ?? ''] ?? '3';
      const alpha = pix.startsWith('yuva');
      return {
        args: ['-c:v', 'prores_ks', '-profile:v', profile, '-vendor', 'apl0'],
        tail: `format=${Number(profile) >= 4 ? (alpha ? 'yuva444p10le' : 'yuv444p10le') : 'yuv422p10le'}`,
      };
    }
    case 'vp9':
      return {
        args: [
          '-c:v',
          'libvpx-vp9',
          '-crf',
          '24',
          '-b:v',
          '0',
          '-deadline',
          'good',
          '-cpu-used',
          '3',
          '-row-mt',
          '1',
          ...(alphaWebm ? ['-auto-alt-ref', '0'] : []),
        ],
        tail: alphaWebm ? 'format=yuva420p' : keep(['yuv420p', 'yuv420p10le'], 'yuv420p'),
      };
    case 'vp8':
      return {
        args: [
          '-c:v',
          'libvpx',
          '-crf',
          '6',
          '-b:v',
          '40M',
          ...(alphaWebm ? ['-auto-alt-ref', '0'] : []),
        ],
        tail: alphaWebm ? 'format=yuva420p' : 'format=yuv420p',
      };
    case 'av1':
      return {
        args: ['-c:v', 'libsvtav1', '-crf', '24', '-preset', '8'],
        tail: keep(['yuv420p', 'yuv420p10le'], 'yuv420p'),
      };
    case 'gif':
      return {
        args: ['-c:v', 'gif', '-loop', '0', '-f', 'gif'],
        tail:
          'split[g1][g2];[g1]palettegen=stats_mode=full:reserve_transparent=1[pal];' +
          '[g2][pal]paletteuse=dither=sierra2_4a:alpha_threshold=128',
      };
    case 'png': {
      const alpha = /a|^pal8/.test(pix.replace(/^(gray|yuv)/, ''));
      const deep = /(48|64|16)/.test(pix);
      return {
        args: ['-c:v', 'png', '-f', 'image2'],
        tail: `format=${alpha ? (deep ? 'rgba64be' : 'rgba') : deep ? 'rgb48be' : 'rgb24'}`,
      };
    }
    case 'mjpeg':
      return {
        args: ['-c:v', 'mjpeg', '-q:v', '2', '-f', ext === '.mov' ? 'mov' : 'image2'],
        tail: keep(['yuvj420p', 'yuvj422p', 'yuvj444p'], 'yuvj420p'),
      };
    case 'webp': {
      const alpha = /a/.test(pix.replace(/^yuv/, 'x'));
      const lossless = /^(argb|bgra|rgba)$/.test(pix);
      return {
        args: [
          '-c:v',
          'libwebp',
          ...(lossless ? ['-lossless', '1'] : ['-quality', '92']),
          '-f',
          'image2',
        ],
        tail: `format=${lossless ? 'bgra' : alpha ? 'yuva420p' : 'yuv420p'}`,
      };
    }
    case 'tiff':
      return { args: ['-c:v', 'tiff', '-f', 'image2'], tail: keep(['rgb24', 'rgba'], 'rgb24') };
    case 'bmp':
      return { args: ['-c:v', 'bmp', '-f', 'image2'], tail: 'format=bgr24' };
    default:
      throw new CfError('bad_request', `A ${codec || 'unknown'} picture cannot be marked`, {
        hint: 'Marking takes H.264, HEVC, ProRes, VP8/VP9, AV1, GIF, PNG, JPEG, WebP, TIFF or BMP',
      });
  }
}

/** The input's colour tags, so the marked file plays with the same colours. */
function colourArgs(v: Stream): string[] {
  const out: string[] = [];
  // RGB pictures (PNG, GIF, TIFF) carry no YUV colour tags.
  if (!(v.pix_fmt ?? '').startsWith('yuv')) return out;
  const tag = (flag: string, value: string | undefined) => {
    if (value && value !== 'unknown' && value !== 'reserved') out.push(flag, value);
  };
  tag('-color_primaries', v.color_primaries);
  tag('-color_trc', v.color_transfer);
  tag('-colorspace', v.color_space);
  tag('-color_range', v.color_range);
  return out;
}

/** A repeatable random sequence from a string. */
function seeded(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function even(n: number) {
  return Math.max(2, Math.round(n / 2) * 2);
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
