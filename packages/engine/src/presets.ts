import { CfError } from '@cuttingfloor/schema';

// Export presets: data, not tools. Each is a set of encoder settings written once and spoken two
// ways: as melt avformat consumer properties (the usual, single-pass export) and as FFmpeg
// arguments (the second pass a GIF or a frame-rate change needs).

// A preset names a format only. The picture comes out at the sequence's size and frame rate
// unless the overrides ask for another; no preset decides a size.
export const PRESET_NAMES = [
  'mp4_h264',
  'mp4_h264_fast',
  'mp4_av1',
  'mov_prores_422hq',
  'gif',
  'wav',
  'mp3',
] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface Overrides {
  /** Output box; one side keeps the picture's aspect, both fit it inside. */
  width?: number | undefined;
  height?: number | undefined;
  /** Output frame rate (frames are dropped or repeated; timing is kept). */
  fps?: number | undefined;
  /** Video bitrate, e.g. "8M", instead of the preset's quality setting. */
  bitrate?: string | undefined;
  /** Constant quality: x264 0–51, SVT-AV1 0–63. */
  crf?: number | undefined;
}

export interface PresetSpec {
  extension: string;
  mime: string;
  /** No picture: audio_* presets. */
  audioOnly?: boolean;
  /** Default output size for a sequence of w × h. */
  size: (w: number, h: number) => { width: number; height: number };
  /** Encoder settings, in melt's avformat property names. */
  settings: Record<string, string>;
  /** GIF: made by FFmpeg from a lossless pass, with its own palette. */
  gif?: { fps: number };
  /** Which quality setting `crf` maps to, and its range; absent: crf not allowed. */
  crf?: { max: number };
  /** Allows `bitrate`. */
  bitrate?: boolean;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** w × h scaled to fit a box (never up). */
export function fitBox(w: number, h: number, boxW: number, boxH: number) {
  const scale = Math.min(1, boxW / w, boxH / h);
  return { width: even(w * scale), height: even(h * scale) };
}

const BT709 = { color_primaries: 'bt709', color_trc: 'bt709', colorspace: '709' };

export const PRESETS: Record<PresetName, PresetSpec> = {
  mp4_h264: {
    extension: 'mp4',
    mime: 'video/mp4',
    size: (w, h) => ({ width: w, height: h }),
    settings: {
      vcodec: 'libx264',
      preset: 'medium',
      crf: '20',
      pix_fmt: 'yuv420p',
      g: '120',
      acodec: 'aac',
      ab: '192k',
      f: 'mp4',
      movflags: '+faststart',
      ...BT709,
    },
    crf: { max: 51 },
    bitrate: true,
  },
  // Quick and small, to watch a cut: sound kept, every frame kept, lower quality.
  mp4_h264_fast: {
    extension: 'mp4',
    mime: 'video/mp4',
    size: (w, h) => ({ width: w, height: h }),
    settings: {
      vcodec: 'libx264',
      preset: 'veryfast',
      crf: '28',
      pix_fmt: 'yuv420p',
      g: '60',
      acodec: 'aac',
      ab: '128k',
      f: 'mp4',
      movflags: '+faststart',
      ...BT709,
    },
    crf: { max: 51 },
    bitrate: true,
  },
  mp4_av1: {
    extension: 'mp4',
    mime: 'video/mp4',
    size: (w, h) => ({ width: w, height: h }),
    settings: {
      vcodec: 'libsvtav1',
      preset: '8',
      crf: '32',
      pix_fmt: 'yuv420p',
      g: '240',
      acodec: 'libopus',
      ab: '160k',
      f: 'mp4',
      movflags: '+faststart',
      ...BT709,
    },
    crf: { max: 63 },
    bitrate: true,
  },
  mov_prores_422hq: {
    extension: 'mov',
    mime: 'video/quicktime',
    size: (w, h) => ({ width: w, height: h }),
    settings: {
      vcodec: 'prores_ks',
      vprofile: '3',
      vendor: 'apl0',
      pix_fmt: 'yuv422p10le',
      acodec: 'pcm_s24le',
      f: 'mov',
      ...BT709,
    },
  },
  gif: {
    extension: 'gif',
    mime: 'image/gif',
    size: (w, h) => ({ width: w, height: h }),
    settings: {},
    gif: { fps: 15 },
  },
  wav: {
    extension: 'wav',
    mime: 'audio/wav',
    audioOnly: true,
    size: (w, h) => ({ width: w, height: h }),
    settings: { acodec: 'pcm_s24le', f: 'wav' },
  },
  mp3: {
    extension: 'mp3',
    mime: 'audio/mpeg',
    audioOnly: true,
    size: (w, h) => ({ width: w, height: h }),
    settings: { acodec: 'libmp3lame', ab: '320k', f: 'mp3' },
  },
};

/** The preset's settings with the overrides applied, and the output size. */
export function resolvePreset(
  name: PresetName,
  seq: { width: number; height: number },
  overrides: Overrides = {},
): { spec: PresetSpec; settings: Record<string, string>; width: number; height: number } {
  const spec = PRESETS[name];
  const refuse = (what: string) =>
    new CfError('bad_request', `${name} does not take ${what}`, {
      hint: `Overrides each preset takes: ${presetCatalog()
        .map((p) => `${p.name}: ${p.overrides.join(', ') || 'none'}`)
        .join('; ')}`,
    });
  if (spec.audioOnly && (overrides.width || overrides.height || overrides.fps)) {
    throw refuse('a picture size or frame rate');
  }
  const settings = { ...spec.settings };
  if (overrides.crf !== undefined) {
    if (!spec.crf) throw refuse('crf');
    if (overrides.crf > spec.crf.max) {
      throw new CfError('bad_request', `crf for ${name} goes up to ${spec.crf.max}`);
    }
    settings.crf = String(overrides.crf);
  }
  if (overrides.bitrate !== undefined) {
    if (!spec.bitrate) throw refuse('bitrate');
    delete settings.crf;
    settings.vb = overrides.bitrate;
  }
  let { width, height } = spec.size(seq.width, seq.height);
  if (overrides.width || overrides.height) {
    ({ width, height } = fitBox(
      seq.width * 100,
      seq.height * 100,
      overrides.width ?? Number.POSITIVE_INFINITY,
      overrides.height ?? Number.POSITIVE_INFINITY,
    ));
  }
  return { spec, settings, width, height };
}

/** Settings as melt avformat consumer arguments. */
export function meltArgs(settings: Record<string, string>): string[] {
  return Object.entries(settings).map(([k, v]) => `${k}=${v}`);
}

const FFMPEG: Record<string, string> = {
  vcodec: '-c:v',
  acodec: '-c:a',
  vb: '-b:v',
  ab: '-b:a',
  vprofile: '-profile:v',
  f: '-f',
};

/** Settings as FFmpeg output arguments. */
export function ffmpegArgs(settings: Record<string, string>): string[] {
  return Object.entries(settings).flatMap(([k, v]) => [
    FFMPEG[k] ?? `-${k}`,
    k === 'colorspace' && v === '709' ? 'bt709' : v,
  ]);
}

/** The catalogue entry for video://catalog/presets. */
export function presetCatalog() {
  return PRESET_NAMES.map((name) => {
    const p = PRESETS[name];
    return {
      name,
      extension: p.extension,
      mime_type: p.mime,
      audio_only: Boolean(p.audioOnly),
      overrides: [
        ...(p.audioOnly ? [] : ['width', 'height', 'fps']),
        ...(p.crf ? [`crf (0–${p.crf.max})`] : []),
        ...(p.bitrate ? ['bitrate'] : []),
      ],
      ...(p.gif ? { default_fps: p.gif.fps } : {}),
    };
  });
}
