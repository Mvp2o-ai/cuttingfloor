import {
  beatsToSeconds,
  newScore,
  PERFORM_TOLERANCE,
  type Performance,
  performScore,
  runScoreEdits,
  type ScoreBatchOp,
  type ScoreMediaResolver,
} from '@cuttingfloor/core';
import type { ScoreDoc } from '@cuttingfloor/schema';
import { describe, expect, it } from 'vitest';

// performScore is the seam the music engine plugs into: every time it gives is seconds from the
// start of the range, every pitch a number, every param applied. These hold it to the score.

const LOOP = `m_${'a'.repeat(26)}`;
const media: ScoreMediaResolver = (id) =>
  id === LOOP ? { name: 'loop.wav', duration: 4, audio: true } : undefined;

const start = (tempo = 120) =>
  newScore({ name: 'T', tempo, meter: { beats: 4, unit: 4 }, sample_rate: 44_100 });

function edit(doc: ScoreDoc, ...ops: Array<[ScoreBatchOp['tool'], Record<string, unknown>]>) {
  return runScoreEdits(
    doc,
    `sc_${'0'.repeat(32)}`,
    ops.map(([tool, args]) => ({ tool, args })),
    media,
    { tool: 'test', args: null },
  ).doc;
}

const note = (pitch: number | string, at: number, length: number, velocity = 100) => ({
  pitch,
  at_beats: at,
  length_beats: length,
  velocity,
});

/** p1 a synth with region r4 at beat 4 (4 beats) holding notes n5…n7; p8 a kit with r11 at 0. */
function band(tempo = 120) {
  return edit(
    start(tempo),
    ['score.add_part', { name: 'Lead' }],
    [
      'score.add_device',
      { part_id: 'p1', name: 'synth', params: { oscillators: [{ wave: 'sine' }] } },
    ],
    [
      'score.add_region',
      {
        part_id: 'p1',
        at_beats: 4,
        length_beats: 4,
        notes: [note('A4', 0, 1), note(60.25, 3.5, 2, 30), note(62, 4, 1)],
      },
    ],
    ['score.add_part', { name: 'Drums' }],
    ['score.add_device', { part_id: 'p8', name: 'kit_808' }],
    [
      'score.add_region',
      { part_id: 'p8', at_beats: 0, length_beats: 4, notes: [note('C2', 0, 0.5)] },
    ],
  );
}

const partOf = (p: Performance, id: string) => {
  const part = p.parts.find((x) => x.part_id === id);
  if (!part) throw new Error(`no part ${id}`);
  return part;
};

describe('performScore', () => {
  it('gives each note in seconds from the range start, at full length, pitch as a number', () => {
    const p = performScore(band(120), { from_beats: 0, until_beats: 16 });
    expect(p.range).toEqual({ from_beats: 0, until_beats: 16, from_seconds: 0, until_seconds: 8 });
    expect(p.sample_rate).toBe(44_100);
    // The note at 3.5 runs 2 beats past the region's end: it started inside, so all of it plays.
    // The note at 4 starts at the region's end: outside, silent.
    expect(partOf(p, 'p1').notes).toEqual([
      { note_id: 'n5', region_id: 'r4', start: 2, length: 0.5, pitch: 69, velocity: 100 },
      { note_id: 'n6', region_id: 'r4', start: 3.75, length: 1, pitch: 60.25, velocity: 30 },
    ]);
    expect(partOf(p, 'p8').notes.map((n) => [n.start, n.pitch])).toEqual([[0, 36]]);
    expect(p.played).toEqual(['p1', 'p8']);
    expect(p.carried).toEqual([]);
  });

  it('times are from the range start; a note sounding into the range starts before it', () => {
    const p = performScore(band(120), { from_beats: 7, until_beats: 9 });
    expect(p.range.from_seconds).toBe(3.5);
    expect(partOf(p, 'p1').notes.map((n) => [n.note_id, n.start, n.length])).toEqual([
      ['n6', 0.25, 1],
    ]);
    const later = performScore(band(120), { from_beats: 8, until_beats: 9 });
    expect(partOf(later, 'p1').notes.map((n) => [n.note_id, n.start])).toEqual([['n6', -0.25]]);
    // The drums are done by then.
    expect(later.played).toEqual(['p1']);
  });

  it('honours mirrored regions and their windows', () => {
    const doc = edit(
      band(120),
      ['score.alias_region', { region_id: 'r4', at_beats: 12 }],
      ['score.trim_region', { region_id: 'r13', edge: 'start', to_beats: 13 }],
    );
    const p = performScore(doc, { from_beats: 12, until_beats: 20 });
    // The copy at 12 lost its first beat: the A4 at its start is silent, the note at 3.5 plays.
    expect(partOf(p, 'p1').notes.map((n) => [n.note_id, n.region_id, n.start])).toEqual([
      ['n6', 'r13', 1.75],
    ]);
  });

  it('follows mute, solo and the parts asked for, and says which sounded', () => {
    const doc = band(120);
    expect(
      performScore(edit(doc, ['score.set_part', { part_id: 'p1', mute: true }]), {
        from_beats: 0,
        until_beats: 16,
      }).played,
    ).toEqual(['p8']);
    expect(
      performScore(edit(doc, ['score.set_part', { part_id: 'p8', solo: true }]), {
        from_beats: 0,
        until_beats: 16,
      }).played,
    ).toEqual(['p8']);
    expect(performScore(doc, { from_beats: 0, until_beats: 16, parts: ['p1'] }).played).toEqual([
      'p1',
    ]);
    expect(() => performScore(doc, { from_beats: 0, until_beats: 16, parts: ['p99'] })).toThrow(
      /No part p99/,
    );
    expect(() => performScore(doc, { from_beats: 4, until_beats: 4 })).toThrow(/must be after/);
  });

  it('carries the parts played ones sound through and send to; a muted one passes nothing', () => {
    const doc = edit(
      band(120),
      ['score.add_part', { name: 'Bus' }],
      ['score.add_part', { name: 'Verb' }],
      [
        'score.add_device',
        { part_id: 'p14', name: 'reverb', params: { decay_seconds: 3, wet: 1 } },
      ],
      ['score.set_part', { part_id: 'p1', output: 'p13' }],
      ['score.add_send', { from_part_id: 'p8', to_part_id: 'p14', level_db: -10 }],
    );
    const p = performScore(doc, { from_beats: 0, until_beats: 16 });
    expect(p.played).toEqual(['p1', 'p8']);
    expect(p.carried).toEqual(['p13', 'p14']);
    expect(partOf(p, 'p13')).toMatchObject({ plays: false, notes: [], audio: [] });
    expect(partOf(p, 'p8').sends).toEqual([
      { send_id: 's16', to_part_id: 'p14', level_db: -10, before_gain: false },
    ]);
    // Mute the bus: the lead it carries no longer reaches the master.
    const muted = performScore(edit(doc, ['score.set_part', { part_id: 'p13', mute: true }]), {
      from_beats: 0,
      until_beats: 16,
    });
    expect(muted.played).toEqual(['p8']);
    // Mute the reverb: the drums still sound, without the send.
    const dry = performScore(edit(doc, ['score.set_part', { part_id: 'p14', mute: true }]), {
      from_beats: 0,
      until_beats: 16,
    });
    expect(partOf(dry, 'p8').sends).toEqual([]);
    expect(dry.carried).toEqual(['p13']);
  });

  it('notes on a part with no enabled instrument are silent', () => {
    const doc = edit(band(120), ['score.set_device', { device_id: 'd2', enabled: false }]);
    const p = performScore(doc, { from_beats: 0, until_beats: 16 });
    expect(p.played).toEqual(['p8']);
  });

  it('gives devices with every param applied, pitches as numbers, a delay in milliseconds', () => {
    const doc = edit(
      start(90),
      ['score.add_part', {}],
      [
        'score.add_device',
        {
          part_id: 'p1',
          name: 'sampler',
          params: { media_id: LOOP, slices: [{ note: 'D2', from_seconds: 0, until_seconds: 1 }] },
        },
      ],
      ['score.add_device', { part_id: 'p1', name: 'delay', params: { time_beats: 0.5, wet: 0.3 } }],
      [
        'score.add_device',
        { part_id: 'p1', name: 'chorus', params: { rate_hz: 1, depth: 0.5, wet: 0.5 } },
      ],
      ['score.set_device', { device_id: 'd4', enabled: false }],
      [
        'score.add_region',
        {
          part_id: 'p1',
          at_beats: 0,
          length_beats: 4,
          notes: [note('D2', 0, 1), note('D2', 2, 1)],
        },
      ],
      ['score.set_tempo', { changes: [{ at_beats: 2, tempo: 120 }] }],
    );
    const at0 = performScore(doc, { from_beats: 0, until_beats: 4 });
    const devices = partOf(at0, 'p1').devices;
    expect(devices.map((d) => d.name)).toEqual(['sampler', 'delay']);
    expect(devices[0]?.params).toEqual({
      media_id: LOOP,
      slices: [{ note: 38, from_seconds: 0, until_seconds: 1 }],
      one_shot: false,
      loop: false,
      attack_ms: 0,
      release_ms: 10,
      gain_db: 0,
    });
    // Half a beat at 90 bpm is 333.3 ms; from beat 2 the tempo is 120: 250 ms.
    expect(devices[1]?.params).toEqual({ time_ms: 1000 / 3, feedback: 0, wet: 0.3 });
    const at2 = performScore(doc, { from_beats: 2, until_beats: 4 });
    expect(partOf(at2, 'p1').devices[1]?.params.time_ms).toBe(250);
    expect(at0.media).toEqual({ [LOOP]: { name: 'loop.wav', duration: 4 } });
  });

  it('plays an audio region at its own speed, or stretched to its beats along the tempo', () => {
    const doc = edit(
      start(120),
      ['score.add_part', {}],
      [
        'score.add_region',
        { part_id: 'p1', at_beats: 2, media_id: LOOP, source: { from_seconds: 1 } },
      ],
      [
        'score.add_region',
        { part_id: 'p1', at_beats: 8, media_id: LOOP, fit_beats: 4, gain_db: -3 },
      ],
    );
    const p = performScore(doc, { from_beats: 0, until_beats: 16 });
    expect(partOf(p, 'p1').audio).toEqual([
      {
        region_id: 'r2',
        media_id: LOOP,
        start: 1,
        length: 3,
        source: { from: 1, until: 4 },
        gain_db: 0,
        stretch: null,
      },
      {
        region_id: 'r3',
        media_id: LOOP,
        start: 4,
        length: 2,
        source: { from: 0, until: 4 },
        gain_db: -3,
        stretch: [
          { at: 4, source: 0 },
          { at: 6, source: 4 },
        ],
      },
    ]);
    // Across a glide the map gains points, each straight piece within the tolerance.
    const glide = edit(doc, [
      'score.set_tempo',
      {
        changes: [
          { at_beats: 8, tempo: 120 },
          { at_beats: 12, tempo: 60, ramp: true },
        ],
      },
    ]);
    const audio = partOf(performScore(glide, { from_beats: 0, until_beats: 16 }), 'p1').audio[1];
    const map = audio?.stretch ?? [];
    expect(map.length).toBeGreaterThan(2);
    expect(map[0]).toEqual({ at: 4, source: 0 });
    expect(map.at(-1)?.source).toBeCloseTo(4, 12);
    for (let b = 8; b <= 12; b += 0.01) {
      const t = beatsToSeconds(glide.tempo, b);
      const truth = b - 8; // 4 s of source over 4 beats
      const i = map.findIndex((m, k) => (map[k + 1]?.at ?? Infinity) >= t && m.at <= t);
      const a = map[i];
      const z = map[i + 1] ?? a;
      if (!a || !z) throw new Error('no piece');
      const line =
        z.at === a.at ? a.source : a.source + ((z.source - a.source) * (t - a.at)) / (z.at - a.at);
      expect(Math.abs(line - truth)).toBeLessThanOrEqual(PERFORM_TOLERANCE.stretchSeconds + 1e-9);
    }
  });

  it('gives automation as points in seconds over the range, within tolerance where the tempo glides', () => {
    const base = edit(band(120), [
      'score.set_automation',
      {
        target: { part_id: 'p1', param: 'gain_db' },
        points: [
          { at_beats: 4, value: 0, curve: 'linear' },
          { at_beats: 8, value: -12, curve: 'hold' },
          { at_beats: 10, value: -6, curve: 'smooth' },
          { at_beats: 12, value: 0, curve: 'hold' },
        ],
      },
    ]);
    const flat = performScore(base, { from_beats: 0, until_beats: 16 }).automation[0];
    expect(flat?.target).toEqual({ part_id: 'p1', param: 'gain_db' });
    const pts = flat?.points ?? [];
    // Before the first point its value holds; the linear move needs no extra points at one tempo.
    expect(pts.slice(0, 4)).toEqual([
      { at: 0, value: 0, curve: 'hold' },
      { at: 2, value: 0, curve: 'linear' },
      { at: 4, value: -12, curve: 'hold' },
      { at: 5, value: -6, curve: 'linear' },
    ]);
    // The smooth move is laid out as straight pieces; the lane ends on the range's end.
    expect(pts.at(-1)).toEqual({ at: 8, value: 0, curve: 'hold' });
    checkLane(
      base,
      pts,
      [10, 12],
      (b) => -6 + 6 * ((1 - Math.cos((Math.PI * (b - 10)) / 2)) / 2),
      6,
    );

    const glide = edit(base, [
      'score.set_tempo',
      { changes: [{ at_beats: 8, tempo: 200, ramp: true }] },
    ]);
    const lane =
      performScore(glide, { from_beats: 0, until_beats: 16 }).automation[0]?.points ?? [];
    expect(lane.length).toBeGreaterThan(pts.length);
    checkLane(glide, lane, [4, 8], (b) => (-12 * (b - 4)) / 4, 12);
    // The range can start inside a move: its first point is the value there.
    const mid = performScore(base, { from_beats: 6, until_beats: 8 }).automation[0]?.points;
    expect(mid).toEqual([
      { at: 0, value: -6, curve: 'linear' },
      { at: 1, value: -12, curve: 'hold' },
    ]);
  });

  it('gives a jump where points share a beat, and drops lanes on what is not in play', () => {
    const doc = edit(
      band(120),
      [
        'score.set_automation',
        {
          target: { part_id: 'p1', param: 'pan' },
          points: [
            { at_beats: 4, value: -1, curve: 'hold' },
            { at_beats: 6, value: 1, curve: 'hold' },
            { at_beats: 6, value: 0.5, curve: 'hold' },
          ],
        },
      ],
      [
        'score.set_automation',
        {
          target: { part_id: 'p8', param: 'pan' },
          points: [{ at_beats: 0, value: 1, curve: 'hold' }],
        },
      ],
    );
    const p = performScore(doc, { from_beats: 4, until_beats: 8, parts: ['p1'] });
    expect(p.automation).toEqual([
      {
        target: { part_id: 'p1', param: 'pan' },
        points: [
          { at: 0, value: -1, curve: 'hold' },
          { at: 1, value: 1, curve: 'hold' },
          { at: 1, value: 0.5, curve: 'hold' },
          { at: 2, value: 0.5, curve: 'hold' },
        ],
      },
    ]);
  });
});

/** Every straight piece of a lane over [b0, b1] stays within tolerance of the true value. */
function checkLane(
  doc: ScoreDoc,
  points: Array<{ at: number; value: number; curve: string }>,
  [b0, b1]: [number, number],
  truth: (beat: number) => number,
  move: number,
) {
  const tol = move * PERFORM_TOLERANCE.valueFraction + 1e-9;
  for (let b = b0; b < b1; b += 0.005) {
    const t = beatsToSeconds(doc.tempo, b);
    const i = points.findLastIndex((p) => p.at <= t);
    const a = points[i];
    const z = points[i + 1];
    if (!a || !z) throw new Error('no piece');
    const line =
      a.curve === 'hold' ? a.value : a.value + ((z.value - a.value) * (t - a.at)) / (z.at - a.at);
    expect(Math.abs(line - truth(b))).toBeLessThanOrEqual(tol);
  }
}
