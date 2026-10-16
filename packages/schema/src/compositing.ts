import * as z from 'zod/v4';

// Clip compositing: animatable numbers, transforms, blend modes, masks and animation presets.
// Tools speak frames relative to the clip's first frame; the stored document keeps keyframe
// times as source ticks, so keyframes stay on their content through trims and splits.

const FAMILIES = [
  'sine',
  'quad',
  'cubic',
  'quart',
  'quint',
  'expo',
  'circ',
  'back',
  'elastic',
  'bounce',
] as const;
const DIRECTIONS = ['in', 'out', 'in_out'] as const;
export const EASES = [
  'linear',
  'hold',
  'smooth',
  ...FAMILIES.flatMap((f) => DIRECTIONS.map((d) => `${f}_${d}` as const)),
] as const;
export const Ease = z.enum(EASES);
export type Ease = z.infer<typeof Ease>;

/**
 * Ease at the tool interface: a plain string checked against EASES, so the 34 names aren't
 * repeated in every animatable field of every tool definition (video://catalog/eases).
 */
const EaseName = z
  .string()
  .refine((v) => (EASES as readonly string[]).includes(v), {
    message: `Unknown ease; use one of video://catalog/eases (${EASES.slice(0, 6).join(', ')}, ...)`,
  })
  .transform((v) => v as Ease);

const MAX_KEYFRAMES = 1000;

/**
 * An animatable number at the tool interface: a constant, keyframes in clip frames, or null to
 * reset. Limits are checked at run time rather than spelled out in the JSON schema, since this
 * shape repeats in every animatable field of every tool definition.
 */
export function animatable(min: number, max: number) {
  const inRange = (v: number) => v >= min && v <= max;
  const message = `must be between ${min} and ${max}`;
  return z.union([
    z.number().refine(inRange, { message }),
    z.object({
      keyframes: z
        .array(
          z.object({
            frame: z
              .number()
              .refine((f) => Number.isInteger(f) && f >= -1_000_000 && f <= 100_000_000, {
                message: 'must be a whole frame number',
              }),
            value: z.number().refine(inRange, { message }),
            ease: EaseName.optional(),
          }),
        )
        .min(1)
        .max(MAX_KEYFRAMES),
    }),
    z.null(),
  ]);
}

/** Stored form: keyframe times in source ticks. */
export const StoredAnimatable = z.union([
  z.number(),
  z.object({
    keyframes: z
      .array(z.object({ t: z.number().int(), value: z.number(), ease: Ease.optional() }))
      .min(1)
      .max(MAX_KEYFRAMES),
  }),
]);
export type StoredAnimatable = z.infer<typeof StoredAnimatable>;
export type Animatable =
  | number
  | { keyframes: Array<{ frame: number; value: number; ease?: Ease | undefined }> };

export const Fit = z
  .enum(['contain', 'cover', 'fill'])
  .describe(
    'contain: whole picture inside the frame (default); cover: fill the frame, cropping; fill: stretch',
  );
export const Flip = z.enum(['none', 'horizontal', 'vertical', 'both']);

export const Crop = z
  .object({
    left: z.number().min(0).max(0.99).default(0),
    right: z.number().min(0).max(0.99).default(0),
    top: z.number().min(0).max(0.99).default(0),
    bottom: z.number().min(0).max(0.99).default(0),
  })
  .refine((c) => c.left + c.right < 1 && c.top + c.bottom < 1, {
    message: 'Crop must leave part of the picture: left + right and top + bottom must be under 1',
  })
  .describe('Fractions of the picture hidden from each edge; the rest stays where it was');
export type Crop = z.infer<typeof Crop>;

/** Transform fields and their limits. Position is the picture centre in the frame (0–1). */
export const TRANSFORM_LIMITS = {
  x: [-4, 5],
  y: [-4, 5],
  scale: [0, 20],
  scale_x: [0, 20],
  scale_y: [0, 20],
  rotation: [-36_000, 36_000],
  opacity: [0, 1],
} as const;
export type TransformNumber = keyof typeof TRANSFORM_LIMITS;
export const TRANSFORM_NUMBERS = Object.keys(TRANSFORM_LIMITS) as TransformNumber[];
export const TRANSFORM_DEFAULTS: Record<TransformNumber, number> = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  scale_x: 1,
  scale_y: 1,
  rotation: 0,
  opacity: 1,
};

export const StoredTransform = z.object({
  x: StoredAnimatable.optional(),
  y: StoredAnimatable.optional(),
  scale: StoredAnimatable.optional(),
  scale_x: StoredAnimatable.optional(),
  scale_y: StoredAnimatable.optional(),
  rotation: StoredAnimatable.optional(),
  opacity: StoredAnimatable.optional(),
  fit: Fit.optional(),
  flip: Flip.optional(),
  crop: Crop.optional(),
});
export type StoredTransform = z.infer<typeof StoredTransform>;

export const BLEND_MODES = [
  'normal',
  'add',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color_dodge',
  'color_burn',
  'hard_light',
  'soft_light',
  'difference',
  'exclusion',
] as const;
export const BlendMode = z.enum(BLEND_MODES);
export type BlendMode = z.infer<typeof BlendMode>;

export const MASK_SHAPES = [
  'rectangle',
  'ellipse',
  'linear',
  'mirror',
  'heart',
  'star',
  'polygon',
] as const;
export const MaskShape = z.enum(MASK_SHAPES);
export type MaskShape = z.infer<typeof MaskShape>;

/** Mask fields that animate. Positions and sizes are fractions of the clip's own picture. */
export const MASK_LIMITS = {
  x: [-4, 5],
  y: [-4, 5],
  width: [0, 10],
  height: [0, 10],
  rotation: [-36_000, 36_000],
} as const;
export type MaskNumber = keyof typeof MASK_LIMITS;
export const MASK_NUMBERS = Object.keys(MASK_LIMITS) as MaskNumber[];
export const MASK_DEFAULTS: Record<MaskNumber, number> = {
  x: 0.5,
  y: 0.5,
  width: 0.5,
  height: 0.5,
  rotation: 0,
};

const Point = z.tuple([z.number().min(-4).max(5), z.number().min(-4).max(5)]);

export const StoredMask = z.object({
  shape: MaskShape,
  x: StoredAnimatable.optional(),
  y: StoredAnimatable.optional(),
  width: StoredAnimatable.optional(),
  height: StoredAnimatable.optional(),
  rotation: StoredAnimatable.optional(),
  feather: z.number().min(0).max(0.5).optional(),
  corner_radius: z.number().min(0).max(0.5).optional(),
  invert: z.boolean().optional(),
  points: z.array(Point).min(3).max(64).optional(),
});
export type StoredMask = z.infer<typeof StoredMask>;

export const IN_OUT_ANIMATIONS = [
  'fade',
  'zoom_in',
  'zoom_out',
  'slide_left',
  'slide_right',
  'slide_up',
  'slide_down',
  'pop',
  'spin',
  'drop',
] as const;
export const InOutAnimation = z.enum(IN_OUT_ANIMATIONS);
export const LOOP_ANIMATIONS = ['pulse', 'sway', 'shake', 'float', 'spin', 'flicker'] as const;
export const LoopAnimation = z.enum(LOOP_ANIMATIONS);

export const StoredAnimation = z.object({
  in: z.object({ name: InOutAnimation, duration: z.number().int().positive() }).optional(),
  out: z.object({ name: InOutAnimation, duration: z.number().int().positive() }).optional(),
  loop: z
    .object({ name: LoopAnimation, period: z.number().int().positive(), strength: z.number() })
    .optional(),
});
export type StoredAnimation = z.infer<typeof StoredAnimation>;

/** Transitions between two touching clips on one track (video), centred on the cut. */
export const VIDEO_TRANSITIONS = [
  'dissolve',
  'dip_to_black',
  'dip_to_white',
  'wipe_left',
  'wipe_right',
  'wipe_up',
  'wipe_down',
  'slide_left',
  'slide_right',
  'slide_up',
  'slide_down',
  'push_left',
  'push_right',
  'push_up',
  'push_down',
  'zoom_in',
  'zoom_out',
  'iris',
  'spin',
] as const;
export const TRANSITION_KINDS = [...VIDEO_TRANSITIONS, 'crossfade'] as const;
export const TransitionKind = z.enum(TRANSITION_KINDS);
export type TransitionKind = z.infer<typeof TransitionKind>;

export const StoredTransition = z.object({
  id: z.string(),
  /** The clip before the cut and the clip after it, touching on the same track. */
  a: z.string(),
  b: z.string(),
  kind: TransitionKind,
  /** Ticks, centred on the cut: the first half plays over the end of `a`'s source past the cut. */
  duration: z.number().int().positive(),
});
export type StoredTransition = z.infer<typeof StoredTransition>;
