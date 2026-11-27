import * as z from 'zod/v4';
import { ScoreId } from './ids.ts';
import { ScorePosition } from './score-tools.ts';
import { MediaInfo } from './tools.ts';

// score.render: a score, or a range of it, as audio media. The only numbers it holds protect the
// platform (the engine's own limits, in packages/engine): no level is assumed for where sound
// ends, so the render stops at until_beats unless tail_db says how far to follow it.

export const ScoreRenderInput = z
  .object({
    score_id: ScoreId,
    from_beats: z
      .number()
      .finite()
      .nonnegative()
      .optional()
      .describe('Start of the range. Default 0'),
    from_seconds: z
      .number()
      .finite()
      .nonnegative()
      .optional()
      .describe('Start of the range in seconds, in place of from_beats'),
    until_beats: z
      .number()
      .finite()
      .positive()
      .optional()
      .describe('End of the range. Default the end of the last region'),
    until_seconds: z
      .number()
      .finite()
      .positive()
      .optional()
      .describe('End of the range in seconds, in place of until_beats'),
    parts: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'part_ids to render alone: only their notes and audio play (parts they sound through or send to still carry them). Default all',
      ),
    format: z.enum(['wav', 'mp3']).default('wav').describe('24-bit WAV, or MP3'),
    tail_db: z
      .number()
      .min(-200)
      .lt(0)
      .optional()
      .describe(
        'Run past until_beats until the sound falls under this level (dBFS). Left out, the render stops at until_beats',
      ),
    name: z.string().min(1).max(200).optional().describe('A label for the media'),
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.from_beats === undefined || v.from_seconds === undefined, {
    message: 'Give from_beats or from_seconds, not both',
  })
  .refine((v) => v.until_beats === undefined || v.until_seconds === undefined, {
    message: 'Give until_beats or until_seconds, not both',
  });

/** What a render of a score measured, kept with the media it made. */
export const ScoreRenderFacts = z.object({
  score_id: ScoreId,
  from: ScorePosition.describe('Where the audio starts in the score'),
  until: ScorePosition.describe('Where the range ends in the score'),
  length_seconds: z.number().describe('Length of the audio, the tail included'),
  loudness: z.object({
    integrated_lufs: z.number().nullable().describe('EBU R128; null below its -70 LUFS gate'),
    true_peak_dbtp: z.number().nullable().describe('null when silent'),
  }),
  clipped_samples: z
    .number()
    .int()
    .describe(
      'Samples over full scale, cut off in the file: more than 0 means the mix is too loud',
    ),
  parts_sounded: z
    .array(z.string())
    .describe('part_ids whose own notes or audio play in the range, after mute, solo and parts'),
  ends_seconds: z
    .number()
    .optional()
    .describe('With tail_db: when the sound fell under it, in seconds of the score'),
  tail_capped: z
    .boolean()
    .optional()
    .describe(
      'With tail_db: true when the sound was still over it after the longest tail a render runs',
    ),
  bars: z
    .array(ScorePosition.extend({ bar: z.number().int().describe('From 1') }))
    .describe('Where each bar in the range starts'),
  bars_truncated: z.boolean().optional().describe('true when the range has more bars than listed'),
});
export type ScoreRenderFacts = z.infer<typeof ScoreRenderFacts>;

export const ScoreRenderResult = MediaInfo.extend({ render: ScoreRenderFacts });
export type ScoreRenderResult = z.infer<typeof ScoreRenderResult>;

/** Bars a render lists: a limit on the size of a result, not on the render. */
export const SCORE_RENDER_BARS = 400;
