import * as z from 'zod/v4';

/** Rational frame rate, e.g. 30000/1001. Time is integer frames at this rate. */
export const FrameRate = z.object({
  num: z.number().int().positive(),
  den: z.number().int().positive(),
});

export const Sequence = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: FrameRate,
  audio_rate: z.number().int().positive().default(48_000),
  channels: z.number().int().positive().default(2),
  color: z.literal('bt709').default('bt709'),
});
export type Sequence = z.infer<typeof Sequence>;
