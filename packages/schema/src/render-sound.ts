import * as z from 'zod/v4';
import { MediaId, ScoreId } from './ids.ts';

// Pictures of sound: render.spectrogram (media or a score's sound on a pitch scale) and
// render.notes (a score's notes as a piano roll), drawn on the same axes so the two compare row
// for row. The only numbers here are limits that protect the server.

export const SOUND_PICTURE_LIMITS = {
  /** Seconds of sound in one spectrogram. */
  seconds: 60,
  /** Pixels on the long edge. */
  minEdge: 640,
  maxEdge: 1920,
} as const;

const longEdge = z
  .int()
  .min(SOUND_PICTURE_LIMITS.minEdge)
  .max(SOUND_PICTURE_LIMITS.maxEdge)
  .default(1280)
  .describe('Longest side (the width) in pixels; rows get taller with it');

export const RenderSpectrogramInput = z
  .object({
    media_id: MediaId.optional().describe('Media to draw. One of media_id or score_id'),
    score_id: ScoreId.optional().describe('A score to render and draw'),
    from_seconds: z.number().finite().min(0).default(0).describe('Start of the range. Default 0'),
    until_seconds: z
      .number()
      .finite()
      .positive()
      .optional()
      .describe(
        `End of the range. Up to ${SOUND_PICTURE_LIMITS.seconds} s after the start. Default the end, or ${SOUND_PICTURE_LIMITS.seconds} s after the start if that comes first`,
      ),
    tempo: z
      .number()
      .min(20)
      .max(400)
      .optional()
      .describe('Beats per minute, to draw bar and beat lines on media'),
    first_bar_seconds: z
      .number()
      .finite()
      .min(0)
      .optional()
      .describe('Where bar 1 starts in the media, with tempo. Default 0'),
    beats_per_bar: z
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Beats in a bar, with tempo: bar lines are drawn and numbered. Without it, beat lines only',
      ),
    long_edge: longEdge,
  })
  .refine((v) => Boolean(v.media_id) !== Boolean(v.score_id), {
    message: 'Give exactly one of media_id or score_id',
  })
  .refine((v) => v.until_seconds === undefined || v.until_seconds > v.from_seconds, {
    message: 'until_seconds must come after from_seconds',
  });

export const RenderNotesInput = z
  .object({
    score_id: ScoreId.describe('The score'),
    from_beats: z.number().finite().default(0).describe('Start of the range. Default 0'),
    until_beats: z
      .number()
      .finite()
      .optional()
      .describe("End of the range. Default the score's end"),
    parts: z.array(z.string()).min(1).optional().describe('part_ids to draw. Default all'),
    long_edge: longEdge,
  })
  .refine((v) => v.until_beats === undefined || v.until_beats > v.from_beats, {
    message: 'until_beats must come after from_beats',
  });

export const SoundPictureImage = z.object({
  url: z.string().describe('Signed download of the image'),
  expires_at: z.string(),
  mime_type: z.string(),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
});

export const SoundPlot = z
  .object({
    left: z.number(),
    top: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .describe(
    'The plot in image pixels: a time t is at x = left + (t - from_seconds) / seconds_per_pixel; a row is row_pixels high, the highest at top',
  );

export const SoundPitchRows = z.object({
  lowest: z.string().describe('Bottom row, a note name'),
  highest: z.string().describe('Top row'),
  lowest_midi: z.number(),
  highest_midi: z.number(),
  lowest_hz: z.number(),
  highest_hz: z.number(),
  row_pixels: z.number().describe('Pixels per semitone row'),
});

export const SoundBarLine = z.object({
  bar: z.number(),
  seconds: z.number(),
  beats: z.number().optional().describe('In the score'),
  x: z.number().describe('Image pixel column of the line'),
});

export const RenderSpectrogramResult = z.object({
  media_id: z.string().optional(),
  score_id: z.string().optional(),
  image: SoundPictureImage,
  from_seconds: z.number(),
  until_seconds: z.number(),
  seconds_per_pixel: z.number(),
  plot: SoundPlot,
  pitch: SoundPitchRows,
  level: z.object({
    black_db: z.number().describe('Black: this level or quieter'),
    brightest_db: z.number().describe('Brightest: this level'),
    unit: z.string(),
    peak_db: z.number().nullable().describe('Loudest row level in the picture'),
  }),
  analysis: z.string().describe('How levels were measured'),
  window_seconds: z
    .record(z.string(), z.number())
    .describe('Window length at each C: the time detail of that octave'),
  bars: z.array(SoundBarLine),
  beat_lines: z.number().describe('Beat lines drawn (none when closer than 4 pixels)'),
});

export const RenderNotesResult = z.object({
  score_id: z.string(),
  image: SoundPictureImage,
  from_beats: z.number(),
  until_beats: z.number(),
  from_seconds: z.number(),
  until_seconds: z.number(),
  seconds_per_pixel: z.number(),
  plot: SoundPlot,
  pitch: SoundPitchRows,
  parts: z.array(
    z.object({
      part_id: z.string(),
      name: z.string(),
      colour: z.string().describe('Hex colour of its notes'),
      notes: z.number().describe('Notes drawn'),
    }),
  ),
  notes: z.number().describe('Notes drawn in all'),
  notes_outside_rows: z
    .number()
    .describe('Notes below the lowest row or above the highest, not drawn'),
  audio_regions: z.number().describe('Audio regions in the range: sound, not notes, so not drawn'),
  bars: z.array(SoundBarLine),
  beat_lines: z.number(),
});
