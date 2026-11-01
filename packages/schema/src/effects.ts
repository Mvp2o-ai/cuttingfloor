import * as z from 'zod/v4';
import { animatable } from './compositing.ts';
import { MediaId } from './ids.ts';

// The effect registry: every effect an agent can apply, with typed parameters. Tools take a
// name and a params object checked against this at run time (so tool definitions stay
// small); video://catalog/effects lists it, and errors list the names and params inline.
// Numbers marked animatable take keyframes.

type Num = {
  kind: 'number';
  min: number;
  max: number;
  default: number;
  animatable?: boolean;
  about: string;
};
type Choice = { kind: 'choice'; values: readonly string[]; default: string; about: string };
type Colour = { kind: 'colour'; default: string; about: string };
type Media = { kind: 'media'; about: string };
export type ParamSpec = Num | Choice | Colour | Media;

export interface EffectSpec {
  kind: 'video' | 'audio';
  about: string;
  params: Record<string, ParamSpec>;
  /**
   * Runs over the clip's whole source file before a render (an FFmpeg filter MLT cannot run
   * frame by frame), so it goes on media clips only.
   */
  sourcePass?: true;
}

const num = (min: number, max: number, def: number, about: string, animated = true): Num => ({
  kind: 'number',
  min,
  max,
  default: def,
  animatable: animated,
  about,
});

export const CURVE_PRESETS = [
  'color_negative',
  'cross_process',
  'darker',
  'increase_contrast',
  'lighter',
  'linear_contrast',
  'medium_contrast',
  'negative',
  'strong_contrast',
  'vintage',
] as const;

export const EFFECTS = {
  // Colour
  brightness_contrast: {
    kind: 'video',
    about: 'Brightness and contrast',
    params: {
      brightness: num(-1, 1, 0, 'Added to every pixel, -1 to 1'),
      contrast: num(0, 3, 1, 'Multiplier around mid-grey'),
    },
  },
  saturation: {
    kind: 'video',
    about: 'Colour intensity',
    params: { amount: num(0, 3, 1, '0 is grey, 1 unchanged') },
  },
  exposure: {
    kind: 'video',
    about: 'Exposure in stops',
    params: { stops: num(-3, 3, 0, 'Photographic stops') },
  },
  temperature: {
    kind: 'video',
    about: 'White balance: lower is cooler (blue), higher warmer (orange)',
    params: { kelvin: num(1000, 40000, 6500, 'Colour temperature; 6500 is neutral') },
  },
  hue: {
    kind: 'video',
    about: 'Rotate every hue',
    params: { degrees: num(-180, 180, 0, 'Hue rotation') },
  },
  vibrance: {
    kind: 'video',
    about: 'Saturation that spares skin tones and already-saturated colours',
    params: { amount: num(-2, 2, 0, 'Negative mutes, positive boosts') },
  },
  curves: {
    kind: 'video',
    about: 'Tone curve presets (looks)',
    params: {
      preset: {
        kind: 'choice',
        values: CURVE_PRESETS,
        default: 'medium_contrast',
        about: 'The look',
      },
    },
  },
  lut: {
    kind: 'video',
    about: 'A 3D LUT (.cube) imported with media.import',
    params: { media_id: { kind: 'media', about: 'The imported .cube file' } },
  },
  grayscale: { kind: 'video', about: 'Black and white', params: {} },
  sepia: { kind: 'video', about: 'Warm monochrome', params: {} },
  invert: { kind: 'video', about: 'Negative image', params: {} },
  // Detail and texture
  blur: {
    kind: 'video',
    about: 'Gaussian blur',
    params: {
      radius: num(
        0,
        0.2,
        0.01,
        'Fraction of the frame height; the Gaussian sigma is half of it (0.02 on 1080p is about 11 px)',
      ),
    },
  },
  sharpen: {
    kind: 'video',
    about: 'Contrast-adaptive sharpening',
    params: { amount: num(0, 1, 0.5, '0 to 1') },
  },
  vignette: {
    kind: 'video',
    about: 'Darkened edges',
    params: { amount: num(0, 1, 0.5, '0 to 1') },
  },
  grain: {
    kind: 'video',
    about: 'Film grain',
    params: { amount: num(0, 100, 20, 'Noise strength') },
  },
  chromatic_aberration: {
    kind: 'video',
    about: 'Red and blue split apart horizontally',
    params: { offset: num(0, 0.02, 0.004, 'Fraction of the frame width') },
  },
  pixelate: {
    kind: 'video',
    about: 'Mosaic blocks',
    params: { size: num(0.002, 0.2, 0.02, 'Block size, fraction of the frame width') },
  },
  glitch: {
    kind: 'video',
    about: 'Jittering colour split and noise, different every few frames',
    params: { amount: num(0, 1, 0.5, '0 to 1', false) },
  },
  denoise: {
    kind: 'video',
    about: 'Reduce grain and noise in the picture (for sound: noise_reduction or voice_denoise)',
    params: { strength: num(0, 10, 3, 'Spatial denoise strength', false) },
  },
  chroma_key: {
    kind: 'video',
    about: 'Make a colour (green or blue screen) transparent',
    params: {
      color: { kind: 'colour', default: '#00FF00', about: 'The screen colour' },
      tolerance: num(
        0,
        1,
        0.2,
        'How far a pixel may be from color and still key out, compared on colour alone (brightness ignored, so shadows on the screen key too): 0 the exact colour only, 1 almost everything',
        false,
      ),
    },
  },
  // Audio
  equalizer: {
    kind: 'audio',
    about: 'Three-band EQ',
    params: {
      low_db: num(-24, 24, 0, 'Below about 100 Hz', false),
      mid_db: num(-24, 24, 0, 'Around 1 kHz', false),
      high_db: num(-24, 24, 0, 'Above about 8 kHz', false),
    },
  },
  compressor: {
    kind: 'audio',
    about: 'Evens out loud and quiet parts',
    params: {
      threshold_db: num(-60, 0, -18, 'Level above which it compresses', false),
      ratio: num(1, 20, 4, 'Compression ratio', false),
      makeup_db: num(0, 24, 0, 'Gain after compression', false),
    },
  },
  noise_reduction: {
    kind: 'audio',
    about: 'Reduce steady background noise (hiss, hum, room tone)',
    params: { amount_db: num(0, 97, 12, 'Noise reduction in dB', false) },
  },
  voice_denoise: {
    kind: 'audio',
    about:
      "Clean background noise out of speech with a neural model (RNNoise): fans, hum, traffic, keyboards, room noise. On audio clips only, not tracks or the timeline: it cleans the clip's whole source once, on the first render that plays it, and reuses that after (roughly a minute of sound a second). For steady hiss under music, noise_reduction",
    sourcePass: true,
    params: {
      keep: {
        kind: 'choice',
        values: ['voice', 'speech'],
        default: 'voice',
        about: 'voice: speech plus laughs, breaths and other human sounds; speech: words only',
      },
      mix: num(0, 1, 1, '1 is fully cleaned; lower blends the original back in', false),
    },
  },
  de_esser: {
    kind: 'audio',
    about: 'Soften harsh s sounds',
    params: { amount: num(0, 1, 0.5, '0 to 1', false) },
  },
  dialogue_enhance: {
    kind: 'audio',
    about: 'Lift speech above the background',
    params: { amount: num(0, 3, 1, 'Enhancement', false) },
  },
  reverb: {
    kind: 'audio',
    about: 'Room ambience',
    params: { amount: num(0, 1, 0.3, '0 to 1', false) },
  },
  echo: {
    kind: 'audio',
    about: 'Repeating echo',
    params: {
      delay_ms: num(20, 2000, 300, 'Time between repeats', false),
      decay: num(0, 0.9, 0.4, 'How much each repeat keeps', false),
    },
  },
  pitch: {
    kind: 'audio',
    about: 'Shift pitch without changing speed (voice effects: +7 chipmunk, -7 deep)',
    params: { semitones: num(-12, 12, 0, 'Semitones', false) },
  },
  highpass: {
    kind: 'audio',
    about: 'Cut rumble below a frequency',
    params: { frequency: num(20, 2000, 80, 'Hz', false) },
  },
  lowpass: {
    kind: 'audio',
    about: 'Cut hiss above a frequency',
    params: { frequency: num(200, 20000, 8000, 'Hz', false) },
  },
  telephone: { kind: 'audio', about: 'Narrow-band phone voice', params: {} },
  dereverb: {
    kind: 'audio',
    about:
      "Take room echo out of speech (weighted prediction error, WPE): the echo tail each moment's recent past predicts is subtracted; the voice and the first few hundredths of a second of the room stay. One microphone: on a 0.5 s room it takes the echo between words down by about 4 dB, so it softens a room rather than removing it. On audio clips only, not tracks or the timeline: it works through the clip's whole source once, on the first render that plays it (a minute of voice in about 15 s; twice that for true stereo), and reuses that after",
    sourcePass: true,
    params: {
      reach_ms: num(
        60,
        400,
        250,
        'How far back the echo is predicted from, in milliseconds: longer reaches a longer tail and costs more time',
        false,
      ),
      mix: num(0, 1, 1, '1 is fully processed; lower blends the original back in', false),
    },
  },
  // Lens, motion and channels
  lens_correction: {
    kind: 'video',
    about:
      'Straighten lines a lens bends (FFmpeg lenscorrection): each pixel is moved along the line from the centre by k1 r² + k2 r⁴, r its distance from the centre over half the frame diagonal. Negative k1 pulls out a barrel or fisheye bulge, positive a pincushion. Edges left with nothing to show are black (clip.set_transform scale hides them)',
    params: {
      k1: num(-1, 1, 0, 'Quadratic term, -1 to 1; 0 is no change'),
      k2: num(-1, 1, 0, 'Fourth-power term, -1 to 1, for the far edges; 0 is no change'),
      center_x: num(0, 1, 0.5, 'Lens centre across, fraction of the width', false),
      center_y: num(0, 1, 0.5, 'Lens centre down, fraction of the height', false),
    },
  },
  directional_blur: {
    kind: 'video',
    about:
      'Blur along one direction, like fast camera or subject motion (FFmpeg dblur); keyframe radius up and down across a cut for a whip pan',
    params: {
      angle: num(0, 360, 0, 'Direction of the streaks in degrees: 0 left-right, 90 up-down'),
      radius: num(
        0,
        0.5,
        0.02,
        'How far the streaks reach each way, fraction of the frame width (they fade to half by about there)',
      ),
    },
  },
  channels: {
    kind: 'audio',
    about:
      'Route the input channels to the left and right outputs: a voice recorded on one side to both (left: left, right: left), a swap (left: right, right: left), a downmix to mono (both mix)',
    params: {
      left: {
        kind: 'choice',
        values: ['left', 'right', 'mix', 'silent'],
        default: 'left',
        about: 'What the left output plays: an input channel, both mixed half and half, or nothing',
      },
      right: {
        kind: 'choice',
        values: ['left', 'right', 'mix', 'silent'],
        default: 'right',
        about: 'What the right output plays',
      },
    },
  },
} satisfies Record<string, EffectSpec>;

export type EffectName = keyof typeof EFFECTS;
export const EFFECT_NAMES = Object.keys(EFFECTS) as EffectName[];

/** Every effect name, by kind: what an error about an unknown effect lists. */
export function effectNamesText(): string {
  const of = (kind: 'video' | 'audio') =>
    EFFECT_NAMES.filter((n) => (EFFECTS as Record<string, EffectSpec>)[n]?.kind === kind).join(
      ', ',
    );
  return `Video effects: ${of('video')}. Audio effects: ${of('audio')}`;
}

/**
 * One effect's params with their ranges, units, defaults and whether they take keyframes, as
 * an error about a param lists them (so no catalogue read is needed to fix the call).
 */
export function effectParamsText(name: string): string {
  const spec = (EFFECTS as Record<string, EffectSpec>)[name];
  if (!spec) return effectNamesText();
  const params = Object.entries(spec.params).map(([key, p]) => {
    if (p.kind === 'number')
      return `${key}: ${p.min} to ${p.max}, default ${p.default} (${p.about}${p.animatable ? '; takes keyframes' : ''})`;
    if (p.kind === 'choice')
      return `${key}: one of ${p.values.join(', ')}, default ${p.default} (${p.about})`;
    if (p.kind === 'colour') return `${key}: #RRGGBB, default ${p.default} (${p.about})`;
    return `${key}: a media_id, required (${p.about})`;
  });
  return params.length
    ? `${name} (${spec.kind}) takes ${params.join('; ')}`
    : `${name} (${spec.kind}) takes no params`;
}

/** An effect's params with every default filled in: what it actually applies. */
export function effectParamsApplied(
  name: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const spec = (EFFECTS as Record<string, EffectSpec>)[name];
  if (!spec) return params;
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(spec.params)) {
    if (params[key] !== undefined) out[key] = params[key];
    else if ('default' in p) out[key] = p.default;
  }
  for (const [key, v] of Object.entries(params)) if (!(key in out)) out[key] = v;
  return out;
}

/** A stored effect: params hold constants or stored animatables (source ticks). */
export const StoredEffect = z.object({
  id: z.string(),
  name: z.string(),
  params: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
});
export type StoredEffect = z.infer<typeof StoredEffect>;

/** Checks params for an effect: unknown names and values fail with what is allowed. */
export function effectParamsSchema(name: string): z.ZodType | undefined {
  const spec = (EFFECTS as Record<string, EffectSpec>)[name];
  if (!spec) return undefined;
  const shape: Record<string, z.ZodType> = {};
  for (const [key, p] of Object.entries(spec.params)) {
    if (p.kind === 'number')
      shape[key] = (
        p.animatable ? animatable(p.min, p.max) : z.number().min(p.min).max(p.max)
      ).optional();
    else if (p.kind === 'choice') shape[key] = z.enum(p.values as [string, ...string[]]).optional();
    else if (p.kind === 'colour')
      shape[key] = z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional();
    else shape[key] = MediaId;
  }
  return z.strictObject(shape);
}
