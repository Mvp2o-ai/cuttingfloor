import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  barsOf,
  fromScoreView,
  newScore,
  performScore,
  regionPlace,
  runScoreEdits,
  type ScoreBatchOp,
  type ScoreMediaResolver,
  ScoreStore,
  scoreDiff,
  scoreIdOf,
  tempoAt,
  toScoreView,
  Workspace,
} from '@cuttingfloor/core';
import {
  CfError,
  deviceParamsText,
  type ScoreDoc,
  ScoreLoadDoc,
  ScoreView,
} from '@cuttingfloor/schema';
import { afterAll, describe, expect, it } from 'vitest';

const temps: string[] = [];
const BASE = `sc_${'0'.repeat(32)}`;
const SHOWN = `sc_${'1'.repeat(32)}`;
afterAll(() => Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true }))));

const LOOP = `m_${'a'.repeat(26)}`;
const SILENT = `m_${'b'.repeat(26)}`;
const OTHERS = `m_${'c'.repeat(26)}`;
const media: ScoreMediaResolver = (id) =>
  id === LOOP
    ? { name: 'loop.wav', duration: 4, audio: true }
    : id === SILENT
      ? { name: 'still.png', duration: 5, audio: false }
      : undefined;

const start = (tempo = 120, fps?: { num: number; den: number }) =>
  newScore({
    name: 'Test',
    tempo,
    meter: { beats: 4, unit: 4 },
    sample_rate: 48_000,
    ...(fps ? { fps } : {}),
  });

/** Runs ops as one edit, as score.batch does. */
function edit(doc: ScoreDoc, ...ops: Array<[ScoreBatchOp['tool'], Record<string, unknown>]>) {
  return runScoreEdits(
    doc,
    BASE,
    ops.map(([tool, args]) => ({ tool, args })),
    media,
    { tool: 'test', args: null },
  );
}

/** A score with a synth part p1 and a 4-beat notes region r3 at beat 0. */
function withRegion(tempo = 120) {
  const { doc } = edit(
    start(tempo),
    ['score.add_part', { name: 'Lead' }],
    [
      'score.add_device',
      { part_id: 'p1', name: 'synth', params: { oscillators: [{ wave: 'saw' }] } },
    ],
    ['score.add_region', { part_id: 'p1', at_beats: 0, length_beats: 4 }],
  );
  return doc;
}

const notesOf = (doc: ScoreDoc, regionId: string) => {
  const view = toScoreView('sc_x', doc);
  const region = view.parts?.flatMap((p) => p.regions ?? []).find((r) => r.region_id === regionId);
  if (region?.type !== 'notes') throw new Error(`no notes region ${regionId}`);
  return region.notes ?? [];
};

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CfError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('score ids', () => {
  it('are short, made from a counter in the document, and the same for the same edits', () => {
    const a = withRegion();
    const b = withRegion();
    expect(a.parts[0]?.id).toBe('p1');
    expect(a.parts[0]?.devices[0]?.id).toBe('d2');
    expect(a.parts[0]?.regions[0]?.id).toBe('r4');
    expect(a).toEqual(b);
  });
});

describe('score.add_notes', () => {
  it('places from the region start, stores exactly what is passed and returns ids in order', () => {
    const doc = withRegion();
    const moved = edit(doc, ['score.move_region', { region_id: 'r4', to_beats: 8 }]).doc;
    const { doc: after, outcome } = edit(moved, [
      'score.add_notes',
      {
        region_id: 'r4',
        notes: [
          { pitch: 'F#4', at_beats: 1 / 3, length_beats: 0.123456789, velocity: 99 },
          { pitch: 60.5, at_beats: 0, length_beats: 1, velocity: 1 },
          { pitch: 'Bb2', at_seconds: 0.5, length_seconds: 0.25, velocity: 64 },
        ],
      },
    ]);
    expect(outcome.note_ids).toEqual(['n5', 'n6', 'n7']);
    const stored = Object.values(after.sources)[0]?.notes ?? [];
    expect(stored.map((n) => [n.pitch, n.at, n.length, n.velocity])).toEqual([
      [66, 1 / 3, 0.123456789, 99],
      [60.5, 0, 1, 1],
      [46, 1, 0.5, 64],
    ]);
    const view = notesOf(after, 'r4');
    expect(view[0]?.at.beats).toBeCloseTo(8 + 1 / 3, 9);
    expect(view[0]).toMatchObject({ name: 'F#4', cents: 0, sounds: true });
    // Half way between two names, the nearest is the upper one.
    expect(view[1]).toMatchObject({ name: 'C#4', cents: -50 });
  });

  it('stores a note that starts outside the region, silent there, and says so', () => {
    const { doc, outcome } = edit(withRegion(), [
      'score.add_notes',
      { region_id: 'r4', notes: [{ pitch: 60, at_beats: 5, length_beats: 1, velocity: 80 }] },
    ]);
    expect(notesOf(doc, 'r4')[0]?.sounds).toBe(false);
    expect(outcome.warnings.join()).toMatch(/stored, but silent/);
  });

  it('refuses more than 2,000 notes a call, with the number', () => {
    const notes = Array.from({ length: 2001 }, (_, i) => ({
      pitch: 60,
      at_beats: i / 1000,
      length_beats: 0.1,
      velocity: 64,
    }));
    const error = refused(() =>
      edit(withRegion(), ['score.add_notes', { region_id: 'r4', notes }]),
    );
    expect(error.message).toMatch(/2,000 notes a call/);
  });
});

describe('mirrored regions', () => {
  const mirrored = () => {
    const { doc } = edit(
      withRegion(),
      [
        'score.add_notes',
        { region_id: 'r4', notes: [{ pitch: 60, at_beats: 0, length_beats: 1, velocity: 90 }] },
      ],
      ['score.alias_region', { region_id: 'r4', at_beats: 4 }],
      ['score.alias_region', { region_id: 'r4', at_beats: 8 }],
    );
    return doc;
  };

  it('share one notes source: added, changed or removed in one is in all', () => {
    const doc = mirrored();
    expect(Object.keys(doc.sources)).toHaveLength(1);
    const added = edit(doc, [
      'score.add_notes',
      { region_id: 'r7', notes: [{ pitch: 64, at_beats: 2, length_beats: 1, velocity: 70 }] },
    ]).doc;
    for (const r of ['r4', 'r6', 'r7'])
      expect(notesOf(added, r).map((n) => n.pitch)).toEqual([60, 64]);
    const changed = edit(added, [
      'score.set_notes',
      { notes: [{ note_id: 'n8', pitch: 'G4' }] },
    ]).doc;
    for (const r of ['r4', 'r6', 'r7'])
      expect(notesOf(changed, r).map((n) => n.pitch)).toEqual([60, 67]);
    const removed = edit(changed, ['score.remove_notes', { note_ids: ['n5'] }]).doc;
    for (const r of ['r4', 'r6', 'r7'])
      expect(notesOf(removed, r).map((n) => n.pitch)).toEqual([67]);
    expect(toScoreView('sc_x', removed).parts?.[0]?.regions?.[1]).toMatchObject({
      mirrors: ['r4', 'r7'],
    });
  });

  it('score.unique_region gives a region its own copy, and changing it leaves the others', () => {
    const { doc, outcome } = edit(mirrored(), ['score.unique_region', { region_id: 'r6' }]);
    expect(outcome.copied_from).toEqual(['n5']);
    expect(outcome.note_ids).toEqual(['n9']);
    const changed = edit(doc, [
      'score.set_notes',
      { notes: [{ note_id: 'n9', velocity: 10 }] },
    ]).doc;
    expect(notesOf(changed, 'r6')[0]?.velocity).toBe(10);
    expect(notesOf(changed, 'r4')[0]?.velocity).toBe(90);
    expect(notesOf(changed, 'r7')[0]?.velocity).toBe(90);
    expect(
      refused(() => edit(withRegion(), ['score.unique_region', { region_id: 'r4' }])).message,
    ).toMatch(/shares its notes with no other region/);
  });

  it('score.remove_region leaves its mirrored copies and their notes', () => {
    const doc = edit(mirrored(), ['score.remove_region', { region_id: 'r4' }]).doc;
    expect(notesOf(doc, 'r6').map((n) => n.note_id)).toEqual(['n5']);
    expect(notesOf(doc, 'r7').map((n) => n.note_id)).toEqual(['n5']);
  });
});

describe('split and trim change no note', () => {
  const crossing = () =>
    edit(withRegion(), [
      'score.add_notes',
      {
        region_id: 'r4',
        notes: [
          { pitch: 60, at_beats: 1, length_beats: 2, velocity: 90 },
          { pitch: 62, at_beats: 3, length_beats: 0.5, velocity: 90 },
        ],
      },
    ]).doc;

  it('split: each note stays in the piece it starts in, at its full length', () => {
    const before = crossing();
    const { doc, outcome } = edit(before, ['score.split_region', { region_id: 'r4', at_beats: 2 }]);
    expect(Object.values(doc.sources)).toEqual(Object.values(before.sources));
    expect(outcome.region_id).toBe('r7');
    expect(notesOf(doc, 'r4').map((n) => [n.pitch, n.sounds])).toEqual([
      [60, true],
      [62, false],
    ]);
    expect(notesOf(doc, 'r7').map((n) => [n.pitch, n.sounds, n.at_beats])).toEqual([
      [60, false, -1],
      [62, true, 1],
    ]);
    const played = performScore(doc, { from_beats: 0, until_beats: 8 }).parts[0]?.notes;
    // The note crossing the cut plays once, from the left piece, for all of its 2 beats.
    expect(played?.map((n) => [n.pitch, n.region_id, n.length])).toEqual([
      [60, 'r4', 1],
      [62, 'r7', 0.25],
    ]);
    expect(regionPlace(doc, 'r7').at.beats).toBe(2);
  });

  it('trim: a note that starts outside the new edges is stored but silent, and comes back', () => {
    const before = crossing();
    const trimmed = edit(before, [
      'score.trim_region',
      { region_id: 'r4', edge: 'start', to_beats: 2 },
    ]).doc;
    expect(Object.values(trimmed.sources)).toEqual(Object.values(before.sources));
    expect(notesOf(trimmed, 'r4').map((n) => n.sounds)).toEqual([false, true]);
    expect(performScore(trimmed, { from_beats: 0, until_beats: 8 }).parts[0]?.notes).toHaveLength(
      1,
    );
    const back = edit(trimmed, [
      'score.trim_region',
      { region_id: 'r4', edge: 'start', to_beats: 0 },
    ]).doc;
    expect(notesOf(back, 'r4').map((n) => n.sounds)).toEqual([true, true]);
    const short = edit(before, [
      'score.trim_region',
      { region_id: 'r4', edge: 'end', to_beats: 3 },
    ]).doc;
    expect(notesOf(short, 'r4').map((n) => n.sounds)).toEqual([true, false]);
    expect(
      refused(() =>
        edit(before, ['score.trim_region', { region_id: 'r4', edge: 'end', to_beats: 0 }]),
      ).message,
    ).toMatch(/stay after the start/);
  });

  it('an audio region shows more or less of its source', () => {
    const { doc } = edit(
      start(120),
      ['score.add_part', {}],
      [
        'score.add_region',
        {
          part_id: 'p1',
          at_beats: 4,
          media_id: LOOP,
          source: { from_seconds: 1, until_seconds: 3 },
        },
      ],
    );
    const trimmed = edit(doc, [
      'score.trim_region',
      { region_id: 'r2', edge: 'start', to_beats: 5 },
    ]).doc;
    expect(trimmed.parts[0]?.regions[0]).toMatchObject({ start: 5, from: 1.5, until: 3 });
    const split = edit(doc, ['score.split_region', { region_id: 'r2', at_beats: 6 }]).doc;
    expect(
      split.parts[0]?.regions.map((r) => (r.type === 'audio' ? [r.start, r.from, r.until] : null)),
    ).toEqual([
      [4, 1, 2],
      [6, 2, 3],
    ]);
    expect(
      refused(() =>
        edit(doc, ['score.trim_region', { region_id: 'r2', edge: 'end', to_beats: 12 }]),
      ).message,
    ).toMatch(/past the end of loop.wav, which is 4 s long/);
  });
});

describe('score.set_tempo', () => {
  const piece = () =>
    edit(
      withRegion(120),
      [
        'score.add_notes',
        { region_id: 'r4', notes: [{ pitch: 60, at_beats: 2, length_beats: 1, velocity: 90 }] },
      ],
      ['score.add_part', {}],
      ['score.add_region', { part_id: 'p6', at_beats: 0, media_id: LOOP }],
      ['score.add_region', { part_id: 'p6', at_beats: 8, media_id: LOOP, fit_beats: 4 }],
    ).doc;

  it('notes keep their beats, audio keeps its seconds unless fitted to beats', () => {
    const before = piece();
    const after = edit(before, ['score.set_tempo', { tempo: 60 }]).doc;
    expect(notesOf(after, 'r4')[0]?.at).toEqual({ beats: 2, seconds: 2 });
    expect(notesOf(before, 'r4')[0]?.at).toEqual({ beats: 2, seconds: 1 });
    // The loop is 4 s: 8 beats at 120, 4 beats at 60.
    expect(regionPlace(before, 'r7')).toMatchObject({ length_beats: 8, length_seconds: 4 });
    expect(regionPlace(after, 'r7')).toMatchObject({ length_beats: 4, length_seconds: 4 });
    // Fitted to 4 beats: 2 s at 120, 4 s at 60.
    expect(regionPlace(before, 'r8')).toMatchObject({ length_beats: 4, length_seconds: 2 });
    expect(regionPlace(after, 'r8')).toMatchObject({ length_beats: 4, length_seconds: 4 });
  });

  it('a change at beat 0 sets the opening tempo; a ramp glides from the change before and arrives on its beat', () => {
    const doc = edit(start(120), [
      'score.set_tempo',
      {
        changes: [
          { at_beats: 0, tempo: 90 },
          { at_beats: 8, tempo: 90 },
          { at_beats: 16, tempo: 150, ramp: true },
        ],
      },
    ]).doc;
    expect(doc.tempo).toEqual([
      { at: 0, bpm: 90 },
      { at: 8, bpm: 90 },
      { at: 16, bpm: 150, ramp: true },
    ]);
    expect(tempoAt(doc.tempo, 12)).toBeCloseTo(120, 9);
    expect(tempoAt(doc.tempo, 16)).toBe(150);
    expect(
      refused(() =>
        edit(start(), ['score.set_tempo', { changes: [{ at_beats: 0, tempo: 100, ramp: true }] }]),
      ).message,
    ).toMatch(/beat 0 has none/);
    expect(refused(() => edit(start(), ['score.set_tempo', {}])).message).toMatch(/one of tempo/);
  });

  it('a change given in seconds lands on the beat at that time', () => {
    const doc = edit(start(120), [
      'score.set_tempo',
      { changes: [{ at_seconds: 3, tempo: 60 }] },
    ]).doc;
    expect(doc.tempo[1]).toEqual({ at: 6, bpm: 60 });
  });

  it('returns where each bar starts, up to the end of the score', () => {
    const doc = edit(piece(), ['score.set_tempo', { tempo: 60 }]).doc;
    const { bars, bars_total } = barsOf(doc);
    expect(bars_total).toBe(3);
    expect(bars.map((b) => [b.bar, b.beats, b.seconds])).toEqual([
      [1, 0, 0],
      [2, 4, 4],
      [3, 8, 8],
    ]);
  });
});

describe('score.set_meter', () => {
  it('moves the bar lines from a bar on; notes keep their beats', () => {
    const doc = edit(start(120), [
      'score.set_meter',
      { meter: { beats: 6, unit: 8 }, from_bar: 3 },
    ]).doc;
    expect(doc.meter).toEqual([
      { bar: 1, beats: 4, unit: 4 },
      { bar: 3, beats: 6, unit: 8 },
    ]);
    expect(toScoreView('sc_x', doc).meter[1]?.at.beats).toBe(8);
  });
});

describe('score.set_markers', () => {
  it('replaces the list; a marker in seconds keeps its time, one in beats its beat', () => {
    const fps = { num: 25, den: 1 };
    const first = edit(start(120, fps), [
      'score.set_markers',
      { markers: [{ name: 'old', at_beats: 1 }] },
    ]).doc;
    const doc = edit(first, [
      'score.set_markers',
      {
        markers: [
          { name: 'cut', at_seconds: 3 },
          { name: 'drop', at_beats: 8 },
        ],
      },
    ]).doc;
    expect(doc.markers.map((m) => m.name)).toEqual(['cut', 'drop']);
    const before = toScoreView('sc_x', doc).markers;
    expect(before?.[0]).toMatchObject({
      given: 'seconds',
      at: { beats: 6, seconds: 3, frames: 75 },
    });
    const slower = edit(doc, ['score.set_tempo', { tempo: 60 }]).doc;
    const after = toScoreView('sc_x', slower).markers;
    expect(after?.[0]).toMatchObject({
      given: 'seconds',
      at: { beats: 3, seconds: 3, frames: 75 },
    });
    expect(after?.[1]).toMatchObject({ given: 'beats', at: { beats: 8, seconds: 8, frames: 200 } });
  });
});

describe('score.set_automation', () => {
  it('replaces a param’s points in a range and keeps the rest', () => {
    const doc = edit(
      withRegion(),
      [
        'score.set_automation',
        {
          target: { part_id: 'p1', param: 'gain_db' },
          points: [0, 4, 8].map((b) => ({ at_beats: b, value: -b, curve: 'linear' })),
        },
      ],
      [
        'score.set_automation',
        {
          target: { part_id: 'p1', param: 'gain_db' },
          points: [{ at_beats: 5, value: -20, curve: 'hold' }],
          from_beats: 3,
          until_beats: 6,
        },
      ],
    ).doc;
    expect(doc.automation[0]?.points.map((p) => [p.at, p.value])).toEqual([
      [0, -0],
      [5, -20],
      [8, -8],
    ]);
    const cleared = edit(doc, [
      'score.set_automation',
      { target: { part_id: 'p1', param: 'gain_db' }, points: [] },
    ]).doc;
    expect(cleared.automation).toEqual([]);
  });

  it('names a device param by its path, checked against the device', () => {
    const doc = edit(withRegion(), [
      'score.add_device',
      { part_id: 'p1', name: 'eq', params: { bands: [{ type: 'peak', hz: 1000 }] } },
    ]).doc;
    const ok = edit(doc, [
      'score.set_automation',
      {
        target: { device_id: 'd5', param: 'bands[0].gain_db' },
        points: [{ at_beats: 0, value: 6, curve: 'smooth' }],
      },
    ]).doc;
    expect(ok.automation).toHaveLength(1);
    expect(
      refused(() =>
        edit(doc, [
          'score.set_automation',
          { target: { device_id: 'd5', param: 'bands[1].gain_db' }, points: [] },
        ]),
      ).message,
    ).toMatch(/has 1 bands/);
    expect(
      refused(() =>
        edit(doc, [
          'score.set_automation',
          {
            target: { device_id: 'd5', param: 'bands[0].gain_db' },
            points: [{ at_beats: 0, value: 40, curve: 'linear' }],
          },
        ]),
      ).message,
    ).toMatch(/-24 to 24/);
    expect(
      refused(() =>
        edit(doc, [
          'score.set_automation',
          {
            target: { part_id: 'p1', param: 'pan' },
            points: [{ at_beats: 9, value: 0, curve: 'linear' }],
            until_beats: 8,
          },
        ]),
      ).message,
    ).toMatch(/outside the range replaced/);
    // A param the device no longer has can't keep its automation.
    expect(
      refused(() => edit(ok, ['score.set_device', { device_id: 'd5', params: { bands: [] } }]))
        .message,
    ).toMatch(/bands/);
  });
});

describe('score.add_device', () => {
  it('keeps instruments before effects, and the master takes effects only', () => {
    const doc = edit(
      withRegion(),
      [
        'score.add_device',
        { part_id: 'p1', name: 'reverb', params: { decay_seconds: 2, wet: 0.3 } },
      ],
      ['score.add_device', { part_id: 'p1', name: 'grand_piano' }],
    ).doc;
    expect(doc.parts[0]?.devices.map((d) => d.name)).toEqual(['synth', 'grand_piano', 'reverb']);
    expect(
      refused(() => edit(doc, ['score.add_device', { part_id: 'p1', name: 'organ', at_index: 3 }]))
        .message,
    ).toMatch(/instruments come first/);
    expect(
      refused(() =>
        edit(doc, [
          'score.add_device',
          { part_id: 'p1', name: 'gain', params: { gain_db: 1 }, at_index: 0 },
        ]),
      ).message,
    ).toMatch(/before an instrument/);
    expect(
      refused(() => edit(doc, ['score.add_device', { master: true, name: 'kit_808' }])).message,
    ).toMatch(/master takes effects only/);
    const master = edit(doc, [
      'score.add_device',
      { master: true, name: 'limiter', params: { ceiling_dbtp: -1 } },
    ]).doc;
    expect(master.master.devices[0]?.name).toBe('limiter');
  });

  it('checks params against the registry and lists them inline when wrong', () => {
    const error = refused(() =>
      edit(withRegion(), [
        'score.add_device',
        { part_id: 'p1', name: 'compressor', params: { threshold_db: -20 } },
      ]),
    );
    expect(error.message).toMatch(/ratio/);
    expect(error.hint).toBe(deviceParamsText('compressor'));
    const unknown = refused(() =>
      edit(withRegion(), ['score.add_device', { part_id: 'p1', name: 'theremin' }]),
    );
    expect(unknown.hint).toMatch(/Instruments: sampler, synth/);
  });

  it('score.get shows every param applied, and which pitch plays what on a kit or a sliced sampler', () => {
    const doc = edit(
      withRegion(),
      ['score.add_part', {}],
      ['score.add_device', { part_id: 'p5', name: 'kit_808' }],
      ['score.add_part', {}],
      [
        'score.add_device',
        {
          part_id: 'p7',
          name: 'sampler',
          params: {
            media_id: LOOP,
            slices: [
              { note: 'D2', from_seconds: 1, until_seconds: 2 },
              { note: 36, from_seconds: 0, until_seconds: 1 },
            ],
          },
        },
      ],
    ).doc;
    const view = toScoreView('sc_x', doc);
    const synth = view.parts?.[0]?.devices?.[0];
    expect(synth?.applied).toMatchObject({
      glide_ms: 0,
      gain_db: 0,
      oscillators: [{ wave: 'saw', octave: 0, detune_cents: 0, level: 1 }],
    });
    expect(view.parts?.[1]?.devices?.[0]?.pitches).toContainEqual({
      pitch: 36,
      name: 'C2',
      plays: 'kick (C2)',
    });
    expect(view.parts?.[2]?.devices?.[0]?.pitches?.map((p) => [p.pitch, p.name])).toEqual([
      [36, 'C2'],
      [38, 'D2'],
    ]);
  });
});

describe('media in a score', () => {
  it('must be this owner’s and have sound; the document keeps what it needs and drops the rest', () => {
    const base = edit(start(), ['score.add_part', {}]).doc;
    expect(
      refused(() =>
        edit(base, ['score.add_region', { part_id: 'p1', at_beats: 0, media_id: OTHERS }]),
      ).code,
    ).toBe('not_found');
    expect(
      refused(() =>
        edit(base, ['score.add_region', { part_id: 'p1', at_beats: 0, media_id: SILENT }]),
      ).code,
    ).toBe('no_audio');
    expect(
      refused(() =>
        edit(base, [
          'score.add_device',
          { part_id: 'p1', name: 'sampler', params: { media_id: SILENT, root_note: 60 } },
        ]),
      ).code,
    ).toBe('no_audio');
    const doc = edit(base, [
      'score.add_region',
      { part_id: 'p1', at_beats: 0, media_id: LOOP },
    ]).doc;
    expect(doc.media).toEqual({ [LOOP]: { name: 'loop.wav', duration: 4 } });
    expect(edit(doc, ['score.remove_region', { region_id: 'r2' }]).doc.media).toEqual({});
  });
});

describe('routing', () => {
  it('refuses a loop of parts through outputs or sends, and a send to its own part', () => {
    const doc = edit(
      start(),
      ['score.add_part', {}],
      ['score.add_part', {}],
      ['score.add_part', {}],
      ['score.set_part', { part_id: 'p1', output: 'p2' }],
    ).doc;
    expect(
      refused(() => edit(doc, ['score.set_part', { part_id: 'p2', output: 'p1' }])).message,
    ).toMatch(/loop of parts: p1 to p2 to p1|loop of parts: p2 to p1 to p2/);
    expect(
      refused(() =>
        edit(doc, ['score.add_send', { from_part_id: 'p3', to_part_id: 'p3', level_db: -6 }]),
      ).message,
    ).toMatch(/own part/);
    const sent = edit(doc, [
      'score.add_send',
      { from_part_id: 'p2', to_part_id: 'p3', level_db: -6 },
    ]).doc;
    expect(
      refused(() =>
        edit(sent, ['score.add_send', { from_part_id: 'p3', to_part_id: 'p1', level_db: -6 }]),
      ).message,
    ).toMatch(/loop of parts/);
    expect(refused(() => edit(sent, ['score.remove_part', { part_id: 'p2' }])).message).toMatch(
      /sounding through it: p1/,
    );
  });
});

describe('platform limits', () => {
  it('are refused with their number', () => {
    let doc = start();
    doc = edit(
      doc,
      ...Array.from(
        { length: 64 },
        () => ['score.add_part', {}] as ['score.add_part', Record<string, unknown>],
      ),
    ).doc;
    const error = refused(() => edit(doc, ['score.add_part', {}]));
    expect(error.code).toBe('limit_exceeded');
    expect(error.message).toMatch(/65 parts; a score holds up to 64/);
  });
});

describe('score batch', () => {
  it('takes ids an earlier op made with $ref, and applies all or none', () => {
    const { doc, results } = runScoreEdits(
      start(),
      'sc_0',
      [
        { tool: 'score.add_part', args: { name: 'Drums' } },
        {
          tool: 'score.add_device',
          args: { part_id: { $ref: 'ops[0].part_id' }, name: 'kit_909' },
        },
        {
          tool: 'score.add_region',
          args: {
            part_id: { $ref: 'ops[0].part_id' },
            at_beats: 0,
            length_beats: 4,
            notes: [{ pitch: 'C2', at_beats: 0, length_beats: 0.5, velocity: 120 }],
          },
        },
        {
          tool: 'score.set_notes',
          args: { notes: [{ note_id: { $ref: 'ops[2].note_ids[0]' }, velocity: 100 }] },
        },
        {
          tool: 'score.alias_region',
          args: { region_id: { $ref: 'ops[2].region_id' }, at_beats: 4 },
        },
      ],
      media,
      { tool: 'score.batch', args: null },
    );
    expect(results.map((r) => [r.tool, r.part_id, r.device_id, r.region_id, r.note_ids])).toEqual([
      ['score.add_part', 'p1', undefined, undefined, undefined],
      ['score.add_device', 'p1', 'd2', undefined, undefined],
      ['score.add_region', 'p1', undefined, 'r4', ['n5']],
      ['score.set_notes', undefined, undefined, undefined, undefined],
      ['score.alias_region', 'p1', undefined, 'r6', undefined],
    ]);
    expect(notesOf(doc, 'r6')[0]?.velocity).toBe(100);
    expect(() =>
      runScoreEdits(
        start(),
        'sc_0',
        [
          { tool: 'score.add_part', args: {} },
          { tool: 'score.remove_part', args: { part_id: 'p9' } },
        ],
        media,
        { tool: 'x', args: null },
      ),
    ).toThrow(/ops\[1\] \(score.remove_part\): No part p9/);
    expect(() =>
      runScoreEdits(
        start(),
        'sc_0',
        [{ tool: 'score.add_part', args: { part_id: { $ref: 'ops[1].part_id' } } }],
        media,
        { tool: 'x', args: null },
      ),
    ).toThrow(/has not run yet/);
  });
});

describe('score.load', () => {
  it('restores a score from its score.get document', () => {
    const { doc } = edit(
      withRegion(),
      [
        'score.add_notes',
        {
          region_id: 'r4',
          notes: [
            { pitch: 60, at_beats: 0, length_beats: 1, velocity: 90 },
            { pitch: 61, at_beats: 9, length_beats: 1, velocity: 9 },
          ],
        },
      ],
      ['score.alias_region', { region_id: 'r4', at_beats: 4 }],
      ['score.trim_region', { region_id: 'r7', edge: 'start', to_beats: 5 }],
      ['score.add_part', { output: 'p1' }],
      ['score.add_region', { part_id: 'p8', at_beats: 2, media_id: LOOP, fit_beats: 2 }],
      ['score.add_device', { master: true, name: 'delay', params: { time_beats: 0.75, wet: 0.2 } }],
      ['score.set_device', { device_id: 'd10', enabled: false }],
      ['score.add_send', { from_part_id: 'p8', to_part_id: 'p1', level_db: -12 }],
      [
        'score.set_automation',
        {
          target: { send_id: 's11', param: 'level_db' },
          points: [{ at_beats: 1, value: -3, curve: 'smooth' }],
        },
      ],
      [
        'score.set_markers',
        {
          markers: [
            { name: 'a', at_seconds: 1.5 },
            { name: 'b', at_beats: 3 },
          ],
        },
      ],
      ['score.set_meter', { meter: { beats: 3, unit: 4 }, from_bar: 2 }],
      ['score.set_tempo', { changes: [{ at_beats: 4, tempo: 140, ramp: true }] }],
    );
    const view = toScoreView(SHOWN, doc);
    const json = JSON.parse(JSON.stringify(view));
    const loaded = fromScoreView(ScoreLoadDoc.parse(json), media);
    expect(toScoreView(SHOWN, loaded)).toEqual({ ...view, parent: null });
    expect(ScoreView.parse(view)).toBeTruthy();
    expect(scoreDiff(doc, loaded)).toEqual([]);
  });

  it('refuses a document whose routing or media fail the checks an edit makes', () => {
    const doc = edit(start(), ['score.add_part', {}], ['score.add_part', { output: 'p1' }]).doc;
    const view = JSON.parse(JSON.stringify(toScoreView('sc_x', doc)));
    view.parts[0].output = 'p2';
    expect(() => fromScoreView(ScoreLoadDoc.parse(view), media)).toThrow(/loop of parts/);
  });
});

describe('score.diff', () => {
  it('names the parts, devices, regions, notes and settings that differ', () => {
    const a = withRegion();
    const b = edit(
      a,
      [
        'score.add_notes',
        { region_id: 'r4', notes: [{ pitch: 60, at_beats: 0, length_beats: 1, velocity: 90 }] },
      ],
      ['score.move_region', { region_id: 'r4', to_beats: 2 }],
      ['score.set_part', { part_id: 'p1', gain_db: -3 }],
      ['score.set_tempo', { tempo: 100 }],
    ).doc;
    expect(scoreDiff(a, b)).toEqual([
      { id: 'tempo', type: 'tempo', change: 'modified' },
      { id: 'p1', type: 'part', change: 'modified', part_id: 'p1' },
      expect.objectContaining({
        id: 'r4',
        type: 'region',
        change: 'modified',
        part_id: 'p1',
        at: { beats: 2, seconds: 1.2 },
      }),
      { id: 'n5', type: 'note', change: 'added', part_id: 'p1' },
    ]);
  });
});

describe('ScoreStore', () => {
  it('stores by content hash and expires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-'));
    temps.push(dir);
    const store = new ScoreStore(new Workspace(dir));
    const doc = withRegion();
    const id = await store.put('local', doc);
    expect(id).toBe(await scoreIdOf(doc));
    expect(await store.put('local', doc)).toBe(id);
    expect(await store.get('local', id)).toEqual(doc);
    await expect(store.get('someone-else', id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await store.sweep(-1)).toBe(1);
    await expect(store.get('local', id)).rejects.toMatchObject({
      code: 'expired',
      hint: expect.stringMatching(/score.load/),
    });
    await expect(store.get('local', `sc_${'0'.repeat(32)}`)).rejects.toMatchObject({
      code: 'not_found',
      hint: expect.stringMatching(/exactly as a result returned it/),
    });
  });
});
