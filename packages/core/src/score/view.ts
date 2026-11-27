import {
  BARS_LISTED,
  CfError,
  DEVICES,
  type DeviceSpec,
  deviceKind,
  deviceParamsApplied,
  pitchName,
  pitchNumber,
  type RegionPlace,
  type SCORE_INCLUDES,
  type ScoreChange,
  type ScoreDoc,
  type ScoreLoadDoc,
  type ScoreMarkerView,
  type ScoreView,
  type StoredDevice,
  type StoredMarker,
  type StoredRegion,
} from '@cuttingfloor/schema';
import {
  checkScore,
  findRegion,
  regionLength,
  regionsOf,
  type ScoreMediaResolver,
  scoreEnd,
  soundsIn,
} from './edit.ts';
import {
  barsBetween,
  barToBeats,
  beatsToBar,
  beatsToSeconds,
  positionAt,
  positionAtSeconds,
} from './time.ts';

// What tools show of a score (score.get, edit results), the document score.load takes back,
// and what differs between two scores. Every position is in beats, seconds and (with fps) frames.

type Include = (typeof SCORE_INCLUDES)[number];

const tidy = (n: number) => Math.round(n * 1e9) / 1e9;

/** Seconds a stretch of beats lasts from `start`. */
function secondsBetween(doc: ScoreDoc, start: number, end: number): number {
  return tidy(beatsToSeconds(doc.tempo, end) - beatsToSeconds(doc.tempo, start));
}

/** Where a region sits: start, end and length every way. */
export function regionPlace(doc: ScoreDoc, regionId: string): RegionPlace {
  const { part, region } = findRegion(doc, regionId);
  const length = regionLength(doc, region);
  return {
    region_id: region.id,
    part_id: part.id,
    at: positionAt(doc, region.start),
    end: positionAt(doc, region.start + length),
    length_beats: tidy(length),
    length_seconds: secondsBetween(doc, region.start, region.start + length),
  };
}

export function markerView(doc: ScoreDoc, m: StoredMarker): ScoreMarkerView {
  return 'at_beats' in m
    ? { marker_id: m.id, name: m.name, given: 'beats', at: positionAt(doc, m.at_beats) }
    : { marker_id: m.id, name: m.name, given: 'seconds', at: positionAtSeconds(doc, m.at_seconds) };
}

/** Where each bar starts up to the end of the score (at least bar 1), and how many there are. */
export function barsOf(doc: ScoreDoc): {
  bars: ReturnType<typeof barsBetween>;
  bars_total: number;
} {
  const end = Math.max(scoreEnd(doc), 1e-9);
  const last = beatsToBar(doc.meter, end);
  return {
    bars: barsBetween(doc, 0, end, BARS_LISTED),
    bars_total: Math.max(1, last.into > 1e-9 ? last.bar : last.bar - 1),
  };
}

/** Which pitch plays what on a drum kit or a sliced sampler. */
function pitchesOf(
  d: StoredDevice,
): Array<{ pitch: number; name: string; plays: string }> | undefined {
  const spec = (DEVICES as Record<string, DeviceSpec>)[d.name];
  if (spec?.sounds) {
    return Object.entries(spec.sounds).map(([p, plays]) => ({
      pitch: Number(p),
      name: pitchName(Number(p)).name,
      plays,
    }));
  }
  const slices = d.params.slices as
    | Array<{ note: string | number; from_seconds: number; until_seconds: number }>
    | undefined;
  if (d.name === 'sampler' && slices) {
    return slices
      .map((s) => {
        const pitch = pitchNumber(s.note);
        return {
          pitch,
          name: pitchName(pitch).name,
          plays: `${String(d.params.media_id)} from ${s.from_seconds} s until ${s.until_seconds} s`,
        };
      })
      .sort((a, b) => a.pitch - b.pitch);
  }
  return undefined;
}

function deviceView(d: StoredDevice): NonNullable<ScoreView['master']>['devices'][number] {
  const pitches = pitchesOf(d);
  return {
    device_id: d.id,
    name: d.name,
    kind: deviceKind(d.name) ?? 'effect',
    enabled: d.enabled !== false,
    params: d.params,
    applied: deviceParamsApplied(d.name, d.params),
    ...(pitches ? { pitches } : {}),
  };
}

/** Which regions share each notes source, by source id. */
function mirrorsOf(doc: ScoreDoc, r: StoredRegion): string[] {
  if (r.type !== 'notes') return [];
  return regionsOf(doc, r.source)
    .map((x) => x.region.id)
    .filter((id) => id !== r.id);
}

function regionView(doc: ScoreDoc, r: StoredRegion, notes: boolean) {
  const length = regionLength(doc, r);
  const common = {
    region_id: r.id,
    at: positionAt(doc, r.start),
    end: positionAt(doc, r.start + length),
    length_beats: tidy(length),
    length_seconds: secondsBetween(doc, r.start, r.start + length),
  };
  if (r.type === 'audio') {
    return {
      ...common,
      type: 'audio' as const,
      media_id: r.media_id,
      source: { from_seconds: r.from, until_seconds: r.until },
      ...(r.fit_beats !== undefined ? { fit_beats: r.fit_beats } : {}),
      gain_db: r.gain_db,
    };
  }
  return {
    ...common,
    type: 'notes' as const,
    offset_beats: r.offset,
    mirrors: mirrorsOf(doc, r),
    ...(notes
      ? {
          notes: (doc.sources[r.source]?.notes ?? []).map((n) => {
            const at = r.start + n.at - r.offset;
            const { name, cents } = pitchName(n.pitch);
            return {
              note_id: n.id,
              pitch: n.pitch,
              name,
              cents,
              at_beats: tidy(n.at - r.offset),
              length_beats: n.length,
              length_seconds: secondsBetween(doc, at, at + n.length),
              velocity: n.velocity,
              sounds: soundsIn(r, n.at),
              at: positionAt(doc, at),
            };
          }),
        }
      : {}),
  };
}

/** The score as score.get shows it; `include` narrows it (default everything). */
export function toScoreView(
  id: string,
  doc: ScoreDoc,
  include: readonly Include[] = ['parts', 'devices', 'regions', 'notes', 'automation', 'markers'],
): ScoreView {
  const has = new Set(include);
  const partsShown =
    has.has('parts') || has.has('devices') || has.has('regions') || has.has('notes');
  return {
    score_id: id,
    parent: doc.parent,
    format: 'cuttingfloor.score',
    version: 1,
    name: doc.name,
    sample_rate: doc.sample_rate,
    ...(doc.fps ? { fps: doc.fps } : {}),
    length: positionAt(doc, scoreEnd(doc)),
    tempo: doc.tempo.map((t) => ({
      at: positionAt(doc, t.at),
      tempo: t.bpm,
      ramp: Boolean(t.ramp),
    })),
    meter: doc.meter.map((m) => ({
      bar: m.bar,
      beats: m.beats,
      unit: m.unit,
      at: positionAt(doc, barToBeats(doc.meter, m.bar)),
    })),
    ...(has.has('markers') ? { markers: doc.markers.map((m) => markerView(doc, m)) } : {}),
    ...(partsShown
      ? {
          parts: doc.parts.map((p) => ({
            part_id: p.id,
            name: p.name,
            gain_db: p.gain_db,
            pan: p.pan,
            mute: p.mute,
            solo: p.solo,
            output: p.output,
            sends: p.sends.map((s) => ({
              send_id: s.id,
              to_part_id: s.to,
              level_db: s.level_db,
              before_gain: s.before_gain,
            })),
            ...(has.has('devices') ? { devices: p.devices.map(deviceView) } : {}),
            ...(has.has('regions') || has.has('notes')
              ? { regions: p.regions.map((r) => regionView(doc, r, has.has('notes'))) }
              : {}),
          })),
        }
      : {}),
    ...(has.has('devices') ? { master: { devices: doc.master.devices.map(deviceView) } } : {}),
    ...(has.has('automation')
      ? {
          automation: doc.automation.map((l) => ({
            target: l.target,
            points: l.points.map((p) => ({
              at: positionAt(doc, p.at),
              value: p.value,
              curve: p.curve,
            })),
          })),
        }
      : {}),
    media: Object.fromEntries(
      Object.entries(doc.media).map(([mid, m]) => [
        mid,
        { name: m.name, duration_seconds: m.duration },
      ]),
    ),
  };
}

const idNumber = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);

/**
 * A score document from the score.get document: ids kept, mirrored regions sharing one notes
 * source again, every check an edit makes run on the whole.
 */
export function fromScoreView(view: ScoreLoadDoc, resolve: ScoreMediaResolver): ScoreDoc {
  const doc: ScoreDoc = {
    version: 1,
    name: view.name,
    sample_rate: view.sample_rate,
    ...(view.fps ? { fps: view.fps } : {}),
    tempo: view.tempo
      .map((t) => ({ at: t.at.beats, bpm: t.tempo, ...(t.ramp ? { ramp: true } : {}) }))
      .sort((a, b) => a.at - b.at),
    meter: view.meter
      .map((m) => ({ bar: m.bar, beats: m.beats, unit: m.unit }))
      .sort((a, b) => a.bar - b.bar),
    markers: (view.markers ?? []).map((m) =>
      m.given === 'beats'
        ? { id: m.marker_id, name: m.name, at_beats: m.at.beats }
        : { id: m.marker_id, name: m.name, at_seconds: m.at.seconds },
    ),
    parts: [],
    master: {
      devices: (view.master?.devices ?? []).map((d) => ({
        id: d.device_id,
        name: d.name,
        params: d.params,
        ...(d.enabled === false ? { enabled: false } : {}),
      })),
    },
    sources: {},
    automation: (view.automation ?? []).map((l) => ({
      target: l.target,
      points: l.points.map((p) => ({ at: p.at.beats, value: p.value, curve: p.curve })),
    })),
    media: {},
    next_id: 1,
    parent: null,
  };
  if (doc.tempo[0]?.at !== 0) throw new CfError('bad_request', 'The first tempo is at beat 0');
  if (doc.meter[0]?.bar !== 1) throw new CfError('bad_request', 'The first meter is at bar 1');
  // Mirrored regions name each other; each group shares the source of its first region.
  const sourceOf = new Map<string, string>();
  let ids = 0;
  for (const p of view.parts ?? []) {
    const regions: StoredRegion[] = [];
    for (const r of p.regions ?? []) {
      if (r.type === 'audio') {
        regions.push({
          id: r.region_id,
          type: 'audio',
          start: r.at.beats,
          media_id: r.media_id,
          from: r.source.from_seconds,
          until: r.source.until_seconds,
          ...(r.fit_beats !== undefined ? { fit_beats: r.fit_beats } : {}),
          gain_db: r.gain_db,
        });
        continue;
      }
      let source = sourceOf.get(r.region_id);
      if (!source) {
        source = `src${++ids}`;
        doc.sources[source] = {
          notes: (r.notes ?? []).map((n) => ({
            id: n.note_id,
            pitch: n.pitch,
            at: r.offset_beats + n.at_beats,
            length: n.length_beats,
            velocity: n.velocity,
          })),
        };
        for (const m of r.mirrors) sourceOf.set(m, source);
      }
      sourceOf.set(r.region_id, source);
      regions.push({
        id: r.region_id,
        type: 'notes',
        start: r.at.beats,
        length: r.length_beats,
        source,
        offset: r.offset_beats,
      });
    }
    doc.parts.push({
      id: p.part_id,
      name: p.name,
      gain_db: p.gain_db,
      pan: p.pan,
      mute: p.mute,
      solo: p.solo,
      output: p.output,
      devices: (p.devices ?? []).map((d) => ({
        id: d.device_id,
        name: d.name,
        params: d.params,
        ...(d.enabled === false ? { enabled: false } : {}),
      })),
      sends: p.sends.map((s) => ({
        id: s.send_id,
        to: s.to_part_id,
        level_db: s.level_db,
        before_gain: s.before_gain,
      })),
      regions,
    });
  }
  // Source ids are the document's own; renumber them past every id the view gave.
  const all = [
    ...doc.parts.flatMap((p) => [
      p.id,
      ...p.devices.map((d) => d.id),
      ...p.sends.map((s) => s.id),
      ...p.regions.map((r) => r.id),
    ]),
    ...doc.master.devices.map((d) => d.id),
    ...doc.markers.map((m) => m.id),
    ...Object.values(doc.sources).flatMap((s) => s.notes.map((n) => n.id)),
  ];
  doc.next_id = Math.max(0, ...all.map(idNumber)) + 1;
  const renamed: Record<string, string> = {};
  for (const id of Object.keys(doc.sources)) renamed[id] = `src${doc.next_id++}`;
  doc.sources = Object.fromEntries(
    Object.entries(doc.sources).map(([id, s]) => [renamed[id] as string, s]),
  );
  for (const p of doc.parts) {
    for (const r of p.regions) if (r.type === 'notes') r.source = renamed[r.source] as string;
  }
  checkScore(doc, resolve);
  return doc;
}

const json = (v: unknown) => JSON.stringify(v);

/** What differs between two scores: parts, devices, sends, regions, notes and settings. */
export function scoreDiff(a: ScoreDoc, b: ScoreDoc): ScoreChange[] {
  const out: ScoreChange[] = [];
  if (a.name !== b.name || a.sample_rate !== b.sample_rate || json(a.fps) !== json(b.fps)) {
    out.push({ id: 'name', type: 'name', change: 'modified' });
  }
  if (json(a.tempo) !== json(b.tempo)) out.push({ id: 'tempo', type: 'tempo', change: 'modified' });
  if (json(a.meter) !== json(b.meter)) out.push({ id: 'meter', type: 'meter', change: 'modified' });
  if (json(a.markers) !== json(b.markers)) {
    out.push({ id: 'markers', type: 'markers', change: 'modified' });
  }
  const byId = <T extends { id: string }>(
    type: ScoreChange['type'],
    before: Map<string, { item: T; part: string }>,
    after: Map<string, { item: T; part: string }>,
    key: (x: T, part: string) => string,
    extra: (x: T) => Partial<ScoreChange> = () => ({}),
  ) => {
    for (const [id, { item, part }] of after) {
      const was = before.get(id);
      if (!was) out.push({ id, type, change: 'added', part_id: part, ...extra(item) });
      else if (key(was.item, was.part) !== key(item, part)) {
        out.push({ id, type, change: 'modified', part_id: part, ...extra(item) });
      }
    }
    for (const [id, { part }] of before) {
      if (!after.has(id)) out.push({ id, type, change: 'removed', part_id: part });
    }
  };
  const parts = (d: ScoreDoc) => new Map(d.parts.map((p) => [p.id, { item: p, part: p.id }]));
  byId('part', parts(a), parts(b), (p) =>
    json([p.name, p.gain_db, p.pan, p.mute, p.solo, p.output]),
  );
  const devices = (d: ScoreDoc) =>
    new Map([
      ...d.parts.flatMap((p) =>
        p.devices.map((x, i) => [x.id, { item: { ...x, i }, part: p.id }] as const),
      ),
      ...d.master.devices.map((x, i) => [x.id, { item: { ...x, i }, part: 'master' }] as const),
    ]);
  byId('device', devices(a), devices(b), (x, part) => json([x, part]));
  const sends = (d: ScoreDoc) =>
    new Map(d.parts.flatMap((p) => p.sends.map((s) => [s.id, { item: s, part: p.id }] as const)));
  byId('send', sends(a), sends(b), (x) => json(x));
  // A notes region is known by the regions it mirrors, not by its source's id (the document's own).
  const regions = (d: ScoreDoc) =>
    new Map(
      d.parts.flatMap((p) =>
        p.regions.map(
          (r) =>
            [
              r.id,
              {
                item: r,
                part: p.id,
                key: json([
                  r.type === 'notes' ? { ...r, source: mirrorsOf(d, r).sort() } : r,
                  p.id,
                ]),
              },
            ] as const,
        ),
      ),
    );
  const keyed = new Map<StoredRegion, string>();
  for (const [, x] of [...regions(a), ...regions(b)]) keyed.set(x.item, x.key);
  byId(
    'region',
    regions(a),
    regions(b),
    (r) => keyed.get(r) ?? json(r),
    (r) => ({ at: positionAt(b, r.start), end: positionAt(b, r.start + regionLength(b, r)) }),
  );
  const notes = (d: ScoreDoc) =>
    new Map(
      Object.entries(d.sources).flatMap(([source, s]) => {
        const part = regionsOf(d, source)[0]?.part.id ?? '';
        return s.notes.map((n) => [n.id, { item: n, part }] as const);
      }),
    );
  byId('note', notes(a), notes(b), (n) => json(n));
  const lanes = (d: ScoreDoc) =>
    new Map(
      d.automation.map((l) => {
        const t = l.target;
        const id = `${'part_id' in t ? t.part_id : 'send_id' in t ? t.send_id : t.device_id}.${t.param}`;
        return [id, { item: { id, ...l }, part: 'part_id' in t ? t.part_id : '' }] as const;
      }),
    );
  byId('automation', lanes(a), lanes(b), (l) => json(l.points));
  // part_id is only meaningful where known.
  return out.map((c) => (c.part_id ? c : (({ part_id: _p, ...rest }) => rest)(c)));
}
