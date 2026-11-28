import * as z from 'zod/v4';
import { JobId, ScoreId } from './ids.ts';
import { NativeView } from './native-view.ts';
import { PitchInput } from './score.ts';
import { RegionPlace, ScorePosition } from './score-tools.ts';

// score.record and the two calls a view or a phone app plays a take through (POST
// /v1/record.session, POST /v1/record.take: contract v1.1, plans/music/mobile-native-record.md).
// A take is stored exactly as played: nothing is moved to a grid, dropped or wrapped. Positions
// arrive as seconds in the loop as rendered at `speed`; the server turns them into the score's
// beats through that rendition's tempo map.

/**
 * Limits that protect the platform (to size on the hosted machine). Nothing else is a number
 * score.record holds; going over one is refused with the limit in the error.
 */
export const RECORD_LIMITS = {
  /** Seconds one pass of the loop lasts, as rendered at the speed asked. */
  loopSeconds: 120,
  /** Taps in one take. */
  taps: 2000,
  /** Passes of the loop one take spans. */
  passes: 64,
  /** Pads in one session. */
  pads: 64,
  /** Seconds of one microphone take. */
  microphoneSeconds: 600,
  /** Sessions waiting for their take at once, for one account. */
  sessionsOpen: 4,
  /** Slowest and fastest speed a loop is rendered at (tempo × speed). */
  speed: { min: 0.25, max: 2 },
  /** Count-in clicks before the loop. */
  countInBeats: 64,
  /** How long a session waits for its take. */
  sessionMs: 24 * 3_600_000,
} as const;

const n = (x: number) => x.toLocaleString('en-US');
const atBeats = z.number().finite().nonnegative();
const Velocity = z.number().int().min(1).max(127);

export const RECORD_INPUTS = ['pads', 'microphone'] as const;
export const RecordInputKind = z.enum(RECORD_INPUTS);
export type RecordInputKind = z.infer<typeof RecordInputKind>;

export const ScoreRecordInput = z.object({
  score_id: ScoreId.describe('The score to play under them'),
  part_id: z.string().describe('The part the take goes on; its instrument is what the pads play'),
  input: RecordInputKind.describe('What they perform with'),
  from_beats: atBeats.default(0).describe('Start of the loop. Default 0'),
  until_beats: atBeats
    .optional()
    .describe("End of the loop. Default the score's end; required in a score with no regions"),
  click: z.boolean().default(false).describe('true plays a click on each beat under them'),
  count_in_beats: z
    .number()
    .int()
    .min(0)
    .max(RECORD_LIMITS.countInBeats)
    .default(0)
    .describe(
      'Clicks played before the take starts, on the beats of the meter leading into the loop (six a bar in 6/8). Default 0',
    ),
  velocity: Velocity.optional().describe(
    'Pads, required: 1 to 127, the strength a tap is stored with where the device measures none (most phones do not)',
  ),
  length_beats: z
    .number()
    .finite()
    .positive()
    .optional()
    .describe(
      'Pads, required: the length each tapped note is stored with (a tap gives its moment, not how long it lasts)',
    ),
  pads: z
    .array(PitchInput)
    .min(1)
    .max(RECORD_LIMITS.pads, {
      message: `up to ${RECORD_LIMITS.pads} pads (a limit of the platform)`,
    })
    .optional()
    .describe(
      'Pads, required: the pitches that get a pad, in the order shown, as in notes (score.get lists which pitch plays what on a drum kit or a sliced sampler)',
    ),
});
export type ScoreRecordInput = z.infer<typeof ScoreRecordInput>;

const Pad = z.object({
  pitch: z.number(),
  name: z.string().describe('Note name (C4 is 60)'),
  plays: z.string().optional().describe('What it plays, on a drum kit or a sliced sampler'),
});

const LoopRange = z.object({
  from: ScorePosition.describe('Where the loop starts in the score'),
  until: ScorePosition.describe('Where it ends'),
  length_beats: z.number(),
  length_seconds: z.number().describe('At the score’s tempo (speed 1)'),
});

export const ScoreRecordResult = z.object({
  job_id: JobId.describe('job.get gives the take once they send it'),
  status: z.literal('working'),
  input: RecordInputKind,
  url: z
    .string()
    .describe(
      'The same pads or record button as a page in a browser, for this take only; it needs no sign-in',
    ),
  native_view: NativeView,
  expires_at: z.string().describe('When the session stops taking a take'),
  expiry: z.string(),
  loop: LoopRange,
  pads: z.array(Pad).optional().describe('Pads: the pads shown, in order'),
  upload: z
    .object({ upload_id: z.string(), url: z.string(), max_bytes: z.number() })
    .optional()
    .describe('Microphone: the staged upload the view sends the recording to'),
  warnings: z.array(z.string()),
  hint: z.string(),
});
export type ScoreRecordResult = z.infer<typeof ScoreRecordResult>;

// ------------------------------------------------------------------------- the two calls

export const RECORD_ROUTES = ['speaker', 'wired', 'bluetooth', 'other'] as const;

/** The delay correction the device applied to every position it sent, and how it knew it. */
export const RecordDelay = z.strictObject({
  output_ms: z.number().finite().describe('Output delay taken off each position, in ms'),
  input_ms: z.number().finite().describe('Input delay taken off the recording, in ms'),
  source: z.enum(['reported', 'measured']),
  route: z.enum(RECORD_ROUTES),
  input_preset: z.enum(['unprocessed', 'voice_recognition']).optional(),
  echo_cancelled: z.boolean().optional(),
});
export type RecordDelay = z.infer<typeof RecordDelay>;

export const RecordSessionInput = z.strictObject({
  job_id: JobId,
  speed: z
    .number()
    .finite()
    .optional()
    .describe(
      `Tempo × speed the loop is rendered at: ${RECORD_LIMITS.speed.min} to ${RECORD_LIMITS.speed.max}. Default 1`,
    ),
});
export type RecordSessionInput = z.infer<typeof RecordSessionInput>;

export const RecordSessionResult = z.object({
  job_id: JobId,
  input: RecordInputKind,
  expires_at: z.string(),
  speed: z.number(),
  loop: z.object({
    url: z.string().describe('WAV, PCM 16-bit stereo, one pass, no click in it'),
    sample_rate: z.number(),
    frames: z.number().int(),
    seconds: z.number().describe('frames / sample_rate'),
    beats: z.array(z.number()).describe('When each beat of the meter falls in it, from 0'),
    bars: z.array(z.number()).describe('When each bar starts in it'),
  }),
  click: z.object({ on: z.boolean(), url: z.string(), accent_url: z.string() }),
  count_in: z.object({
    beats: z.number().int(),
    seconds: z.number(),
    times: z.array(z.number()).describe('Each count-in click, in negative seconds before the loop'),
  }),
  pads: z
    .array(z.object({ pitch: z.number(), name: z.string(), url: z.string() }))
    .describe('Pads only: one WAV per pad'),
  limits: z
    .object({
      passes: z.number().int().describe('Passes of the loop one take spans'),
      taps: z.number().int().describe('Taps in one take'),
      microphone_seconds: z.number().describe('Seconds of one microphone take'),
    })
    .describe('Where a take ends: one over any of these is refused whole'),
});
export type RecordSessionResult = z.infer<typeof RecordSessionResult>;

export const RecordTap = z.strictObject({
  pitch: z.number().min(0).max(127),
  at_seconds: z.number().finite(),
  pass: z.number().int().min(0),
  velocity: Velocity.optional(),
});
export type RecordTap = z.infer<typeof RecordTap>;

const takeCommon = {
  job_id: JobId,
  speed: z.number().finite().positive(),
};

export const RecordPadsTake = z.strictObject({
  ...takeCommon,
  taps: z.array(RecordTap).max(RECORD_LIMITS.taps, {
    message: `up to ${n(RECORD_LIMITS.taps)} taps a take (a limit of the platform)`,
  }),
  delay: RecordDelay,
});

export const RecordMicrophoneTake = z.strictObject({
  ...takeCommon,
  upload_id: z.string(),
  starts_at_seconds: z.number().finite(),
  passes: z.number().int().min(1),
  delay: RecordDelay,
});

export const RecordTakeInput = z.union([RecordPadsTake, RecordMicrophoneTake]);
export type RecordTakeInput = z.infer<typeof RecordTakeInput>;
export type RecordPadsTake = z.infer<typeof RecordPadsTake>;
export type RecordMicrophoneTake = z.infer<typeof RecordMicrophoneTake>;

export const RecordTakeResult = z.object({ ok: z.literal(true) });

// ------------------------------------------------------------------------- the take, as the job gives it

const TakeTap = z.object({
  note_id: z.string(),
  pitch: z.number(),
  pass: z.number().int(),
  at_seconds: z.number().describe('As sent: seconds into that pass of the loop at speed'),
  at: ScorePosition.describe('Where it sits in the score'),
  velocity: z.number().int(),
  velocity_measured: z
    .boolean()
    .describe('true: the device measured it; false: the velocity given to score.record'),
  sounds: z.boolean().describe('false: outside the region, stored but silent until it is widened'),
});

export const ScoreRecordTake = z.object({
  score_id: ScoreId.describe('The new version with the take: edit this one next'),
  parent: ScoreId.describe('The score the take was played over'),
  input: RecordInputKind,
  part_id: z.string(),
  region_id: z.string(),
  region: RegionPlace.describe('The new region: the loop’s range'),
  speed: z.number().describe('Tempo × speed the user heard while playing'),
  delay: RecordDelay.describe('What the device took off each position, as it sent it'),
  note_ids: z.array(z.string()).optional().describe('Pads: one note per tap, in the order sent'),
  taps: z.array(TakeTap).optional().describe('Pads: every tap, where it was played'),
  outside: z
    .array(TakeTap.pick({ note_id: true, pass: true, at_seconds: true, at: true }))
    .optional()
    .describe(
      'Pads: taps outside the region (on a later pass, or before the loop starts), where each was played',
    ),
  velocities: z
    .object({
      measured: z.number().int().describe('Taps with a velocity the device measured'),
      given: z.number().int().describe('Taps stored with the velocity given to score.record'),
    })
    .optional(),
  media_id: z.string().optional().describe('Microphone: the recording, imported as media'),
  route: z.enum(RECORD_ROUTES).optional(),
  passes: z.number().int().optional().describe('Microphone: passes of the loop it spans'),
  starts_at_seconds: z
    .number()
    .optional()
    .describe(
      'Microphone: where its first sample sits in the loop at speed, as the device sent it',
    ),
  recording: z
    .object({
      at: ScorePosition.describe('Where its first sample sits in the score'),
      end: ScorePosition.describe('Where its last sample ends'),
      seconds: z.number(),
      outside_seconds: z
        .object({ before: z.number(), after: z.number() })
        .describe('Seconds of it outside the region, before and after: kept, silent until widened'),
    })
    .optional(),
  fit_beats: z
    .number()
    .optional()
    .describe(
      'Microphone at a speed other than 1: the region is stretched to the beats it was played over',
    ),
  correlation: z
    .object({
      starts_at_seconds: z
        .number()
        .describe('Where the loop heard in the recording puts its first sample, in loop seconds'),
      strength: z
        .number()
        .describe('Correlation of the overlap, -1 to 1: near 0 the loop is not in it (headphones)'),
      overlap_seconds: z.number(),
      next_best: z.object({ starts_at_seconds: z.number(), strength: z.number() }).nullable(),
    })
    .nullable()
    .optional()
    .describe('Microphone: the loop found in the recording by cross-correlation'),
  warnings: z.array(z.string()),
});
export type ScoreRecordTake = z.infer<typeof ScoreRecordTake>;
