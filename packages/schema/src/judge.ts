import * as z from 'zod/v4';
import { MediaId } from './ids.ts';

// Questions for TypeSafe Jev, a judgment model, and its typed answers. judge.ask asks them about
// any state you give (text, JSON, pictures); media.analyze look asks them of sampled frames.

/** Per call: questions (Jev has no count limit, only a 64k-token context), pictures, text size. */
export const JUDGE_LIMITS = { questions: 32, images: 8, textChars: 200_000 } as const;

/** A state entry's or a question's name: questions refer to entries by it, in backticks. */
export const JudgeName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);

/** Text a judgment model reads: a string, or structure that clarifies it (definitions, examples). */
const JudgmentText = z.union([
  z.string().min(1),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

/** One question, in Jev's own format. All questions in a call see the same state. */
export const JudgeQuestion = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    instructions: JudgmentText,
    criteria: z.object({ true: JudgmentText, false: JudgmentText }).partial().optional(),
  }),
  z.object({
    type: z.literal('choice'),
    instructions: JudgmentText,
    criteria: z.record(z.string(), JudgmentText.nullable()).describe('option: what it means'),
  }),
  z.object({
    type: z.literal('score'),
    instructions: JudgmentText,
    criteria: z.array(JudgmentText).min(2).max(10).describe('levels, lowest first'),
  }),
  z.object({ type: z.literal('box'), instructions: JudgmentText }),
]);
export type JudgeQuestion = z.infer<typeof JudgeQuestion>;

export const JudgeAnswer = z.union([
  z.object({ noul: z.number() }),
  z.object({
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    score: z.number(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
    confidence: z.number(),
  }),
]);
export type JudgeAnswer = z.infer<typeof JudgeAnswer>;

/** A text-like state entry: a string, a number or flag, or JSON that holds related facts. */
export const JudgeText = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

/** A picture in the state: an imported image, or the frame of a video at a time. */
export const JudgePicture = z
  .object({
    media_id: MediaId,
    at_seconds: z
      .number()
      .min(0)
      .optional()
      .describe('The frame of a video at this media time; needed for video'),
  })
  .strict();

export const JudgeAskInput = z.object({
  state: z
    .record(JudgeName, z.union([JudgePicture, JudgeText]))
    .refine((s) => Object.keys(s).length > 0, 'state needs at least one entry')
    .describe(
      'What Jev sees, entry by entry: name to a string, a JSON object or array, or a picture {media_id} (an image) or {media_id, at_seconds} (a video frame). Questions refer to entries by name in backticks',
    ),
  questions: z
    .record(JudgeName, JudgeQuestion)
    .describe(
      `id (yours, not shown to the model) to question; up to ${JUDGE_LIMITS.questions}, all answered about the same state`,
    ),
});

export const JudgeAskResult = z.object({
  model: z.string(),
  answers: z
    .record(z.string(), JudgeAnswer)
    .describe(
      'Per question id: noul {noul}; choice {choice, probabilities, confidence}; score {score, probabilities, confidence}; box {box: {x, y, w, h} fractions of the picture, confidence}',
    ),
});
