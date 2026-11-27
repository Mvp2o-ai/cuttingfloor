import {
  type AutomationTarget,
  CfError,
  deviceKind,
  deviceNamesText,
  deviceParamAt,
  deviceParamsSchema,
  deviceParamsText,
  pitchNumber,
  SCORE_LIMITS,
  type ScoreDoc,
  type ScoreEditArgsOf,
  type ScoreEditTool,
  type StoredDevice,
  type StoredNote,
  type StoredPart,
  type StoredRegion,
} from '@cuttingfloor/schema';
import { beatsToSeconds, secondsToBeats } from './time.ts';

// Score edits: pure functions over a copy of a score document. Each does exactly what its
// arguments say: nothing is rounded, moved to a grid or chosen for the agent. The only numbers
// here are the platform limits (SCORE_LIMITS), each refused with its number.

/** What a score needs to know about a media: whether it has sound, and how long it is. */
export interface ScoreMedia {
  name: string;
  /** Seconds. */
  duration: number;
  audio: boolean;
}

/** This owner's media by id; undefined for an id the owner does not have. */
export type ScoreMediaResolver = (mediaId: string) => ScoreMedia | undefined;

export interface ScoreOutcome {
  part_id?: string;
  device_id?: string;
  region_id?: string;
  send_id?: string;
  note_ids?: string[];
  /** score.unique_region: the mirrored note each of note_ids copies. */
  copied_from?: string[];
  /** score.split_region: the left piece (which kept its id). */
  left_id?: string;
  warnings: string[];
}

/** A fresh, empty score. */
export function newScore(a: {
  name: string;
  tempo: number;
  meter: { beats: number; unit: ScoreDoc['meter'][number]['unit'] };
  sample_rate: ScoreDoc['sample_rate'];
  fps?: ScoreDoc['fps'];
}): ScoreDoc {
  return {
    version: 1,
    name: a.name,
    sample_rate: a.sample_rate,
    ...(a.fps ? { fps: a.fps } : {}),
    tempo: [{ at: 0, bpm: a.tempo }],
    meter: [{ bar: 1, beats: a.meter.beats, unit: a.meter.unit }],
    markers: [],
    parts: [],
    master: { devices: [] },
    sources: {},
    automation: [],
    media: {},
    next_id: 1,
    parent: null,
  };
}

/**
 * Applies one edit to `doc` in place. Callers pass a copy; documents are immutable once stored.
 * Throws CfError for an edit that cannot be made, leaving the copy unusable.
 */
export function applyScoreEdit<T extends ScoreEditTool>(
  doc: ScoreDoc,
  tool: T,
  args: ScoreEditArgsOf<T>,
  media: ScoreMediaResolver,
): ScoreOutcome {
  const handlers: {
    [K in ScoreEditTool]: (
      d: ScoreDoc,
      a: ScoreEditArgsOf<K>,
      m: ScoreMediaResolver,
    ) => ScoreOutcome;
  } = {
    'score.set_tempo': setTempo,
    'score.set_meter': setMeter,
    'score.set_markers': setMarkers,
    'score.add_part': addPart,
    'score.set_part': setPart,
    'score.remove_part': removePart,
    'score.add_device': addDevice,
    'score.set_device': setDevice,
    'score.remove_device': removeDevice,
    'score.add_notes': addNotesTool,
    'score.set_notes': setNotes,
    'score.remove_notes': removeNotes,
    'score.add_region': addRegion,
    'score.move_region': moveRegion,
    'score.trim_region': trimRegion,
    'score.split_region': splitRegion,
    'score.alias_region': aliasRegion,
    'score.unique_region': uniqueRegion,
    'score.remove_region': removeRegion,
    'score.set_automation': setAutomation,
    'score.add_send': addSend,
    'score.set_send': setSend,
    'score.remove_send': removeSend,
  };
  const handler = handlers[tool] as (
    d: ScoreDoc,
    a: ScoreEditArgsOf<T>,
    m: ScoreMediaResolver,
  ) => ScoreOutcome;
  const outcome = handler(doc, args, media);
  prune(doc);
  checkLimits(doc);
  return outcome;
}

// ---------------------------------------------------------------------------- helpers

const done = (extra: Omit<ScoreOutcome, 'warnings'> = {}): ScoreOutcome => ({
  ...extra,
  warnings: [],
});

function nextId(doc: ScoreDoc, prefix: string): string {
  const id = `${prefix}${doc.next_id}`;
  doc.next_id += 1;
  return id;
}

const fmt = (x: number) => String(Math.round(x * 1e6) / 1e6);

const listOf = (ids: string[], none: string) =>
  ids.length ? ids.slice(0, 40).join(', ') + (ids.length > 40 ? ', …' : '') : none;

/**
 * A position argument given in beats or in seconds (`at_beats` or `at_seconds`), as beats.
 * Exactly one of the pair when required, at most one otherwise.
 */
export function beatsArg(
  doc: Pick<ScoreDoc, 'tempo'>,
  a: Record<string, unknown>,
  key: string,
  required: true,
): number;
export function beatsArg(
  doc: Pick<ScoreDoc, 'tempo'>,
  a: Record<string, unknown>,
  key: string,
  required?: false,
): number | undefined;
export function beatsArg(
  doc: Pick<ScoreDoc, 'tempo'>,
  a: Record<string, unknown>,
  key: string,
  required = false,
): number | undefined {
  const b = a[`${key}_beats`] as number | undefined;
  const s = a[`${key}_seconds`] as number | undefined;
  if (b !== undefined && s !== undefined) {
    throw new CfError('bad_request', `Give one of ${key}_beats or ${key}_seconds, not both`);
  }
  if (b !== undefined) return b;
  if (s !== undefined) return secondsToBeats(doc.tempo, s);
  if (required) {
    throw new CfError('bad_request', `Give ${key}_beats or ${key}_seconds`);
  }
  return undefined;
}

/** A length given in beats or in seconds (from `start`, a beat), as beats. */
function lengthArg(
  doc: ScoreDoc,
  a: { length_beats?: number | undefined; length_seconds?: number | undefined },
  start: number,
): number | undefined {
  if (a.length_beats !== undefined && a.length_seconds !== undefined) {
    throw new CfError('bad_request', 'Give one of length_beats or length_seconds, not both');
  }
  if (a.length_beats !== undefined) return a.length_beats;
  if (a.length_seconds !== undefined) {
    return secondsToBeats(doc.tempo, beatsToSeconds(doc.tempo, start) + a.length_seconds) - start;
  }
  return undefined;
}

export function findPart(doc: ScoreDoc, id: string): StoredPart {
  const part = doc.parts.find((p) => p.id === id);
  if (!part) {
    throw new CfError('not_found', `No part ${id} in this score`, {
      hint: `Its parts: ${listOf(
        doc.parts.map((p) => `${p.id} (${p.name})`),
        'none yet',
      )}`,
    });
  }
  return part;
}

export function findRegion(
  doc: ScoreDoc,
  id: string,
): { part: StoredPart; region: StoredRegion; index: number } {
  for (const part of doc.parts) {
    const index = part.regions.findIndex((r) => r.id === id);
    const region = part.regions[index];
    if (region) return { part, region, index };
  }
  throw new CfError('not_found', `No region ${id} in this score`, {
    hint: `Its regions: ${listOf(
      doc.parts.flatMap((p) => p.regions.map((r) => r.id)),
      'none yet',
    )}`,
  });
}

type NotesRegion = Extract<StoredRegion, { type: 'notes' }>;
type AudioRegion = Extract<StoredRegion, { type: 'audio' }>;

function notesRegion(doc: ScoreDoc, id: string): { part: StoredPart; region: NotesRegion } {
  const { part, region } = findRegion(doc, id);
  if (region.type !== 'notes') {
    throw new CfError('bad_request', `Region ${id} is an audio region; notes go in a notes region`);
  }
  return { part, region };
}

export interface DeviceHome {
  /** The part, or null for the master. */
  part: StoredPart | null;
  devices: StoredDevice[];
  device: StoredDevice;
  index: number;
}

export function findDevice(doc: ScoreDoc, id: string): DeviceHome {
  for (const part of doc.parts) {
    const index = part.devices.findIndex((d) => d.id === id);
    const device = part.devices[index];
    if (device) return { part, devices: part.devices, device, index };
  }
  const index = doc.master.devices.findIndex((d) => d.id === id);
  const device = doc.master.devices[index];
  if (device) return { part: null, devices: doc.master.devices, device, index };
  throw new CfError('not_found', `No device ${id} in this score`, {
    hint: `Its devices: ${listOf(
      [...doc.parts.flatMap((p) => p.devices), ...doc.master.devices].map(
        (d) => `${d.id} (${d.name})`,
      ),
      'none yet',
    )}`,
  });
}

function findSend(doc: ScoreDoc, id: string) {
  for (const part of doc.parts) {
    const index = part.sends.findIndex((s) => s.id === id);
    const send = part.sends[index];
    if (send) return { part, send, index };
  }
  throw new CfError('not_found', `No send ${id} in this score`, {
    hint: `Its sends: ${listOf(
      doc.parts.flatMap((p) => p.sends.map((s) => `${s.id} (${p.id} to ${s.to})`)),
      'none yet',
    )}`,
  });
}

/** Every region using a notes source, in score order. */
export function regionsOf(
  doc: ScoreDoc,
  source: string,
): Array<{ part: StoredPart; region: NotesRegion }> {
  return doc.parts.flatMap((part) =>
    part.regions.flatMap((region) =>
      region.type === 'notes' && region.source === source ? [{ part, region }] : [],
    ),
  );
}

/** Whether a note at `at` (beats in its source) sounds in a notes region. */
export function soundsIn(region: NotesRegion, at: number): boolean {
  return at >= region.offset && at < region.offset + region.length;
}

/** The region a note is placed from: the first that plays it, else the first using its source. */
export function homeRegion(doc: ScoreDoc, source: string, at: number): NotesRegion {
  const all = regionsOf(doc, source);
  const home = all.find((r) => soundsIn(r.region, at)) ?? all[0];
  if (!home) throw new CfError('not_found', 'A note whose region was removed');
  return home.region;
}

function noteIndex(
  doc: ScoreDoc,
): Map<string, { source: string; note: StoredNote; index: number }> {
  const out = new Map<string, { source: string; note: StoredNote; index: number }>();
  for (const [source, s] of Object.entries(doc.sources)) {
    s.notes.forEach((note, index) => {
      out.set(note.id, { source, note, index });
    });
  }
  return out;
}

/** A region's length in beats: a notes region's own, an audio region's from its source. */
export function regionLength(doc: Pick<ScoreDoc, 'tempo'>, r: StoredRegion): number {
  if (r.type === 'notes') return r.length;
  if (r.fit_beats !== undefined) return r.fit_beats;
  const start = beatsToSeconds(doc.tempo, r.start);
  return secondsToBeats(doc.tempo, start + (r.until - r.from)) - r.start;
}

/** The end of the score: where its last region ends (0 with none). */
export function scoreEnd(doc: ScoreDoc): number {
  let end = 0;
  for (const p of doc.parts) {
    for (const r of p.regions) end = Math.max(end, r.start + regionLength(doc, r));
  }
  return end;
}

/** Seconds of an audio region's source a beat of the score plays (the beat inside the region). */
function sourceAt(doc: ScoreDoc, r: AudioRegion, beat: number): number {
  if (r.fit_beats !== undefined) {
    return r.from + ((beat - r.start) * (r.until - r.from)) / r.fit_beats;
  }
  return r.from + beatsToSeconds(doc.tempo, beat) - beatsToSeconds(doc.tempo, r.start);
}

function mediaFor(doc: ScoreDoc, resolve: ScoreMediaResolver, id: string): ScoreMedia {
  const m = resolve(id);
  if (!m) {
    throw new CfError('not_found', `No media ${id}`, {
      hint: 'A media_id exactly as media.import, media.list or a create.* tool gave it',
    });
  }
  if (!m.audio) {
    throw new CfError('no_audio', `Media ${id} (${m.name}) has no sound`, {
      detail: { media_id: id },
    });
  }
  doc.media[id] = { name: m.name, duration: m.duration };
  return m;
}

function checkRange(
  what: string,
  m: { name: string; duration: number },
  from: number,
  until: number,
): void {
  if (!(until > from)) {
    throw new CfError(
      'bad_request',
      `${what}: until_seconds (${fmt(until)}) must be after from_seconds (${fmt(from)})`,
    );
  }
  if (until > m.duration + 1e-9) {
    throw new CfError(
      'bad_request',
      `${what}: ${fmt(until)} s is past the end of ${m.name}, which is ${fmt(m.duration)} s long`,
    );
  }
}

/** The part a part sounds through (its output) and those it sends to: the routing graph. */
function routingLoop(doc: ScoreDoc): string[] | undefined {
  const edges = new Map<string, string[]>();
  for (const p of doc.parts) {
    edges.set(p.id, [...(p.output !== 'master' ? [p.output] : []), ...p.sends.map((s) => s.to)]);
  }
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'open');
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      const loop = visit(next);
      if (loop) return loop;
    }
    path.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const p of doc.parts) {
    const loop = visit(p.id);
    if (loop) return loop;
  }
  return undefined;
}

function assertNoLoop(doc: ScoreDoc): void {
  const loop = routingLoop(doc);
  if (loop) {
    throw new CfError(
      'bad_request',
      `That makes a loop of parts: ${loop.join(' to ')}. A part's sound cannot come back to it through outputs and sends`,
    );
  }
}

function checkOutput(doc: ScoreDoc, output: string): void {
  if (output !== 'master') findPart(doc, output);
}

function limit(what: string, count: number, max: number): void {
  if (count > max) {
    throw new CfError(
      'limit_exceeded',
      `${count.toLocaleString('en-US')} ${what}; a score holds up to ${max.toLocaleString('en-US')} (a limit of the platform)`,
      { detail: { limit: max, count } },
    );
  }
}

/** Every platform limit, checked after each edit and on load. */
export function checkLimits(doc: ScoreDoc): void {
  limit('parts', doc.parts.length, SCORE_LIMITS.parts);
  for (const p of doc.parts) {
    limit(`devices on part ${p.id}`, p.devices.length, SCORE_LIMITS.devices);
  }
  limit('devices on the master', doc.master.devices.length, SCORE_LIMITS.devices);
  limit(
    'regions',
    doc.parts.reduce((n, p) => n + p.regions.length, 0),
    SCORE_LIMITS.regions,
  );
  limit(
    'notes',
    Object.values(doc.sources).reduce((n, s) => n + s.notes.length, 0),
    SCORE_LIMITS.notes,
  );
  limit('markers', doc.markers.length, SCORE_LIMITS.markers);
  limit(
    'automation points',
    doc.automation.reduce((n, l) => n + l.points.length, 0),
    SCORE_LIMITS.automationPoints,
  );
  limit(
    'sends',
    doc.parts.reduce((n, p) => n + p.sends.length, 0),
    SCORE_LIMITS.sends,
  );
  limit('tempo changes', doc.tempo.length, SCORE_LIMITS.changes);
  limit('meter changes', doc.meter.length, SCORE_LIMITS.changes);
}

/** Drops notes sources no region uses and media nothing names: the document holds what it uses. */
function prune(doc: ScoreDoc): void {
  const used = new Set(
    doc.parts.flatMap((p) => p.regions.flatMap((r) => (r.type === 'notes' ? [r.source] : []))),
  );
  for (const id of Object.keys(doc.sources)) if (!used.has(id)) delete doc.sources[id];
  const media = new Set<string>();
  for (const p of doc.parts) {
    for (const r of p.regions) if (r.type === 'audio') media.add(r.media_id);
  }
  for (const d of [...doc.parts.flatMap((p) => p.devices), ...doc.master.devices]) {
    const m = d.params.media_id;
    if (typeof m === 'string') media.add(m);
  }
  for (const id of Object.keys(doc.media)) if (!media.has(id)) delete doc.media[id];
}

const sameTarget = (a: AutomationTarget, b: AutomationTarget) =>
  JSON.stringify([
    'part_id' in a ? a.part_id : null,
    'send_id' in a ? a.send_id : null,
    'device_id' in a ? a.device_id : null,
    a.param,
  ]) ===
  JSON.stringify([
    'part_id' in b ? b.part_id : null,
    'send_id' in b ? b.send_id : null,
    'device_id' in b ? b.device_id : null,
    b.param,
  ]);

function dropAutomation(doc: ScoreDoc, keep: (t: AutomationTarget) => boolean): void {
  doc.automation = doc.automation.filter((l) => keep(l.target));
}

// ---------------------------------------------------------------------------- the score

function setTempo(doc: ScoreDoc, a: ScoreEditArgsOf<'score.set_tempo'>): ScoreOutcome {
  if ((a.tempo === undefined) === (a.changes === undefined)) {
    throw new CfError('bad_request', 'Give one of tempo (one for all of it) or changes');
  }
  if (a.tempo !== undefined) {
    doc.tempo = [{ at: 0, bpm: a.tempo }];
    return done();
  }
  for (const [i, c] of (a.changes ?? []).entries()) {
    const at = beatsArg(doc, c, 'at', true);
    if (c.ramp && at === 0) {
      throw new CfError(
        'bad_request',
        `changes[${i}]: a ramp glides from the change before, and beat 0 has none`,
      );
    }
    const change = { at, bpm: c.tempo, ...(c.ramp ? { ramp: true } : {}) };
    const same = doc.tempo.findIndex((t) => t.at === at);
    if (same >= 0) doc.tempo[same] = change;
    else doc.tempo.push(change);
    doc.tempo.sort((x, y) => x.at - y.at);
  }
  return done();
}

function setMeter(doc: ScoreDoc, a: ScoreEditArgsOf<'score.set_meter'>): ScoreOutcome {
  const change = { bar: a.from_bar, beats: a.meter.beats, unit: a.meter.unit };
  const same = doc.meter.findIndex((m) => m.bar === a.from_bar);
  if (same >= 0) doc.meter[same] = change;
  else doc.meter.push(change);
  doc.meter.sort((x, y) => x.bar - y.bar);
  return done();
}

function setMarkers(doc: ScoreDoc, a: ScoreEditArgsOf<'score.set_markers'>): ScoreOutcome {
  doc.markers = a.markers.map((m, i) => {
    if ((m.at_beats === undefined) === (m.at_seconds === undefined)) {
      throw new CfError('bad_request', `markers[${i}]: give one of at_beats or at_seconds`);
    }
    const id = nextId(doc, 'k');
    return m.at_beats !== undefined
      ? { id, name: m.name, at_beats: m.at_beats }
      : { id, name: m.name, at_seconds: m.at_seconds as number };
  });
  return done();
}

// ---------------------------------------------------------------------------- parts

function addPart(doc: ScoreDoc, a: ScoreEditArgsOf<'score.add_part'>): ScoreOutcome {
  checkOutput(doc, a.output);
  const part: StoredPart = {
    id: nextId(doc, 'p'),
    name: a.name ?? `Part ${doc.parts.length + 1}`,
    gain_db: a.gain_db,
    pan: a.pan,
    mute: false,
    solo: false,
    output: a.output,
    devices: [],
    sends: [],
    regions: [],
  };
  doc.parts.push(part);
  return done({ part_id: part.id });
}

function setPart(doc: ScoreDoc, a: ScoreEditArgsOf<'score.set_part'>): ScoreOutcome {
  const part = findPart(doc, a.part_id);
  if (a.gain_db !== undefined) part.gain_db = a.gain_db;
  if (a.pan !== undefined) part.pan = a.pan;
  if (a.mute !== undefined) part.mute = a.mute;
  if (a.solo !== undefined) part.solo = a.solo;
  if (a.name !== undefined) part.name = a.name;
  if (a.output !== undefined) {
    if (a.output === part.id) {
      throw new CfError('bad_request', `Part ${part.id} cannot sound through itself`);
    }
    checkOutput(doc, a.output);
    part.output = a.output;
    assertNoLoop(doc);
  }
  return done({ part_id: part.id });
}

function removePart(doc: ScoreDoc, a: ScoreEditArgsOf<'score.remove_part'>): ScoreOutcome {
  const part = findPart(doc, a.part_id);
  const through = doc.parts.filter((p) => p.output === part.id).map((p) => p.id);
  if (through.length) {
    throw new CfError(
      'bad_request',
      `Part ${part.id} has parts sounding through it: ${through.join(', ')}. Their output names it`,
      { detail: { parts: through } },
    );
  }
  const sends = new Set(part.sends.map((s) => s.id));
  for (const p of doc.parts) {
    for (const s of p.sends) if (s.to === part.id) sends.add(s.id);
    p.sends = p.sends.filter((s) => s.to !== part.id);
  }
  const devices = new Set(part.devices.map((d) => d.id));
  doc.parts = doc.parts.filter((p) => p.id !== part.id);
  dropAutomation(
    doc,
    (t) =>
      !(
        ('part_id' in t && t.part_id === part.id) ||
        ('send_id' in t && sends.has(t.send_id)) ||
        ('device_id' in t && devices.has(t.device_id))
      ),
  );
  return done({ part_id: part.id });
}

// ---------------------------------------------------------------------------- devices

/** Checks a device's params against the registry and its media, and copies media it names in. */
function checkDeviceParams(
  doc: ScoreDoc,
  name: string,
  params: Record<string, unknown>,
  resolve: ScoreMediaResolver,
): Record<string, unknown> {
  const schema = deviceParamsSchema(name);
  if (!schema) {
    throw new CfError('bad_request', `No device named ${name}`, { hint: deviceNamesText() });
  }
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new CfError(
      'bad_request',
      `${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`,
      { hint: deviceParamsText(name) },
    );
  }
  const p = parsed.data as Record<string, unknown>;
  if (typeof p.media_id === 'string') {
    const m = mediaFor(doc, resolve, p.media_id);
    const from = (p.from_seconds as number | undefined) ?? 0;
    const until = (p.until_seconds as number | undefined) ?? m.duration;
    checkRange(`${name} ${p.media_id}`, m, from, until);
    const slices = (p.slices as Array<Record<string, unknown>> | undefined) ?? [];
    const seen = new Map<number, number>();
    slices.forEach((s, i) => {
      checkRange(`${name} slices[${i}]`, m, s.from_seconds as number, s.until_seconds as number);
      const pitch = pitchNumber(s.note as string | number);
      const before = seen.get(pitch);
      if (before !== undefined) {
        throw new CfError(
          'bad_request',
          `${name}: slices[${before}] and slices[${i}] are both on pitch ${pitch}; each pitch plays one slice`,
        );
      }
      seen.set(pitch, i);
    });
  }
  if (p.root_note !== undefined) pitchNumber(p.root_note as string | number);
  return p;
}

/** Where a device may go in a part's order: instruments before effects. */
function indexRange(devices: StoredDevice[], kind: 'instrument' | 'effect'): [number, number] {
  const instruments = devices.filter((d) => deviceKind(d.name) === 'instrument').length;
  return kind === 'instrument' ? [0, instruments] : [instruments, devices.length];
}

function placeDevice(
  devices: StoredDevice[],
  device: StoredDevice,
  at: number | undefined,
  where: string,
): void {
  const kind = deviceKind(device.name) ?? 'effect';
  const [lo, hi] = indexRange(devices, kind);
  const index = at ?? hi;
  if (index < lo || index > hi) {
    throw new CfError(
      'bad_request',
      `at_index ${index} puts ${device.name} (an ${kind}) ${kind === 'instrument' ? 'after an effect' : 'before an instrument'} on ${where}: instruments come first, then effects. An ${kind} goes at ${lo === hi ? lo : `${lo} to ${hi}`}`,
    );
  }
  devices.splice(index, 0, device);
}

function addDevice(
  doc: ScoreDoc,
  a: ScoreEditArgsOf<'score.add_device'>,
  resolve: ScoreMediaResolver,
): ScoreOutcome {
  if ((a.part_id === undefined) === !a.master) {
    throw new CfError('bad_request', 'Give one of part_id or master: true');
  }
  const kind = deviceKind(a.name);
  if (!kind)
    throw new CfError('bad_request', `No device named ${a.name}`, { hint: deviceNamesText() });
  if (a.master && kind === 'instrument') {
    throw new CfError(
      'bad_request',
      `${a.name} is an instrument; the master takes effects only (instruments play a part's notes)`,
      { hint: deviceNamesText() },
    );
  }
  const params = checkDeviceParams(doc, a.name, a.params, resolve);
  const device: StoredDevice = { id: nextId(doc, 'd'), name: a.name, params };
  const devices = a.part_id ? findPart(doc, a.part_id).devices : doc.master.devices;
  placeDevice(devices, device, a.at_index, a.part_id ? `part ${a.part_id}` : 'the master');
  return done({ device_id: device.id, ...(a.part_id ? { part_id: a.part_id } : {}) });
}

function checkDeviceAutomation(doc: ScoreDoc, device: StoredDevice): void {
  for (const lane of doc.automation) {
    const t = lane.target;
    if (!('device_id' in t) || t.device_id !== device.id) continue;
    const at = deviceParamAt(device.name, device.params, t.param);
    if ('error' in at) {
      throw new CfError(
        'bad_request',
        `Device ${device.id} has automation on ${t.param}, which these params no longer have: ${at.error}`,
      );
    }
  }
}

function setDevice(
  doc: ScoreDoc,
  a: ScoreEditArgsOf<'score.set_device'>,
  resolve: ScoreMediaResolver,
): ScoreOutcome {
  const home = findDevice(doc, a.device_id);
  const device = home.device;
  if (a.params) {
    const merged: Record<string, unknown> = { ...device.params };
    for (const [k, v] of Object.entries(a.params)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    device.params = checkDeviceParams(doc, device.name, merged, resolve);
    checkDeviceAutomation(doc, device);
  }
  if (a.enabled !== undefined) {
    if (a.enabled) delete device.enabled;
    else device.enabled = false;
  }
  if (a.at_index !== undefined) {
    home.devices.splice(home.index, 1);
    placeDevice(
      home.devices,
      device,
      a.at_index,
      home.part ? `part ${home.part.id}` : 'the master',
    );
  }
  return done({ device_id: device.id });
}

function removeDevice(doc: ScoreDoc, a: ScoreEditArgsOf<'score.remove_device'>): ScoreOutcome {
  const home = findDevice(doc, a.device_id);
  home.devices.splice(home.index, 1);
  dropAutomation(doc, (t) => !('device_id' in t && t.device_id === a.device_id));
  return done({ device_id: a.device_id });
}

// ---------------------------------------------------------------------------- notes

type NoteArgs = ScoreEditArgsOf<'score.add_notes'>['notes'][number];

/** Adds notes to a region's source, positions from the region's start; ids in the order given. */
function addNotes(
  doc: ScoreDoc,
  part: StoredPart,
  region: NotesRegion,
  notes: NoteArgs[],
): ScoreOutcome {
  const source = doc.sources[region.source];
  if (!source) throw new CfError('not_found', `Region ${region.id} has no notes source`);
  const ids: string[] = [];
  let silent = 0;
  const regionSeconds = beatsToSeconds(doc.tempo, region.start);
  for (const [i, n] of notes.entries()) {
    let rel: number;
    try {
      if ((n.at_beats === undefined) === (n.at_seconds === undefined)) {
        throw new CfError('bad_request', 'give one of at_beats or at_seconds');
      }
      rel =
        n.at_beats ??
        secondsToBeats(doc.tempo, regionSeconds + (n.at_seconds as number)) - region.start;
      const length = lengthArg(doc, n, region.start + rel);
      if (length === undefined)
        throw new CfError('bad_request', 'give length_beats or length_seconds');
      const note: StoredNote = {
        id: nextId(doc, 'n'),
        pitch: pitchNumber(n.pitch),
        at: region.offset + rel,
        length,
        velocity: n.velocity,
      };
      if (!soundsIn(region, note.at)) silent += 1;
      source.notes.push(note);
      ids.push(note.id);
    } catch (error) {
      if (error instanceof CfError) {
        throw new CfError(error.code, `notes[${i}]: ${error.message}`, {
          ...(error.hint ? { hint: error.hint } : {}),
        });
      }
      throw error;
    }
  }
  const out = done({ note_ids: ids, region_id: region.id, part_id: part.id });
  if (silent) {
    out.warnings.push(
      `${silent} of these notes start outside region ${region.id} (0 to ${fmt(region.length)} beats from its start): stored, but silent there`,
    );
  }
  if (!part.devices.some((d) => deviceKind(d.name) === 'instrument')) {
    out.warnings.push(
      `Part ${part.id} has no instrument yet: its notes are silent until one is on it`,
    );
  }
  return out;
}

function addNotesTool(doc: ScoreDoc, a: ScoreEditArgsOf<'score.add_notes'>): ScoreOutcome {
  const { part, region } = notesRegion(doc, a.region_id);
  return addNotes(doc, part, region, a.notes);
}

function uniqueIds(ids: string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new CfError('bad_request', `${what} ${id} is named twice`);
    seen.add(id);
  }
}

function missingNotes(ids: string[]): CfError {
  return new CfError('not_found', `No note ${listOf(ids, '')} in this score`, {
    hint: 'score.get include notes lists each region’s notes with their ids',
    detail: { note_ids: ids },
  });
}

function setNotes(doc: ScoreDoc, a: ScoreEditArgsOf<'score.set_notes'>): ScoreOutcome {
  uniqueIds(
    a.notes.map((n) => n.note_id),
    'Note',
  );
  const index = noteIndex(doc);
  const missing = a.notes.filter((n) => !index.has(n.note_id)).map((n) => n.note_id);
  if (missing.length) throw missingNotes(missing);
  let silent = 0;
  for (const [i, n] of a.notes.entries()) {
    const found = index.get(n.note_id);
    if (!found) continue;
    const note = found.note;
    const home = homeRegion(doc, found.source, note.at);
    try {
      if (n.at_beats !== undefined && n.at_seconds !== undefined) {
        throw new CfError('bad_request', 'give one of at_beats or at_seconds, not both');
      }
      // Both are from the start of the region the note sounds in.
      if (n.at_beats !== undefined) note.at = home.offset + n.at_beats;
      else if (n.at_seconds !== undefined) {
        const seconds = beatsToSeconds(doc.tempo, home.start) + n.at_seconds;
        note.at = home.offset + secondsToBeats(doc.tempo, seconds) - home.start;
      }
      const length = lengthArg(doc, n, home.start + note.at - home.offset);
      if (length !== undefined) note.length = length;
      if (n.pitch !== undefined) note.pitch = pitchNumber(n.pitch);
      if (n.velocity !== undefined) note.velocity = n.velocity;
    } catch (error) {
      if (error instanceof CfError) {
        throw new CfError(error.code, `notes[${i}] (${n.note_id}): ${error.message}`);
      }
      throw error;
    }
    if (!regionsOf(doc, found.source).some((r) => soundsIn(r.region, note.at))) silent += 1;
  }
  const out = done();
  if (silent) {
    out.warnings.push(
      `${silent} of these notes now start outside every region that holds them: stored, but silent`,
    );
  }
  return out;
}

function removeNotes(doc: ScoreDoc, a: ScoreEditArgsOf<'score.remove_notes'>): ScoreOutcome {
  uniqueIds(a.note_ids, 'Note');
  const index = noteIndex(doc);
  const missing = a.note_ids.filter((id) => !index.has(id));
  if (missing.length) throw missingNotes(missing);
  const gone = new Set(a.note_ids);
  for (const s of Object.values(doc.sources)) s.notes = s.notes.filter((n) => !gone.has(n.id));
  return done();
}

// ---------------------------------------------------------------------------- regions

function addRegion(
  doc: ScoreDoc,
  a: ScoreEditArgsOf<'score.add_region'>,
  resolve: ScoreMediaResolver,
): ScoreOutcome {
  const part = findPart(doc, a.part_id);
  const start = beatsArg(doc, a, 'at', true);
  if (a.media_id === undefined) {
    const audioOnly = (['source', 'fit_beats', 'gain_db'] as const).filter(
      (k) => a[k] !== undefined,
    );
    if (audioOnly.length) {
      throw new CfError(
        'bad_request',
        `${audioOnly.join(', ')} ${audioOnly.length === 1 ? 'is' : 'are'} for an audio region (with media_id); a notes region takes length and notes`,
      );
    }
    const length = lengthArg(doc, a, start);
    if (length === undefined) {
      throw new CfError('bad_request', 'A notes region needs length_beats or length_seconds');
    }
    const source = nextId(doc, 'src');
    doc.sources[source] = { notes: [] };
    const region: NotesRegion = {
      id: nextId(doc, 'r'),
      type: 'notes',
      start,
      length,
      source,
      offset: 0,
    };
    part.regions.push(region);
    if (a.notes?.length) {
      const added = addNotes(doc, part, region, a.notes);
      return { ...added, region_id: region.id, part_id: part.id };
    }
    return done({ region_id: region.id, part_id: part.id });
  }
  if (a.notes !== undefined) {
    throw new CfError('bad_request', 'An audio region (with media_id) takes no notes');
  }
  const m = mediaFor(doc, resolve, a.media_id);
  const from = a.source?.from_seconds ?? 0;
  let until = a.source?.until_seconds ?? m.duration;
  checkRange(`Media ${a.media_id}`, m, from, until);
  const given = lengthArg(doc, a, start);
  if (given !== undefined) {
    if (a.fit_beats !== undefined) {
      throw new CfError(
        'bad_request',
        'fit_beats sets an audio region’s length (its source stretched to that many beats); give one of fit_beats or a length',
      );
    }
    until = from + beatsToSeconds(doc.tempo, start + given) - beatsToSeconds(doc.tempo, start);
    checkRange(`Media ${a.media_id}`, m, from, until);
  }
  const region: AudioRegion = {
    id: nextId(doc, 'r'),
    type: 'audio',
    start,
    media_id: a.media_id,
    from,
    until,
    ...(a.fit_beats !== undefined ? { fit_beats: a.fit_beats } : {}),
    gain_db: a.gain_db ?? 0,
  };
  part.regions.push(region);
  return done({ region_id: region.id, part_id: part.id });
}

function moveRegion(doc: ScoreDoc, a: ScoreEditArgsOf<'score.move_region'>): ScoreOutcome {
  const { part, region, index } = findRegion(doc, a.region_id);
  const to = beatsArg(doc, a, 'to');
  if (to === undefined && a.part_id === undefined) {
    throw new CfError('bad_request', 'Give to_beats (or to_seconds), part_id, or both');
  }
  if (a.part_id !== undefined && a.part_id !== part.id) {
    const target = findPart(doc, a.part_id);
    part.regions.splice(index, 1);
    target.regions.push(region);
  }
  if (to !== undefined) region.start = to;
  return done({ region_id: region.id });
}

function trimRegion(doc: ScoreDoc, a: ScoreEditArgsOf<'score.trim_region'>): ScoreOutcome {
  const { region } = findRegion(doc, a.region_id);
  const to = beatsArg(doc, a, 'to', true);
  const end = region.start + regionLength(doc, region);
  if (a.edge === 'start' ? to >= end : to <= region.start) {
    throw new CfError(
      'bad_request',
      a.edge === 'start'
        ? `The start must stay before the end (beat ${fmt(end)})`
        : `The end must stay after the start (beat ${fmt(region.start)})`,
    );
  }
  if (region.type === 'notes') {
    if (a.edge === 'start') {
      region.offset += to - region.start;
      region.length = end - to;
      region.start = to;
    } else region.length = to - region.start;
    return done({ region_id: region.id });
  }
  const m = doc.media[region.media_id] ?? { name: region.media_id, duration: Infinity };
  if (a.edge === 'start') {
    const from = sourceAt(doc, region, to);
    if (from < -1e-9) {
      throw new CfError(
        'bad_request',
        `Beat ${fmt(to)} is before the start of ${m.name}: the region can start no earlier than beat ${fmt(beforeSource(doc, region))}`,
      );
    }
    if (region.fit_beats !== undefined) region.fit_beats -= to - region.start;
    region.from = Math.max(0, from);
    region.start = to;
  } else {
    const until = sourceAt(doc, region, to);
    checkRange(`Media ${region.media_id}`, m, region.from, until);
    if (region.fit_beats !== undefined) region.fit_beats = to - region.start;
    region.until = until;
  }
  return done({ region_id: region.id });
}

/** The beat an audio region's media would start on. */
function beforeSource(doc: ScoreDoc, r: AudioRegion): number {
  if (r.fit_beats !== undefined) return r.start - (r.from * r.fit_beats) / (r.until - r.from);
  return secondsToBeats(doc.tempo, beatsToSeconds(doc.tempo, r.start) - r.from);
}

function splitRegion(doc: ScoreDoc, a: ScoreEditArgsOf<'score.split_region'>): ScoreOutcome {
  const { part, region, index } = findRegion(doc, a.region_id);
  const at = beatsArg(doc, a, 'at', true);
  const end = region.start + regionLength(doc, region);
  if (!(at > region.start && at < end)) {
    throw new CfError(
      'bad_request',
      `Beat ${fmt(at)} is not inside region ${region.id} (beats ${fmt(region.start)} to ${fmt(end)})`,
    );
  }
  let right: StoredRegion;
  if (region.type === 'notes') {
    right = {
      ...region,
      id: nextId(doc, 'r'),
      start: at,
      length: end - at,
      offset: region.offset + (at - region.start),
    };
    region.length = at - region.start;
  } else {
    const cut = sourceAt(doc, region, at);
    right = {
      ...region,
      id: nextId(doc, 'r'),
      start: at,
      from: cut,
      ...(region.fit_beats !== undefined ? { fit_beats: end - at } : {}),
    };
    region.until = cut;
    if (region.fit_beats !== undefined) region.fit_beats = at - region.start;
  }
  part.regions.splice(index + 1, 0, right);
  return done({ region_id: right.id, left_id: region.id });
}

function aliasRegion(doc: ScoreDoc, a: ScoreEditArgsOf<'score.alias_region'>): ScoreOutcome {
  const { part, region } = findRegion(doc, a.region_id);
  const target = a.part_id !== undefined ? findPart(doc, a.part_id) : part;
  const at = beatsArg(doc, a, 'at', true);
  const copy: StoredRegion = { ...region, id: nextId(doc, 'r'), start: at };
  target.regions.push(copy);
  return done({ region_id: copy.id, part_id: target.id });
}

function uniqueRegion(doc: ScoreDoc, a: ScoreEditArgsOf<'score.unique_region'>): ScoreOutcome {
  const { region } = findRegion(doc, a.region_id);
  if (region.type !== 'notes') {
    throw new CfError(
      'bad_request',
      `Region ${region.id} is an audio region: only notes regions share their notes`,
    );
  }
  const others = regionsOf(doc, region.source).filter((r) => r.region.id !== region.id);
  if (!others.length) {
    throw new CfError(
      'bad_request',
      `Region ${region.id} shares its notes with no other region: its notes are its own already`,
    );
  }
  const notes = doc.sources[region.source]?.notes ?? [];
  const source = nextId(doc, 'src');
  const copies = notes.map((n) => ({ ...n, id: nextId(doc, 'n') }));
  doc.sources[source] = { notes: copies };
  region.source = source;
  return done({
    region_id: region.id,
    note_ids: copies.map((n) => n.id),
    copied_from: notes.map((n) => n.id),
  });
}

function removeRegion(doc: ScoreDoc, a: ScoreEditArgsOf<'score.remove_region'>): ScoreOutcome {
  const { part, index } = findRegion(doc, a.region_id);
  part.regions.splice(index, 1);
  return done({ region_id: a.region_id });
}

// ---------------------------------------------------------------------------- movement and mix

/** The range a target's values may take, or why the target names nothing in this score. */
export function targetRange(doc: ScoreDoc, t: AutomationTarget): { min: number; max: number } {
  if ('part_id' in t) {
    findPart(doc, t.part_id);
    return t.param === 'pan' ? { min: -1, max: 1 } : { min: -60, max: 24 };
  }
  if ('send_id' in t) {
    findSend(doc, t.send_id);
    return { min: -60, max: 24 };
  }
  const { device } = findDevice(doc, t.device_id);
  const at = deviceParamAt(device.name, device.params, t.param);
  if ('error' in at) throw new CfError('bad_request', at.error);
  return at;
}

function setAutomation(doc: ScoreDoc, a: ScoreEditArgsOf<'score.set_automation'>): ScoreOutcome {
  const range = targetRange(doc, a.target);
  const from = beatsArg(doc, a, 'from') ?? 0;
  const until = beatsArg(doc, a, 'until') ?? Number.POSITIVE_INFINITY;
  if (!(until > from)) {
    throw new CfError(
      'bad_request',
      `until (beat ${fmt(until)}) must be after from (beat ${fmt(from)})`,
    );
  }
  const points = a.points.map((p, i) => {
    const at = (() => {
      try {
        return beatsArg(doc, p, 'at', true);
      } catch (error) {
        if (error instanceof CfError)
          throw new CfError(error.code, `points[${i}]: ${error.message}`);
        throw error;
      }
    })();
    if (at < from || at >= until) {
      throw new CfError(
        'bad_request',
        `points[${i}] at beat ${fmt(at)} is outside the range replaced (from beat ${fmt(from)}${Number.isFinite(until) ? ` until ${fmt(until)}` : ''})`,
      );
    }
    if (p.value < range.min || p.value > range.max) {
      throw new CfError(
        'bad_request',
        `points[${i}]: ${a.target.param} takes ${range.min} to ${range.max}; ${p.value} is outside`,
      );
    }
    return { at, value: p.value, curve: p.curve };
  });
  const lane = doc.automation.find((l) => sameTarget(l.target, a.target));
  const kept = (lane?.points ?? []).filter((p) => p.at < from || p.at >= until);
  // Stable: points on one beat keep the order given (a jump).
  const merged = [...kept, ...points].sort((x, y) => x.at - y.at);
  doc.automation = doc.automation.filter((l) => !sameTarget(l.target, a.target));
  if (merged.length) doc.automation.push({ target: a.target, points: merged });
  return done();
}

function addSend(doc: ScoreDoc, a: ScoreEditArgsOf<'score.add_send'>): ScoreOutcome {
  const from = findPart(doc, a.from_part_id);
  findPart(doc, a.to_part_id);
  if (a.from_part_id === a.to_part_id) {
    throw new CfError('bad_request', `A send cannot feed its own part (${a.from_part_id})`);
  }
  const send = {
    id: nextId(doc, 's'),
    to: a.to_part_id,
    level_db: a.level_db,
    before_gain: a.before_gain,
  };
  from.sends.push(send);
  assertNoLoop(doc);
  return done({ send_id: send.id, part_id: from.id });
}

function setSend(doc: ScoreDoc, a: ScoreEditArgsOf<'score.set_send'>): ScoreOutcome {
  const { send } = findSend(doc, a.send_id);
  if (a.level_db !== undefined) send.level_db = a.level_db;
  if (a.before_gain !== undefined) send.before_gain = a.before_gain;
  return done({ send_id: send.id });
}

function removeSend(doc: ScoreDoc, a: ScoreEditArgsOf<'score.remove_send'>): ScoreOutcome {
  const { part, index } = findSend(doc, a.send_id);
  part.sends.splice(index, 1);
  dropAutomation(doc, (t) => !('send_id' in t && t.send_id === a.send_id));
  return done({ send_id: a.send_id });
}

/**
 * Checks a whole document as score.load rebuilds it: routing, device params and their
 * automation, media, ranges and limits. Throws CfError naming what is wrong.
 */
export function checkScore(doc: ScoreDoc, resolve: ScoreMediaResolver): void {
  const ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) throw new CfError('bad_request', `Id ${id} is used twice in the score`);
    ids.add(id);
  };
  for (const p of doc.parts) {
    unique(p.id);
    if (p.output !== 'master') {
      if (p.output === p.id) throw new CfError('bad_request', `Part ${p.id} sounds through itself`);
      checkOutput(doc, p.output);
    }
    for (const s of p.sends) {
      unique(s.id);
      findPart(doc, s.to);
      if (s.to === p.id) throw new CfError('bad_request', `Send ${s.id} feeds its own part`);
    }
    for (const r of p.regions) unique(r.id);
    p.devices.forEach((d, i) => {
      unique(d.id);
      d.params = checkDeviceParams(doc, d.name, d.params, resolve);
      const kind = deviceKind(d.name);
      const before = p.devices.slice(0, i).some((x) => deviceKind(x.name) === 'effect');
      if (kind === 'instrument' && before) {
        throw new CfError('bad_request', `Part ${p.id}: instrument ${d.id} comes after an effect`);
      }
    });
  }
  for (const d of doc.master.devices) {
    unique(d.id);
    if (deviceKind(d.name) === 'instrument') {
      throw new CfError('bad_request', `The master takes effects only; ${d.id} is ${d.name}`);
    }
    d.params = checkDeviceParams(doc, d.name, d.params, resolve);
  }
  assertNoLoop(doc);
  for (const p of doc.parts) {
    for (const r of p.regions) {
      if (r.type === 'audio')
        checkRange(`Region ${r.id}`, mediaFor(doc, resolve, r.media_id), r.from, r.until);
    }
  }
  for (const s of Object.values(doc.sources)) for (const n of s.notes) unique(n.id);
  for (const lane of doc.automation) {
    const range = targetRange(doc, lane.target);
    for (const p of lane.points) {
      if (p.value < range.min || p.value > range.max) {
        throw new CfError(
          'bad_request',
          `Automation on ${lane.target.param}: ${p.value} is outside ${range.min} to ${range.max}`,
        );
      }
    }
  }
  prune(doc);
  checkLimits(doc);
}
