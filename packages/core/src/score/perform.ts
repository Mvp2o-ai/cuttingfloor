import {
  type AutomationCurve,
  type AutomationTarget,
  CfError,
  deviceKind,
  deviceParamsApplied,
  pitchNumber,
  type ScoreDoc,
  type StoredDevice,
  type StoredPart,
} from '@cuttingfloor/schema';
import { findPart, regionLength } from './edit.ts';
import { beatsToSeconds, tempoAt } from './time.ts';

// A performance: a score flattened into what an engine plays for a range of it. Every time is in
// seconds from the start of the range (so a note that began before the range has a negative
// start); every pitch is a number; every device param is applied with its defaults. The engine
// needs no tempo map: where the tempo glides, points are added so a straight line between them
// stays within the tolerances below.

/**
 * How far a straight line between two points may stray from the true curve: 0.1% of the move
 * between the two automation points it lies between (a gain going 0 to −12 dB within 0.012 dB),
 * and 1 ms of source for a stretched audio region's time map.
 */
export const PERFORM_TOLERANCE = { valueFraction: 0.001, stretchSeconds: 0.001 } as const;

/** No more than this many halvings of one segment (4,096 pieces), whatever the tolerance asks. */
const MAX_DEPTH = 12;

export interface PerformedDevice {
  device_id: string;
  name: string;
  kind: 'instrument' | 'effect';
  /**
   * Every param it applies, defaults filled in. Pitches (root_note, slices[].note) are numbers;
   * a delay's time_beats becomes time_ms at the tempo where the range starts.
   */
  params: Record<string, unknown>;
}

export interface PerformedSend {
  send_id: string;
  /** A part in the performance. */
  to_part_id: string;
  level_db: number;
  /** Taken before the part's own gain and pan. */
  before_gain: boolean;
}

export interface PerformedNote {
  note_id: string;
  region_id: string;
  /** Seconds from the start of the range; negative when it began before the range. */
  start: number;
  /** Seconds it lasts, at its full length (a note that starts in its region plays all of it). */
  length: number;
  /** A MIDI number, decimals allowed (60 is middle C). */
  pitch: number;
  velocity: number;
}

export interface PerformedAudio {
  region_id: string;
  media_id: string;
  /** Seconds from the start of the range; negative when it began before the range. */
  start: number;
  /** Seconds it lasts in the score. */
  length: number;
  /** The seconds of the media it plays. */
  source: { from: number; until: number };
  gain_db: number;
  /**
   * null: the source plays at its own speed. Otherwise fit_beats stretched it, pitch unchanged:
   * which second of the source plays at each time, a straight line between points (more points
   * where the tempo changes or glides).
   */
  stretch: Array<{ at: number; source: number }> | null;
}

export interface PerformedPart {
  part_id: string;
  name: string;
  /** true: its own notes and audio play; false: it only passes on what reaches it. */
  plays: boolean;
  gain_db: number;
  pan: number;
  /** master or a part in the performance. */
  output: string;
  /** Enabled devices in the order they sound: instruments, then effects. */
  devices: PerformedDevice[];
  /** Sends to parts in the performance. */
  sends: PerformedSend[];
  /** Notes that sound in the range, by start; empty without an enabled instrument. */
  notes: PerformedNote[];
  /** Audio regions that sound in the range, by start. */
  audio: PerformedAudio[];
}

export interface PerformedLane {
  /** A part, send or device in the performance, and the param it moves. */
  target: AutomationTarget;
  /**
   * The param's value over the whole range, replacing its static value: from the first point
   * (at 0) to the last (at the range's end). hold keeps a value to the next point; linear moves
   * in a straight line to it. Two points at one time are a jump.
   */
  points: Array<{ at: number; value: number; curve: 'hold' | 'linear' }>;
}

/** What an engine plays for a range of a score. The type the engine plugs into. */
export interface Performance {
  sample_rate: ScoreDoc['sample_rate'];
  /** The range in the score; every other time is seconds from from_seconds. */
  range: { from_beats: number; until_beats: number; from_seconds: number; until_seconds: number };
  /** Parts whose own notes or audio sound in the range and reach the master (after mute, solo and parts). */
  played: string[];
  /** Parts that only pass on sound reaching them (a group, a shared reverb). */
  carried: string[];
  /** The parts in play, in score order. */
  parts: PerformedPart[];
  master: { devices: PerformedDevice[] };
  automation: PerformedLane[];
  /** Media the performance plays: name and seconds of sound. */
  media: Record<string, { name: string; duration: number }>;
}

export interface PerformOptions {
  from_beats: number;
  until_beats: number;
  /** Only these parts play their own notes and audio (the rest silent). Default all. */
  parts?: string[];
}

function performDevice(d: StoredDevice, tempo: number): PerformedDevice {
  const params = deviceParamsApplied(d.name, d.params);
  if (params.root_note !== undefined) params.root_note = pitchNumber(params.root_note as string);
  if (Array.isArray(params.slices)) {
    params.slices = (params.slices as Array<Record<string, unknown>>).map((s) => ({
      ...s,
      note: pitchNumber(s.note as string),
    }));
  }
  if (d.name === 'delay' && typeof params.time_beats === 'number') {
    params.time_ms = (params.time_beats * 60_000) / tempo;
    delete params.time_beats;
  }
  return { device_id: d.id, name: d.name, kind: deviceKind(d.name) ?? 'effect', params };
}

const smooth = (u: number) => (1 - Math.cos(Math.PI * u)) / 2;

/** A lane's value at a beat: points sorted by beat, a curve from each to the next. */
function valueAt(
  points: Array<{ at: number; value: number; curve: AutomationCurve }>,
  beat: number,
): number {
  const first = points[0];
  if (!first) return 0;
  if (beat < first.at) return first.value;
  let i = 0;
  while (i + 1 < points.length && (points[i + 1] as { at: number }).at <= beat) i += 1;
  const p = points[i] as (typeof points)[number];
  const next = points[i + 1];
  if (!next || p.curve === 'hold' || next.at === p.at) return p.value;
  const u = (beat - p.at) / (next.at - p.at);
  return p.value + (next.value - p.value) * (p.curve === 'smooth' ? smooth(u) : u);
}

/**
 * Beats in [b0, b1] at which to give `f` (a value that moves in beats) so a straight line in
 * seconds between neighbours stays within `tol` of it: the ends, every tempo change between,
 * and halvings until seven samples inside each piece are within `tol`.
 */
function grid(
  doc: ScoreDoc,
  b0: number,
  b1: number,
  f: (beat: number) => number,
  tol: number,
): number[] {
  const sec = (b: number) => beatsToSeconds(doc.tempo, b);
  const ok = (a: number, b: number) => {
    const [ta, tb, fa, fb] = [sec(a), sec(b), f(a), f(b)];
    for (let k = 1; k < 8; k++) {
      const m = a + ((b - a) * k) / 8;
      const line = fa + ((fb - fa) * (sec(m) - ta)) / (tb - ta);
      if (Math.abs(line - f(m)) > tol) return false;
    }
    return true;
  };
  const marks = [b0, ...doc.tempo.map((t) => t.at).filter((at) => at > b0 && at < b1), b1];
  const out: number[] = [b0];
  const refine = (a: number, b: number, depth: number) => {
    if (depth < MAX_DEPTH && b > a && !ok(a, b)) {
      const m = (a + b) / 2;
      refine(a, m, depth + 1);
      out.push(m);
      refine(m, b, depth + 1);
    }
  };
  for (let i = 0; i + 1 < marks.length; i++) {
    refine(marks[i] as number, marks[i + 1] as number, 0);
    out.push(marks[i + 1] as number);
  }
  return out;
}

/** Flattens a range of a score into what an engine plays, every time in seconds. */
export function performScore(doc: ScoreDoc, options: PerformOptions): Performance {
  const { from_beats: from, until_beats: until } = options;
  if (!(until > from)) {
    throw new CfError('bad_request', `until_beats (${until}) must be after from_beats (${from})`);
  }
  for (const id of options.parts ?? []) findPart(doc, id);
  const sec = (beat: number) => beatsToSeconds(doc.tempo, beat);
  const t0 = sec(from);
  const rel = (beat: number) => sec(beat) - t0;
  const tempo = tempoAt(doc.tempo, from);
  const byId = new Map(doc.parts.map((p) => [p.id, p]));

  // Which parts play their own sound, and where sound can reach the master.
  const anySolo = doc.parts.some((p) => p.solo);
  const chosen = options.parts ? new Set(options.parts) : undefined;
  const plays = (p: StoredPart) => !p.mute && (!anySolo || p.solo) && (!chosen || chosen.has(p.id));
  const reach = new Map<string, boolean>();
  const reaches = (id: string): boolean => {
    const known = reach.get(id);
    if (known !== undefined) return known;
    const p = byId.get(id);
    let r = false;
    if (p && !p.mute) {
      r = p.output === 'master' || reaches(p.output) || p.sends.some((s) => reaches(s.to));
    }
    reach.set(id, r);
    return r;
  };
  const live = (id: string) => byId.get(id)?.mute === false && reaches(id);

  const performed = new Map<string, PerformedPart>();
  for (const p of doc.parts) {
    if (!plays(p) || !reaches(p.id)) continue;
    const instrument = p.devices.some(
      (d) => d.enabled !== false && deviceKind(d.name) === 'instrument',
    );
    const notes: PerformedNote[] = [];
    const audio: PerformedAudio[] = [];
    for (const r of p.regions) {
      if (r.type === 'notes') {
        if (!instrument) continue;
        for (const n of doc.sources[r.source]?.notes ?? []) {
          if (n.at < r.offset || n.at >= r.offset + r.length) continue;
          const at = r.start + n.at - r.offset;
          if (at >= until || at + n.length <= from) continue;
          notes.push({
            note_id: n.id,
            region_id: r.id,
            start: rel(at),
            length: sec(at + n.length) - sec(at),
            pitch: n.pitch,
            velocity: n.velocity,
          });
        }
        continue;
      }
      const length = regionLength(doc, r);
      if (r.start >= until || r.start + length <= from) continue;
      let stretch: PerformedAudio['stretch'] = null;
      if (r.fit_beats !== undefined) {
        const fit = r.fit_beats;
        const src = (b: number) => r.from + ((b - r.start) * (r.until - r.from)) / fit;
        const beats = grid(doc, r.start, r.start + fit, src, PERFORM_TOLERANCE.stretchSeconds);
        stretch = beats.map((b) => ({ at: rel(b), source: src(b) }));
      }
      audio.push({
        region_id: r.id,
        media_id: r.media_id,
        start: rel(r.start),
        length: sec(r.start + length) - sec(r.start),
        source: { from: r.from, until: r.until },
        gain_db: r.gain_db,
        stretch,
      });
    }
    if (!notes.length && !audio.length) continue;
    notes.sort((a, b) => a.start - b.start);
    audio.sort((a, b) => a.start - b.start);
    performed.set(p.id, partOf(p, true, notes, audio));
  }
  const played = [...performed.keys()];
  // Parts the played ones sound through or send to, down to the master.
  const queue = [...played];
  while (queue.length) {
    const p = byId.get(queue.shift() as string) as StoredPart;
    for (const next of [p.output, ...p.sends.map((s) => s.to)]) {
      if (next === 'master' || performed.has(next) || !live(next)) continue;
      performed.set(next, partOf(byId.get(next) as StoredPart, false, [], []));
      queue.push(next);
    }
  }
  function partOf(
    p: StoredPart,
    own: boolean,
    notes: PerformedNote[],
    audio: PerformedAudio[],
  ): PerformedPart {
    return {
      part_id: p.id,
      name: p.name,
      plays: own,
      gain_db: p.gain_db,
      pan: p.pan,
      output: p.output,
      devices: p.devices.filter((d) => d.enabled !== false).map((d) => performDevice(d, tempo)),
      sends: p.sends
        .filter((s) => live(s.to))
        .map((s) => ({
          send_id: s.id,
          to_part_id: s.to,
          level_db: s.level_db,
          before_gain: s.before_gain,
        })),
      notes,
      audio,
    };
  }
  const parts = doc.parts.flatMap((p) => {
    const x = performed.get(p.id);
    return x ? [x] : [];
  });
  const master = {
    devices: doc.master.devices
      .filter((d) => d.enabled !== false)
      .map((d) => performDevice(d, tempo)),
  };

  // Automation on what is in play, as points in seconds.
  const sends = new Set(parts.flatMap((p) => p.sends.map((s) => s.send_id)));
  const devices = new Set([
    ...parts.flatMap((p) => p.devices.map((d) => d.device_id)),
    ...master.devices.map((d) => d.device_id),
  ]);
  const automation: PerformedLane[] = [];
  for (const lane of doc.automation) {
    const t = lane.target;
    const inPlay =
      'part_id' in t
        ? performed.has(t.part_id)
        : 'send_id' in t
          ? sends.has(t.send_id)
          : devices.has(t.device_id);
    if (!inPlay || !lane.points.length) continue;
    automation.push({ target: t, points: lanePoints(doc, lane.points, from, until, rel) });
  }

  const media: Performance['media'] = {};
  const used = new Set([
    ...parts.flatMap((p) => p.audio.map((a) => a.media_id)),
    ...[...parts.flatMap((p) => p.devices), ...master.devices].flatMap((d) =>
      typeof d.params.media_id === 'string' ? [d.params.media_id] : [],
    ),
  ]);
  for (const id of used) {
    const m = doc.media[id];
    if (m) media[id] = { name: m.name, duration: m.duration };
  }
  return {
    sample_rate: doc.sample_rate,
    range: { from_beats: from, until_beats: until, from_seconds: t0, until_seconds: sec(until) },
    played,
    carried: parts.filter((p) => !p.plays).map((p) => p.part_id),
    parts,
    master,
    automation,
    media,
  };
}

/** A lane's points over [from, until) as seconds from the range start. */
function lanePoints(
  doc: ScoreDoc,
  points: Array<{ at: number; value: number; curve: AutomationCurve }>,
  from: number,
  until: number,
  rel: (beat: number) => number,
): PerformedLane['points'] {
  // Segments between the range's ends and every point inside, each with its curve.
  const cuts = [
    ...new Set([from, ...points.map((p) => p.at).filter((at) => at > from && at < until), until]),
  ];
  const out: PerformedLane['points'] = [];
  const push = (beat: number, value: number, curve: 'hold' | 'linear') => {
    out.push({ at: rel(beat), value, curve });
  };
  let close = valueAt(points, from);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    // The point in force across this segment (the last at or before a), and the next. Several
    // points on one beat are jumps: each is held for no time, the last governs what follows.
    const k = points.findLastIndex((p) => p.at <= a);
    const here = points[k];
    const next = points[k + 1];
    for (const p of points.filter((x) => x.at === a && a > from)) {
      if (p !== here) push(a, p.value, 'hold');
    }
    if (!here || !next || here.curve === 'hold') {
      const v = here ? here.value : valueAt(points, a);
      push(a, v, 'hold');
      close = v;
      continue;
    }
    // Inside the segment the value follows here's curve to next, in beats.
    const at = (x: number) => {
      const u = (x - here.at) / (next.at - here.at);
      return here.value + (next.value - here.value) * (here.curve === 'smooth' ? smooth(u) : u);
    };
    const tol = Math.max(
      Math.abs(next.value - here.value) * PERFORM_TOLERANCE.valueFraction,
      1e-12,
    );
    const beats = grid(doc, a, b, at, tol);
    for (const beat of beats.slice(0, -1)) push(beat, at(beat), 'linear');
    close = at(b);
  }
  // The value the range ends on closes the lane.
  push(until, close, 'hold');
  return out;
}
