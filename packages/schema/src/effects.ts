import * as z from 'zod/v4';
import { animatable } from './compositing.ts';
import { MediaId } from './ids.ts';

// The effect registry: every effect an agent can apply, with typed parameters. Tools take a
// name and a params object checked against this at run time (so tool definitions stay
// small); video://catalog/effects lists it. Numbers marked animatable take keyframes.

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
    params: { radius: num(0, 0.2, 0.01, 'Fraction of the frame height') },
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
    about: 'Reduce video noise',
    params: { strength: num(0, 10, 3, 'Spatial denoise strength', false) },
  },
  chroma_key: {
    kind: 'video',
    about: 'Make a colour (green or blue screen) transparent',
    params: {
      color: { kind: 'colour', default: '#00FF00', about: 'The screen colour' },
      tolerance: num(0, 1, 0.2, 'How far from the colour still keys out', false),
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
} satisfies Record<string, EffectSpec>;

export type EffectName = keyof typeof EFFECTS;
export const EFFECT_NAMES = Object.keys(EFFECTS) as EffectName[];

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
