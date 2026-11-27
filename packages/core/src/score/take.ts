import { createHash } from 'node:crypto';
import {
  CfError,
  DEVICES,
  type DeviceSpec,
  deviceKind,
  type MeterChange,
  pitchName,
  pitchNumber,
  type ScoreDoc,
  type StoredNote,
  type StoredRegion,
  type TempoChange,
} from '@cuttingfloor/schema';
import { canonicalJson } from '../hash.ts';
import { checkLimits, findPart, soundsIn } from './edit.ts';
import { barLength, barsBetween, beatsToSeconds, secondsToBeats } from './time.ts';

// A take played over a loop of a score (score.record), turned into the score. Positions arrive
// as seconds in the loop as rendered at `speed` (tempo × speed); they become the score's beats
// through that rendition's tempo map, which is the score's own with every tempo × speed, so a
// beat is the same beat at any speed. Every tap is stored where it was played: a tap on a later
// pass lands that many loop lengths on, one before the loop's start lands before the region.
// Nothing is rounded, moved to a grid, dropped or wrapped.

/** The tempo map a loop is rendered at: every tempo × speed. A copy; the score is unchanged. */
export function tempoAtSpeed(tempo: TempoChange[], speed: number): TempoChange[] {
  return tempo.map((t) => ({ ...t, bpm: t.bpm * speed }));
}

/** A copy of a score at another speed (its tempo map × speed), for rendering what is heard. */
export function scoreAtSpeed(doc: ScoreDoc, speed: number): ScoreDoc {
  return { ...structuredClone(doc), tempo: tempoAtSpeed(doc.tempo, speed) };
}

/** The grid of meter beats: each span from its bar on, one beat a meter unit. */
function spans(meter: MeterChange[]): Array<{ at: number; step: number }> {
  const changes = [...meter].sort((a, b) => a.bar - b.bar);
  const out: Array<{ at: number; step: number }> = [];
  let at = 0;
  for (const [i, change] of changes.entries()) {
    out.push({ at, step: 4 / change.unit });
    const next = changes[i + 1];
    if (next) at += (next.bar - change.bar) * barLength(change);
  }
  return out;
}

const EPS = 1e-9;

/** Every beat of the meter (in quarter-note beats) from `from` up to, not including, `until`. */
export function meterBeatsBetween(meter: MeterChange[], from: number, until: number): number[] {
  const out: number[] = [];
  const all = spans(meter);
  all.forEach((s, i) => {
    const end = all[i + 1]?.at ?? Number.POSITIVE_INFINITY;
    const lo = Math.max(from, s.at);
    const hi = Math.min(until, end);
    if (!(hi > lo)) return;
    for (let k = Math.ceil((lo - s.at) / s.step - EPS); ; k++) {
      const b = s.at + k * s.step;
      if (b >= hi - EPS) break;
      out.push(b);
    }
  });
  return out;
}

/**
 * The `count` beats of the meter just before `from`, earliest first: the grid continued back,
 * before beat 0 at the first meter.
 */
export function meterBeatsBefore(meter: MeterChange[], from: number, count: number): number[] {
  const all = spans(meter);
  const out: number[] = [];
  let cursor = from;
  while (out.length < count) {
    const s = all.findLast((x) => x.at < cursor - EPS) ?? (all[0] as { at: number; step: number });
    const k = Math.ceil((cursor - s.at) / s.step - EPS) - 1;
    const b = s.at + k * s.step;
    out.push(b);
    cursor = b;
  }
  return out.reverse();
}

/** A loop of a score as rendered at a speed: where its beats, bars and count-in clicks fall. */
export interface LoopGrid {
  from_beats: number;
  until_beats: number;
  speed: number;
  /** Seconds the loop's start sits at in the rendition (the score at speed). */
  start_seconds: number;
  /** Seconds one pass lasts by the tempo map (the rendered WAV says its exact frames). */
  seconds: number;
  /** Loop seconds of each beat of the meter, from 0. */
  beats: number[];
  /** Loop seconds of each bar start. */
  bars: number[];
  count_in: { beats: number; seconds: number; times: number[] };
}

export function loopGrid(
  doc: Pick<ScoreDoc, 'tempo' | 'meter'>,
  a: { from_beats: number; until_beats: number; speed: number; count_in_beats: number },
): LoopGrid {
  if (!(a.until_beats > a.from_beats)) {
    throw new CfError(
      'bad_request',
      `until_beats (${a.until_beats}) must be after from_beats (${a.from_beats})`,
    );
  }
  const tempo = tempoAtSpeed(doc.tempo, a.speed);
  const t0 = beatsToSeconds(tempo, a.from_beats);
  const at = (b: number) => beatsToSeconds(tempo, b) - t0;
  const bars = barsBetween({ tempo, meter: doc.meter }, a.from_beats, a.until_beats, 100_000);
  const times = meterBeatsBefore(doc.meter, a.from_beats, a.count_in_beats).map(at);
  return {
    from_beats: a.from_beats,
    until_beats: a.until_beats,
    speed: a.speed,
    start_seconds: t0,
    seconds: at(a.until_beats),
    beats: meterBeatsBetween(doc.meter, a.from_beats, a.until_beats).map(at),
    bars: bars.map((b) => at(b.beats)),
    count_in: {
      beats: a.count_in_beats,
      seconds: times.length ? -(times[0] as number) : 0,
      times,
    },
  };
}

/**
 * The score beat a position in the loop falls on: `at_seconds` into pass `pass` of the loop as
 * rendered at `speed`. Pass 0 may be negative (before the loop starts, in the count-in): it falls
 * on the score's own beats leading into the loop, as the count-in clicks do.
 */
export function loopBeat(
  tempo: TempoChange[],
  loop: { from_beats: number; until_beats: number; speed: number },
  at_seconds: number,
  pass: number,
): number {
  const scaled = tempoAtSpeed(tempo, loop.speed);
  const t0 = beatsToSeconds(scaled, loop.from_beats);
  return secondsToBeats(scaled, t0 + at_seconds) + pass * (loop.until_beats - loop.from_beats);
}

/** Which pitch plays what on a part's drum kits and sliced samplers (enabled instruments). */
export function partPads(
  doc: ScoreDoc,
  partId: string,
): { pads: Array<{ pitch: number; name: string; plays: string }>; other: boolean } {
  const part = findPart(doc, partId);
  const found = new Map<number, string>();
  let other = false;
  for (const d of part.devices) {
    if (d.enabled === false || deviceKind(d.name) !== 'instrument') continue;
    const spec = (DEVICES as Record<string, DeviceSpec>)[d.name];
    const slices = d.params.slices as
      | Array<{ note: string | number; from_seconds: number; until_seconds: number }>
      | undefined;
    if (spec?.sounds) {
      for (const [p, plays] of Object.entries(spec.sounds)) {
        if (!found.has(Number(p))) found.set(Number(p), plays);
      }
    } else if (d.name === 'sampler' && slices?.length) {
      for (const s of slices) {
        const pitch = pitchNumber(s.note);
        if (!found.has(pitch)) {
          found.set(
            pitch,
            `${String(d.params.media_id)} from ${s.from_seconds} s until ${s.until_seconds} s`,
          );
        }
      }
    } else other = true;
  }
  return {
    pads: [...found.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([pitch, plays]) => ({ pitch, name: pitchName(pitch).name, plays })),
    other,
  };
}

function nextId(doc: ScoreDoc, prefix: string): string {
  const id = `${prefix}${doc.next_id}`;
  doc.next_id += 1;
  return id;
}

export interface TakeLoop {
  part_id: string;
  from_beats: number;
  until_beats: number;
  speed: number;
}

export interface PadsTakeArgs extends TakeLoop {
  /** Every note's length, in beats (the agent's). */
  length_beats: number;
  /** The velocity of a tap that carries none (the agent's). */
  velocity: number;
  taps: Array<{ pitch: number; at_seconds: number; pass: number; velocity?: number | undefined }>;
}

export interface PlacedTap {
  note_id: string;
  pitch: number;
  pass: number;
  at_seconds: number;
  /** Beats in the score. */
  beats: number;
  velocity: number;
  velocity_measured: boolean;
  sounds: boolean;
}

/**
 * Puts a pads take into `doc` (a copy) as one new notes region over the loop's range on the
 * part, a note per tap at the exact beat it was played on, in the order sent.
 */
export function applyPadsTake(
  doc: ScoreDoc,
  a: PadsTakeArgs,
): { region_id: string; note_ids: string[]; taps: PlacedTap[] } {
  const part = findPart(doc, a.part_id);
  const source = nextId(doc, 'src');
  const region: Extract<StoredRegion, { type: 'notes' }> = {
    id: nextId(doc, 'r'),
    type: 'notes',
    start: a.from_beats,
    length: a.until_beats - a.from_beats,
    source,
    offset: 0,
  };
  const notes: StoredNote[] = [];
  const taps: PlacedTap[] = a.taps.map((t) => {
    const beats = loopBeat(doc.tempo, a, t.at_seconds, t.pass);
    const note: StoredNote = {
      id: nextId(doc, 'n'),
      pitch: t.pitch,
      at: beats - region.start,
      length: a.length_beats,
      velocity: t.velocity ?? a.velocity,
    };
    notes.push(note);
    return {
      note_id: note.id,
      pitch: t.pitch,
      pass: t.pass,
      at_seconds: t.at_seconds,
      beats,
      velocity: note.velocity,
      velocity_measured: t.velocity !== undefined,
      sounds: soundsIn(region, note.at),
    };
  });
  doc.sources[source] = { notes };
  part.regions.push(region);
  checkLimits(doc);
  return { region_id: region.id, note_ids: notes.map((x) => x.id), taps };
}

export interface MicrophoneTakeArgs extends TakeLoop {
  /** Where the recording's first sample sits in pass 0 of the loop, in loop seconds at speed. */
  starts_at_seconds: number;
  media: { media_id: string; name: string; duration: number };
}

export interface PlacedRecording {
  region_id: string;
  /** Beats in the score of the recording's first and last sample. */
  at_beats: number;
  end_beats: number;
  /** Seconds of the recording the region plays. */
  from: number;
  until: number;
  fit_beats?: number;
}

/**
 * Puts a microphone take into `doc` (a copy) as one new audio region on the part: the recording
 * placed so each moment of it sits on the beat that was heard as it was recorded, its edges the
 * loop's range (what is before or after stays in the media, silent until the region is widened).
 * At a speed other than 1 the region is stretched to the beats it was played over, pitch
 * unchanged (evenly in beats: exact where the tempo holds steady across it).
 */
export function applyMicrophoneTake(doc: ScoreDoc, a: MicrophoneTakeArgs): PlacedRecording {
  const part = findPart(doc, a.part_id);
  const scaled = tempoAtSpeed(doc.tempo, a.speed);
  const t0 = beatsToSeconds(scaled, a.from_beats);
  const t1 = beatsToSeconds(scaled, a.until_beats);
  const first = t0 + a.starts_at_seconds;
  const from = Math.max(0, t0 - first);
  const until = Math.min(a.media.duration, t1 - first);
  if (!(until > from)) {
    throw new CfError(
      'bad_request',
      `The recording (${a.media.duration} s from ${a.starts_at_seconds} s in the loop) has no sound inside the loop's range (0 to ${t1 - t0} s at speed ${a.speed})`,
    );
  }
  const start = secondsToBeats(scaled, first + from);
  const end = secondsToBeats(scaled, first + until);
  const region: Extract<StoredRegion, { type: 'audio' }> = {
    id: nextId(doc, 'r'),
    type: 'audio',
    start,
    media_id: a.media.media_id,
    from,
    until,
    ...(a.speed !== 1 ? { fit_beats: end - start } : {}),
    gain_db: 0,
  };
  doc.media[a.media.media_id] = { name: a.media.name, duration: a.media.duration };
  part.regions.push(region);
  checkLimits(doc);
  return {
    region_id: region.id,
    at_beats: secondsToBeats(scaled, first),
    end_beats: secondsToBeats(scaled, first + a.media.duration),
    from,
    until,
    ...(region.fit_beats !== undefined ? { fit_beats: region.fit_beats } : {}),
  };
}

/** A take's fingerprint: SHA-256 of its body as canonical JSON (key order does not count). */
export function takeDigest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * One take a session, safe to repeat: the first body is the take; the same body again is
 * answered as the first was; any other body after it is refused.
 */
export function takeAgain(stored: string | undefined, body: unknown): 'first' | 'same' | 'other' {
  if (stored === undefined) return 'first';
  return stored === takeDigest(body) ? 'same' : 'other';
}
