import * as z from 'zod/v4';

// Measured facts about any sound that media.analyze returns whole in its result (not kept with
// the media): onsets, notes, key, spectrum, and loudness's level on steps. Facts only: every
// threshold is the caller's argument.

/**
 * Limits that protect the server for media.analyze onsets, notes, key, spectrum and loudness
 * with every_seconds. Each is refused with the number in the error, never applied quietly.
 * Draft values, to size on the hosted machine.
 */
export const HEARING_LIMITS = {
  /** Seconds of sound one call reads, per kind. */
  seconds: { onsets: 2 * 60 * 60, notes: 10 * 60, key: 60 * 60, spectrum: 60 * 60 },
  /** Steps one call returns: loudness's level on steps, and key and spectrum per step. */
  steps: { loudness: 20_000, key: 5_000, spectrum: 2_000 },
  /** Onsets and notes one call returns. */
  onsets: 5_000,
  notes: 2_000,
  /** The shortest every_seconds each kind takes (key and spectrum: their window's hop). */
  minStep: { onsets: 0.01, loudness: 0.01, notes: 0.01, key: 0.2, spectrum: 0.1 },
} as const;

export const OnsetsAnalysis = z.object({
  every_seconds: z.number(),
  threshold_db: z.number(),
  onsets: z
    .array(
      z.object({
        time: z.number().describe('Where the step that rose starts'),
        rise_db: z
          .number()
          .nullable()
          .describe(
            'Its level less the step before, dB; null: the step before was digital silence',
          ),
        level_db: z.number().describe('Its level, RMS dBFS'),
        low: z.number().describe('Share of the step below 250 Hz, 0–1'),
        mid: z.number().describe('Share from 250 Hz to 4 kHz'),
        high: z.number().describe('Share above 4 kHz'),
      }),
    )
    .describe('In time order; the first step has none before it'),
});

export const NotesAnalysis = z.object({
  method: z.string().describe('The pitch line: YIN, 40 Hz to 2 kHz, every 10 ms, 50 ms median'),
  split_cents: z.number(),
  min_seconds: z.number(),
  threshold_db: z.number().optional(),
  every_seconds: z.number().optional(),
  tempo: z.number().optional(),
  first_bar_seconds: z.number().optional(),
  notes: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      hz: z.number().describe('Median pitch over the note'),
      note: z.string().describe('Nearest note name, equal temperament, A4 = 440 Hz, C4 middle C'),
      cents: z.number().describe('Cents from that note, -50 to 50'),
      level_db: z.number().nullable().describe('RMS dBFS over the note'),
      start_beats: z
        .number()
        .optional()
        .describe('With tempo: beats from first_bar_seconds (0 is its first beat)'),
      length_beats: z.number().optional(),
    }),
  ),
});

export const KeyAnalysis = z.object({
  scores: z
    .record(z.string(), z.number())
    .describe(
      'Per key ("C major" … "B minor", 24): 0–1, how well the note strengths match the key (Krumhansl–Kessler profile correlation r, as (r + 1) / 2)',
    ),
  notes: z
    .record(z.string(), z.number())
    .describe('Per note name (C, C#, … B): its strength over the range, 0–1 of the strongest'),
  steps: z
    .object({
      start: z.number(),
      every_seconds: z.number(),
      notes: z
        .array(z.array(z.number()).nullable())
        .describe(
          'Per step: the 12 strengths, C first, 0–1 of that step’s strongest; null: silent, or no window is centred in it',
        ),
    })
    .optional()
    .describe('With every_seconds'),
});

export const SpectrumAnalysis = z.object({
  bands_hz: z.array(z.number()).describe('Third-octave band centres, 20 Hz to 20 kHz'),
  level_db: z
    .array(z.number().nullable())
    .describe('Per band over the range: RMS dBFS of what lies in it; null: nothing'),
  steps: z
    .object({
      start: z.number(),
      every_seconds: z.number(),
      level_db: z
        .array(z.array(z.number().nullable()).nullable())
        .describe('Per step, per band; null: no window is centred in the step'),
    })
    .optional()
    .describe('With every_seconds'),
});

export const LevelSteps = z
  .object({
    start: z.number().describe('Where the first step starts'),
    every_seconds: z.number(),
    level_db: z
      .array(z.number().nullable())
      .describe('Per step: RMS dBFS over every channel; null: digital silence'),
  })
  .describe('With every_seconds: the level on steps');
