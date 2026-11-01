import * as z from 'zod/v4';

// Measured facts media.analyze returns and keeps with the media: who speaks when, how a voice
// sounds over time, colour statistics of frames and regions, and every frame's signalstats. Also
// where a clip's picture lands in the frame after a transform edit. Facts only: no thresholds of
// the server's own and no verdicts.

/** A box the caller gives: top-left x, y and size, in fractions of the picture or in pixels. */
export const RegionBox = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  w: z.number().positive(),
  h: z.number().positive(),
  units: z
    .enum(['fraction', 'pixels'])
    .default('fraction')
    .describe('fraction (default): of the picture; pixels: of the picture at its own size'),
});
export type RegionBox = z.infer<typeof RegionBox>;

const PixelBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

export const SpeakersAnalysis = z.object({
  model: z.string(),
  speakers_asked: z.number().nullable().describe('The count you gave, or null'),
  cluster_threshold: z.number().nullable().describe('The cut-off you gave, or null'),
  speakers: z.number().describe('How many speakers were found'),
  from: z.number().optional().describe('The stretch diarised, when not the whole media'),
  until: z.number().nullable().optional(),
  turns: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        speaker: z.number().describe('0 is the first voice heard, 1 the next new one, …'),
        confidence: z
          .number()
          .nullable()
          .describe("0–1: how close this turn's voice sits to its speaker's other turns"),
      }),
    )
    .describe('Each stretch of one voice, by start; two voices at once overlap'),
});

const Percentiles = z
  .record(z.string(), z.number())
  .describe('Per percentile asked ("5", "50", "95"): the value');
const Channel = z.object({ mean: z.number(), percentiles: Percentiles });

export const ColourStatsSchema = z.object({
  pixels: PixelBox.describe('The region measured, in pixels of the picture'),
  r: Channel,
  g: Channel,
  b: Channel,
  luma: Channel.describe('Rec. 709 luma of the encoded values: 0.2126 R + 0.7152 G + 0.0722 B'),
  white_point: z
    .object({ r: z.number(), g: z.number(), b: z.number() })
    .describe('Mean colour of the brightest 1% of its pixels, an estimate of the white point'),
  clipped_high: z.number().describe('Share of pixels with a channel at 255'),
  clipped_low: z.number().describe('Share of pixels black in every channel'),
});

export const ColourAnalysis = z.object({
  percentiles: z.array(z.number()),
  frames: z.array(
    z.object({
      time: z.number(),
      regions: z
        .record(z.string(), ColourStatsSchema)
        .describe('frame: the whole picture; and each region you named'),
    }),
  ),
});

export const VoiceAnalysis = z.object({
  method: z.string(),
  frame_seconds: z.number(),
  from: z.number(),
  summary: z.object({
    seconds: z.number(),
    voiced_seconds: z.number().describe('Time with a clear pitch: voice, not noise or silence'),
    pitch_hz: z
      .object({ median: z.number(), p10: z.number(), p90: z.number() })
      .nullable()
      .describe('Over the voiced time'),
    pitch_range_semitones: z.number().nullable().describe('p10 to p90: how much the voice moves'),
    level_db: z.object({
      rms: z.number().nullable(),
      p10: z.number().nullable(),
      p90: z.number().nullable(),
    }),
    words: z.number().nullable().describe('Transcript words in the stretch; null: no transcript'),
    words_per_second: z.number().nullable(),
  }),
  frames: z.array(
    z.object({
      time: z.number(),
      pitch_hz: z.number().nullable().describe('Median of its voiced 10 ms steps; null: none'),
      voiced: z.number().describe('Share of it with a clear pitch, 0–1'),
      level_db: z.number().nullable().describe('RMS, dBFS; null: digital silence'),
    }),
  ),
});

export const PictureAnalysis = z.object({
  method: z.string(),
  from: z.number(),
  columns: z
    .record(z.string(), z.array(z.number()))
    .describe(
      "One number per frame in each, in order: time, then FFmpeg signalstats in the picture's own bit depth (0–255 for 8-bit): ymin, ylow (10th percentile), yavg, yhigh (90th), ymax, the same for u and v, satmin…satmax, huemed, hueavg, ydif, udif, vdif (mean change from the frame before), and the bits each plane uses (ybitdepth…)",
    ),
});

/** Where a clip's picture lands after a transform edit, in sequence pixels. */
export const ClipPlacementSchema = z.object({
  clip_id: z.string(),
  frames: z.array(
    z.object({
      frame: z.number().describe('From the clip start'),
      picture: PixelBox.describe('The whole picture, before crop and mask and rotation'),
      rotation: z.number(),
      opacity: z.number(),
      visible: PixelBox.nullable().describe(
        'What it shows: crop and mask applied, rotated, inside the frame; null: nothing',
      ),
      source: PixelBox.nullable().describe('The part of the source that shows, source pixels'),
    }),
  ),
  complete: z
    .boolean()
    .describe('true: values move in straight lines between entries; false: evenly sampled'),
});
