import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfError } from '@cuttingfloor/schema';
import { CARD_QR, writeCardQr } from './card-qr.ts';
import { BIN, heavyThreads, run } from './exec.ts';

// The cuttingfloor mark: what every exported picture carries until its clean copy is paid for.
// One translucent card (scripts/build-mark.ts) drifts slowly across the picture and bounces off
// its edges. Its path is simulated per file from the seed: at each bounce the card takes another
// size and tilt, its speed changes and its angle is knocked off true, so no formula or other file
// predicts where it goes, and a grain that changes every frame keeps its pixels from being known
// exactly. A still gets the card once, somewhere.

const ASSETS = fileURLToPath(new URL('../assets/mark/', import.meta.url));
const CARD = { file: `${ASSETS}card.png`, width: 1200, height: 440 };
/** The sizes and tilts a file's card takes, one at a time, a different one after each bounce. */
const LOOKS = 5;

// The review copy's cards (scripts/build-cards.ts): before the video, that it is a review copy
// and making is free; after it, how to get the clean copy. Seconds each, and their fade.
export const REVIEW_CARDS = { open: 3, end: 4 } as const;
const CARD_FADE = 0.3;

export interface MarkOptions {
  /** Picks where the loop starts, or which piece a still gets (the file's id). */
  seed: string;
  /** Put the opening and end cards around a video (not a still, a GIF or one with alpha). */
  cards?: boolean;
  /** With cards: the link their QR code opens (the file's release page). */
  qr?: string;
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
  const args = ['-v', 'error', '-nostdin', '-y'];
  if (alphaWebm) args.push('-c:v', codec === 'vp9' ? 'libvpx-vp9' : 'libvpx');
  args.push('-i', `file:${input}`);

  const moving = !still && Number.isFinite(duration) && duration > 0;
  const looks = cardLooks(rand, width, height);
  const path = moving
    ? bounces(rand, width, height, duration, looks)
    : [still1(rand, width, height, looks)];
  const used = [...new Set(path.map((s) => s.look))];
  const rate = v.r_frame_rate && !v.r_frame_rate.startsWith('0') ? v.r_frame_rate : '25';
  args.push('-loop', '1', '-framerate', rate, '-i', `file:${CARD.file}`);
  // Grain on the card's colour, new every frame; its alpha stays clean.
  let graph =
    `[1:v]format=gbrap,noise=c0s=14:c1s=14:c2s=14:c0f=t:c1f=t:c2f=t:all_seed=${Math.floor(rand() * 1e6)}` +
    `,split=${used.length}${used.map((i) => `[c${i}]`).join('')};`;
  for (const i of used) {
    const l = looks[i] as Look;
    graph +=
      `[c${i}]scale=${l.w}:${l.h}:flags=bicubic,` +
      `rotate=${l.angle.toFixed(5)}:ow=${l.bw}:oh=${l.bh}:c=none,colorchannelmixer=aa=${l.opacity}[m${i}];`;
  }
  let last = '0:v';
  used.forEach((i, n) => {
    const mine = path.filter((s) => s.look === i);
    const on = mine.map((s) => `gte(t,${s.t0})*lt(t,${s.t1})`).join('+');
    const at = (p: 'x' | 'y') =>
      mine
        .map((s) => {
          const v0 = p === 'x' ? s.x : s.y;
          const dv = p === 'x' ? s.vx : s.vy;
          return `gte(t,${s.t0})*lt(t,${s.t1})*(${v0}${dv ? `+${dv}*(t-${s.t0})` : ''})`;
        })
        .join('+');
    const out = n === used.length - 1 ? '' : `[o${n}]`;
    graph +=
      `[${last}][m${i}]overlay=x='${at('x')}':y='${at('y')}'` +
      `${moving ? `:enable='${on}'` : ''}:shortest=1:eof_action=pass${overlayFormat(v.pix_fmt)}${out}` +
      (out ? ';' : '');
    last = `o${n}`;
  });

  const ext = extname(output).toLowerCase();
  const enc = encoder(codec, v, ext, alphaWebm);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const cards =
    opts.cards &&
    !still &&
    !gif &&
    !alphaWebm &&
    !/^(yuva|rgba|argb|bgra|abgr|gbrap)/.test(v.pix_fmt ?? '');
  const qrFile = cards && opts.qr ? `${output}.qr.ppm` : undefined;
  if (cards) {
    const shape = shapeOf(width, height);
    const box = CARD_QR[shape];
    if (qrFile && opts.qr) await writeCardQr(opts.qr, box.size, qrFile);
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
        `file:${ASSETS}cards/${name}-${shape}${qrFile ? '-qr' : ''}.png`,
      );
      return (
        `[${n}:v]${qrFile ? `[q${name}]overlay=${box.x}:${box.y},` : ''}scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x080A09,setsar=${sar},format=yuv420p,` +
        `fade=t=in:d=${CARD_FADE},fade=t=out:st=${seconds - CARD_FADE}:d=${CARD_FADE}[${name}]`
      );
    };
    graph += `,setsar=${sar}[main];${card('open', REVIEW_CARDS.open, 2)};${card('end', REVIEW_CARDS.end, 3)}`;
    if (qrFile) {
      args.push('-i', `file:${qrFile}`);
      graph += ';[4:v]format=rgb24,split=2[qopen][qend]';
    }
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
  // A long file's path is a long graph: it goes in a file, past the limit on one argument.
  const graphFile = `${output}.graph.txt`;
  await writeFile(graphFile, graph);
  args.push('-/filter_complex', graphFile, '-map', '[v]');
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
  try {
    await run(BIN.ffmpeg, args, {
      heavy: true,
      timeoutMs: 120_000 + (seconds + REVIEW_CARDS.open + REVIEW_CARDS.end) * 10_000,
      ...(signal ? { signal } : {}),
    });
  } finally {
    await rm(graphFile, { force: true });
    if (qrFile) await rm(qrFile, { force: true });
  }
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

interface Look {
  /** The card's size, then the box it takes up tilted. */
  w: number;
  h: number;
  bw: number;
  bh: number;
  /** Radians. */
  angle: number;
  opacity: string;
}

/** The card's sizes and tilts for this file: its width about half to nine tenths of the short side. */
function cardLooks(rand: () => number, width: number, height: number): Look[] {
  const short = Math.min(width, height);
  return Array.from({ length: LOOKS }, (_, i) => {
    // Spread over the range, so a bounce visibly changes the size.
    const share = 0.42 + ((i + rand()) / LOOKS) * 0.36;
    const w = even(Math.min(share * short * 1.15, width * 0.86));
    const h = even((w * CARD.height) / CARD.width);
    const angle = ((rand() < 0.5 ? -1 : 1) * (1.5 + rand() * 6.5) * Math.PI) / 180;
    const bw = even(Math.abs(w * Math.cos(angle)) + Math.abs(h * Math.sin(angle)) + 2);
    const bh = even(Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle)) + 2);
    return { w, h, bw, bh, angle, opacity: (0.55 + rand() * 0.12).toFixed(3) };
  });
}

interface Segment {
  t0: number;
  t1: number;
  look: number;
  /** Top left at t0, and pixels a second. */
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The card's flight over `duration` seconds: straight runs between bounces. It crosses the frame
 * in 18–30 s; at each wall it turns back, takes another look (kept against that wall), a new
 * speed, and an angle knocked up to 18° off the mirror, never flatter than 20° to an edge.
 */
function bounces(
  rand: () => number,
  width: number,
  height: number,
  duration: number,
  looks: Look[],
): Segment[] {
  const diag = Math.hypot(width, height);
  const speed = () => diag / (18 + rand() * 12);
  let look = Math.floor(rand() * looks.length);
  let l = looks[look] as Look;
  let x = rand() * Math.max(0, width - l.bw);
  let y = rand() * Math.max(0, height - l.bh);
  let theta = ((20 + rand() * 50) * Math.PI) / 180;
  let sx = rand() < 0.5 ? -1 : 1;
  let sy = rand() < 0.5 ? -1 : 1;
  let s = speed();
  const out: Segment[] = [];
  let t = 0;
  // A run is at least a frame or so; the cap only guards a degenerate frame.
  while (t < duration && out.length < 20_000) {
    const vx = sx * s * Math.cos(theta);
    const vy = sy * s * Math.sin(theta);
    const room = { x: Math.max(0, width - l.bw), y: Math.max(0, height - l.bh) };
    const tx = vx > 0 ? (room.x - x) / vx : x / -vx;
    const ty = vy > 0 ? (room.y - y) / vy : y / -vy;
    const dt = Math.max(0.05, Math.min(tx, ty));
    const end = t + dt >= duration ? duration + 1 : t + dt;
    out.push({
      t0: round3(t),
      t1: round3(end),
      look,
      x: Math.round(x),
      y: Math.round(y),
      vx: round3(vx),
      vy: round3(vy),
    });
    if (end > duration) break;
    x += vx * dt;
    y += vy * dt;
    const hitX = tx <= ty + 1e-6;
    const hitY = ty <= tx + 1e-6;
    if (hitX) sx = -sx;
    if (hitY) sy = -sy;
    let next = look;
    while (next === look) next = Math.floor(rand() * looks.length);
    look = next;
    l = looks[look] as Look;
    const rx = Math.max(0, width - l.bw);
    const ry = Math.max(0, height - l.bh);
    // Kept against the wall it hit; the other way, where it was, inside the frame.
    x = hitX ? (sx > 0 ? 0 : rx) : clamp(x, 0, rx);
    y = hitY ? (sy > 0 ? 0 : ry) : clamp(y, 0, ry);
    const nudge = ((rand() - 0.5) * 36 * Math.PI) / 180;
    theta = clamp(theta + nudge, (20 * Math.PI) / 180, (70 * Math.PI) / 180);
    s = speed();
    t += dt;
  }
  return out;
}

/** A still's card: one look, somewhere inside a 6% margin. */
function still1(rand: () => number, width: number, height: number, looks: Look[]): Segment {
  const look = Math.floor(rand() * looks.length);
  const l = looks[look] as Look;
  const spot = (side: number, box: number) => {
    const m = Math.min(side * 0.06, Math.max(0, (side - box) / 2));
    return Math.round(m + rand() * Math.max(0, side - box - 2 * m));
  };
  return { t0: 0, t1: 1, look, x: spot(width, l.bw), y: spot(height, l.bh), vx: 0, vy: 0 };
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
