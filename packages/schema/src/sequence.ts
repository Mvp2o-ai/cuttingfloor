import * as z from 'zod/v4';

/** Stored time unit: 1/705 600 000 s. Every common frame and sample rate divides it exactly. */
export const TICKS_PER_SECOND = 705_600_000;

/** Rational frame rate, e.g. 30000/1001. Tools take and return integer frames at this rate. */
export const FrameRate = z
  .object({
    num: z.number().int().positive(),
    den: z.number().int().positive(),
  })
  .refine((r) => (TICKS_PER_SECOND * r.den) % r.num === 0, {
    message:
      'Unsupported frame rate: num/den must divide 705600000 ticks per second (e.g. 24, 25, 30, 50, 60, 24000/1001, 30000/1001, 60000/1001).',
  });
export type FrameRate = z.infer<typeof FrameRate>;

export const Sequence = z.object({
  width: z.number().int().min(16).max(8192).multipleOf(2),
  height: z.number().int().min(16).max(8192).multipleOf(2),
  fps: FrameRate,
  audio_rate: z.number().int().positive().default(48_000),
  channels: z.number().int().min(1).max(8).default(2),
  color: z.literal('bt709').default('bt709'),
});
export type Sequence = z.infer<typeof Sequence>;
