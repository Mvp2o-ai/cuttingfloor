import * as z from 'zod/v4';
import { CfError } from './errors.ts';
import { FrameRate } from './sequence.ts';

// The score: music made in layers, a document beside the timeline with the same rules. It is
// immutable and content-addressed (a new score_id per edit, older ids stay valid) and holds
// only what the agent gave: no tempo, meter, key, tuning or level is assumed, and nothing is
// moved to a grid. Positions are beats, a quarter note being 1, as plain numbers exactly as
// passed; seconds and frames are worked out from the tempo map when a tool answers.

/** Stored position or length in beats (a quarter note is 1). */
const beats = z.number().finite();
const seconds = z.number().finite().nonnegative();

/**
 * A pitch as stored: a MIDI number, decimals allowed (60 is middle C, C4; 60.5 a quarter-tone
 * above it). On a drum kit or a sliced sampler it selects a sound, not a height.
 */
export const StoredPitch = z.number().min(0).max(127);

const NOTE_NAME = /^([A-Ga-g])([#b]?)(-?\d)$/;
const SEMITONE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** A pitch as tools take it: a MIDI number (decimals allowed) or a name such as C3, F#4 or Bb2. */
export const PitchInput = z.union([
  StoredPitch,
  z.string().regex(NOTE_NAME, { message: 'a note name such as C3, F#4 or Bb2 (C4 is 60)' }),
]);
export type PitchInput = z.infer<typeof PitchInput>;

/** The MIDI number of a pitch given as a number or a name (C4 is 60). */
export function pitchNumber(pitch: PitchInput): number {
  if (typeof pitch === 'number') return pitch;
  const m = NOTE_NAME.exec(pitch);
  const letter = m?.[1]?.toLowerCase();
  const base = letter === undefined ? undefined : SEMITONE[letter];
  if (!m || base === undefined) throw new CfError('bad_request', `Not a pitch: ${pitch}`);
  const value = (Number(m[3]) + 1) * 12 + base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  if (value < 0 || value > 127) {
    throw new CfError('bad_request', `Pitch ${pitch} is outside 0 to 127 (C-1 to G9)`);
  }
  return value;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** The nearest note name to a MIDI number (C4 is 60) and how many cents the number is off it. */
export function pitchName(pitch: number): { name: string; cents: number } {
  const nearest = Math.round(pitch);
  const name = `${NAMES[((nearest % 12) + 12) % 12]}${Math.floor(nearest / 12) - 1}`;
  return { name, cents: Math.round((pitch - nearest) * 100 * 1000) / 1000 };
}

/** One note of a notes source. `at` is beats from the start of the source it belongs to. */
export const StoredNote = z.object({
  id: z.string(),
  pitch: StoredPitch,
  at: beats,
  length: beats.positive(),
  velocity: z.number().int().min(1).max(127),
});
export type StoredNote = z.infer<typeof StoredNote>;

/**
 * The notes a notes region plays. Regions that share a source mirror each other (a loop, a
 * section that comes back): a note added, changed or removed in one is in all of them.
 */
export const StoredNoteSource = z.object({ notes: z.array(StoredNote) });
export type StoredNoteSource = z.infer<typeof StoredNoteSource>;

/**
 * A stretch of music on a part. `start` is beats in the score.
 *
 * A notes region plays its source's notes whose `at` falls in [offset, offset + length): a note
 * that starts inside sounds at its full length, one that starts outside is stored but silent.
 * Trimming and splitting move `start`, `length` and `offset` and change no note.
 *
 * An audio region plays `from`..`until` seconds of a media's sound. It keeps its own speed, so
 * its length in beats follows the tempo, unless `fit_beats` stretches that source range to that
 * many beats with the pitch unchanged.
 */
export const StoredRegion = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('notes'),
    start: beats,
    length: beats.positive(),
    source: z.string(),
    offset: beats,
  }),
  z.object({
    id: z.string(),
    type: z.literal('audio'),
    start: beats,
    media_id: z.string(),
    from: seconds,
    until: seconds,
    fit_beats: beats.positive().optional(),
    gain_db: z.number().finite(),
  }),
]);
export type StoredRegion = z.infer<typeof StoredRegion>;

/**
 * A device on a part or the master: an instrument or an effect from the device registry
 * (devices.ts), with only the params the agent gave (score.get fills in the published defaults).
 */
export const StoredDevice = z.object({
  id: z.string(),
  name: z.string(),
  params: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
});
export type StoredDevice = z.infer<typeof StoredDevice>;

/** A share of a part's sound sent to another part as well as its own output. */
export const StoredSend = z.object({
  id: z.string(),
  to: z.string(),
  level_db: z.number().finite(),
  before_gain: z.boolean(),
});
export type StoredSend = z.infer<typeof StoredSend>;

/**
 * A layer: one voice of the music. Untyped: what it plays comes from its devices (instruments,
 * which all play every note of the part, then effects in order) and its regions.
 */
export const StoredPart = z.object({
  id: z.string(),
  name: z.string(),
  gain_db: z.number().finite(),
  pan: z.number().min(-1).max(1),
  mute: z.boolean(),
  solo: z.boolean(),
  /** `master`, or the id of a part whose devices and level this one sounds through. */
  output: z.string(),
  devices: z.array(StoredDevice),
  sends: z.array(StoredSend),
  regions: z.array(StoredRegion),
});
export type StoredPart = z.infer<typeof StoredPart>;

export const AutomationCurve = z.enum(['hold', 'linear', 'smooth']);
export type AutomationCurve = z.infer<typeof AutomationCurve>;

/** What an automation lane moves. A device param is named by its path (filter.cutoff_hz, bands[0].gain_db). */
export const AutomationTarget = z.union([
  z.strictObject({ part_id: z.string(), param: z.enum(['gain_db', 'pan']) }),
  z.strictObject({ send_id: z.string(), param: z.literal('level_db') }),
  z.strictObject({ device_id: z.string(), param: z.string() }),
]);
export type AutomationTarget = z.infer<typeof AutomationTarget>;

/** One param moving over time. `curve` shapes the move from a point to the next one. */
export const StoredAutomation = z.object({
  target: AutomationTarget,
  points: z.array(z.object({ at: beats, value: z.number().finite(), curve: AutomationCurve })),
});
export type StoredAutomation = z.infer<typeof StoredAutomation>;

/**
 * A tempo change. The first is at beat 0. `ramp` glides from the change before, linearly in
 * beats, and arrives at this tempo on this beat; without it the tempo steps here.
 */
export const TempoChange = z.object({
  at: beats.nonnegative(),
  bpm: z.number().min(20).max(400),
  ramp: z.boolean().optional(),
});
export type TempoChange = z.infer<typeof TempoChange>;

/**
 * A meter from a bar on (the first from bar 1): `beats` in a bar and the note `unit` that is
 * one of them. Positions stay in quarter notes, so a bar is beats × 4 / unit of them long.
 */
export const MeterChange = z.object({
  bar: z.number().int().min(1),
  beats: z.number().int().min(1).max(64),
  unit: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(4),
    z.literal(8),
    z.literal(16),
    z.literal(32),
  ]),
});
export type MeterChange = z.infer<typeof MeterChange>;

/**
 * A named point. Given in seconds it keeps its time when the tempo changes; given in beats it
 * keeps its beat. Exactly one of the two is stored.
 */
export const StoredMarker = z.union([
  z.strictObject({ id: z.string(), name: z.string(), at_beats: beats }),
  z.strictObject({ id: z.string(), name: z.string(), at_seconds: seconds }),
]);
export type StoredMarker = z.infer<typeof StoredMarker>;

/** What a score needs to know about media its samplers and audio regions use. */
export const ScoreMediaRef = z.object({
  name: z.string(),
  /** Seconds of sound. */
  duration: seconds,
});
export type ScoreMediaRef = z.infer<typeof ScoreMediaRef>;

export const ScoreOp = z.object({ tool: z.string(), args: z.unknown() });
export type ScoreOp = z.infer<typeof ScoreOp>;

export const ScoreDoc = z.object({
  version: z.literal(1),
  name: z.string(),
  sample_rate: z.union([z.literal(44_100), z.literal(48_000)]),
  /** A timeline's frame rate: with it, every position a tool returns is also in frames. */
  fps: FrameRate.optional(),
  tempo: z.array(TempoChange).min(1),
  meter: z.array(MeterChange).min(1),
  markers: z.array(StoredMarker),
  parts: z.array(StoredPart),
  /** Effects on the whole score, in order. */
  master: z.object({ devices: z.array(StoredDevice) }),
  /** Notes sources by id; a notes region names one. */
  sources: z.record(z.string(), StoredNoteSource),
  automation: z.array(StoredAutomation),
  /** Media used by samplers and audio regions, copied in so the document stands alone. */
  media: z.record(z.string(), ScoreMediaRef),
  /** The next number for an id (p1, d2, r3, n4…), as a timeline numbers its clips. */
  next_id: z.number().int().positive(),
  /** The score this one was edited from. */
  parent: z.string().nullable(),
  /** The call that made it, for score.history. */
  op: ScoreOp.optional(),
});
export type ScoreDoc = z.infer<typeof ScoreDoc>;
