import {
  deviceParamsText,
  ScoreBatchResult,
  ScoreDiffResult,
  ScoreEditResults,
  type ScoreEditTool,
  ScoreHistoryResult,
  ScoreIdResult,
  ScoreView,
} from '@cuttingfloor/schema';
import type { Runtime } from '@cuttingfloor/server';
import type { Client } from '@modelcontextprotocol/client';
import { beforeAll, describe, expect, it } from 'vitest';
import type * as z from 'zod/v4';
import { call, connect, ok, type TestEnv, testRuntime } from './helpers.ts';

// The score.* tools over the protocol, as a client meets them: every tool, its refusals, batch
// $refs and one small piece built end to end. Every result is held to its declared schema.

let env: TestEnv;
beforeAll(async () => {
  env = await testRuntime();
});

/** A media record with sound (or without), as an import leaves one. */
async function seed(runtime: Runtime, owner: string, name: string, sound: boolean, seconds = 4) {
  const record = await runtime.media.create(owner, { upload: `u_${'a'.repeat(26)}` }, name);
  record.status = 'ready';
  record.probe = {
    format: sound ? 'wav' : 'png_pipe',
    kind: sound ? 'audio' : 'image',
    duration: sound ? seconds : null,
    video: sound
      ? null
      : {
          codec: 'png',
          width: 16,
          height: 16,
          fps: { num: 25, den: 1 },
          vfr: false,
          rotation: 0,
          transfer: null,
          primaries: null,
          pix_fmt: null,
          frames: 1,
        },
    audio: sound ? { codec: 'pcm_s24le', sample_rate: 48_000, channels: 2 } : null,
  };
  await runtime.media.save(owner, record);
  return record.media_id;
}

/** Calls a score edit, checks it succeeded and matches its declared schema, and returns it. */
async function edit<T extends ScoreEditTool>(
  client: Client,
  tool: T,
  args: Record<string, unknown>,
): Promise<z.infer<(typeof ScoreEditResults)[T]>> {
  const result = await ok(client, tool, args);
  return ScoreEditResults[tool].parse(result) as z.infer<(typeof ScoreEditResults)[T]>;
}

const create = async (client: Client, extra: Record<string, unknown> = {}) =>
  ScoreIdResult.parse(
    await ok(client, 'score.create', {
      tempo: 120,
      meter: { beats: 4, unit: 4 },
      sample_rate: 48_000,
      ...extra,
    }),
  ).score_id;

const refusal = async (client: Client, tool: string, args: Record<string, unknown>) => {
  const res = await call(client, tool, args);
  expect(res.isError, `${tool} should be refused`).toBe(true);
  const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return { ...(res.structured as { code: string; message: string; hint?: string }), text };
};

describe('score tools', () => {
  it('build a small piece end to end', async () => {
    const owner = 'composer';
    const loop = await seed(env.runtime, owner, 'loop.wav', true);
    const client = await connect(env.runtime, owner);
    const first = await create(client, { fps: { num: 25, den: 1 }, name: 'Theme' });

    // Two parts, a drum kit and a synth, a region of notes and three mirrored copies, in one batch.
    const built = ScoreBatchResult.parse(
      await ok(client, 'score.batch', {
        score_id: first,
        ops: [
          { tool: 'score.add_part', args: { name: 'Drums' } },
          {
            tool: 'score.add_device',
            args: { part_id: { $ref: 'ops[0].part_id' }, name: 'kit_808' },
          },
          {
            tool: 'score.add_region',
            args: {
              part_id: { $ref: 'ops[0].part_id' },
              at_beats: 0,
              length_beats: 4,
              notes: [
                { pitch: 'C2', at_beats: 0, length_beats: 0.5, velocity: 120 },
                { pitch: 'D2', at_beats: 1, length_beats: 0.5, velocity: 100 },
                { pitch: 'F#2', at_beats: 0.5, length_beats: 0.25, velocity: 70 },
              ],
            },
          },
          {
            tool: 'score.alias_region',
            args: { region_id: { $ref: 'ops[2].region_id' }, at_beats: 4 },
          },
          {
            tool: 'score.alias_region',
            args: { region_id: { $ref: 'ops[2].region_id' }, at_beats: 8 },
          },
          {
            tool: 'score.alias_region',
            args: { region_id: { $ref: 'ops[2].region_id' }, at_beats: 12 },
          },
          { tool: 'score.add_part', args: { name: 'Lead', pan: -0.25 } },
          {
            tool: 'score.add_device',
            args: {
              part_id: { $ref: 'ops[6].part_id' },
              name: 'synth',
              params: {
                oscillators: [{ wave: 'saw' }, { wave: 'square', octave: -1, level: 0.5 }],
                filter: { type: 'lowpass', cutoff_hz: 1200 },
              },
            },
          },
          {
            tool: 'score.add_region',
            args: { part_id: { $ref: 'ops[6].part_id' }, at_beats: 0, length_beats: 16 },
          },
          {
            tool: 'score.add_notes',
            args: {
              region_id: { $ref: 'ops[8].region_id' },
              notes: [
                { pitch: 'A4', at_beats: 0, length_beats: 2, velocity: 90 },
                { pitch: 72.5, at_seconds: 1, length_seconds: 0.5, velocity: 80 },
              ],
            },
          },
        ],
      }),
    );
    const [drums, , pattern, , , last, lead, synth, melody, notes] = built.results;
    expect(built.results).toHaveLength(10);
    expect(drums?.part_id).toBe('p1');
    expect(pattern?.note_ids).toHaveLength(3);
    expect(notes?.note_ids).toHaveLength(2);
    expect(built.changed.filter((c) => c.type === 'region' && c.change === 'added')).toHaveLength(
      5,
    );

    // One copy made unique and changed: the others keep the pattern.
    const freed = await edit(client, 'score.unique_region', {
      score_id: built.score_id,
      region_id: last?.region_id,
    });
    expect(freed.copied_from).toEqual(pattern?.note_ids);
    const changed = await edit(client, 'score.set_notes', {
      score_id: freed.score_id,
      notes: [{ note_id: freed.note_ids[1], pitch: 'D#2', velocity: 127 }],
    });

    // A marker in seconds comes back as a beat; after a tempo change it keeps its time.
    const marked = await edit(client, 'score.set_markers', {
      score_id: changed.score_id,
      markers: [
        { name: 'cut', at_seconds: 5 },
        { name: 'drop', at_beats: 12 },
      ],
    });
    expect(marked.markers[0]).toMatchObject({
      name: 'cut',
      given: 'seconds',
      at: { beats: 10, seconds: 5, frames: 125 },
    });
    const slower = await edit(client, 'score.set_tempo', {
      score_id: marked.score_id,
      changes: [{ at_beats: 8, tempo: 90 }],
    });
    expect(slower.length).toEqual({ beats: 16, seconds: 9.333333333, frames: 233.333333 });
    expect(slower.bars.map((b) => [b.bar, b.seconds])).toEqual([
      [1, 0],
      [2, 2],
      [3, 4],
      [4, 6.666666667],
    ]);

    // Movement and mix: the lead's filter opens; it sends to a shared reverb.
    const moving = await edit(client, 'score.set_automation', {
      score_id: slower.score_id,
      target: { device_id: synth?.device_id, param: 'filter.cutoff_hz' },
      points: [
        { at_beats: 0, value: 400, curve: 'smooth' },
        { at_beats: 8, value: 4000, curve: 'hold' },
      ],
    });
    const room = await edit(client, 'score.add_part', { score_id: moving.score_id, name: 'Room' });
    const verb = await edit(client, 'score.add_device', {
      score_id: room.score_id,
      part_id: room.part_id,
      name: 'reverb',
      params: { decay_seconds: 2.5, wet: 1, dry: 0 },
    });
    const send = await edit(client, 'score.add_send', {
      score_id: verb.score_id,
      from_part_id: lead?.part_id,
      to_part_id: room.part_id,
      level_db: -8,
    });
    // A loop under it all, fitted to four bars.
    const bed = await edit(client, 'score.add_region', {
      score_id: send.score_id,
      part_id: room.part_id,
      at_beats: 0,
      media_id: loop,
      fit_beats: 16,
      gain_db: -6,
    });
    expect(bed.region).toMatchObject({ at: { beats: 0, seconds: 0, frames: 0 }, length_beats: 16 });

    const view = ScoreView.parse(await ok(client, 'score.get', { score_id: bed.score_id }));
    // 4 s to the change at beat 8, then 1 s at 90: beat 9.5.
    expect(view.markers?.[0]).toMatchObject({ name: 'cut', at: { beats: 9.5, seconds: 5 } });
    expect(view.markers?.[1]).toMatchObject({
      name: 'drop',
      at: { beats: 12, seconds: 6.666666667 },
    });
    const drumRegions = view.parts?.find((p) => p.part_id === drums?.part_id)?.regions ?? [];
    expect(drumRegions.map((r) => (r.type === 'notes' ? r.mirrors.length : null))).toEqual([
      2, 2, 2, 0,
    ]);
    const pitches = (i: number) => {
      const r = drumRegions[i];
      return r?.type === 'notes' ? r.notes?.map((n) => n.name) : undefined;
    };
    expect(pitches(0)).toEqual(['C2', 'D2', 'F#2']);
    expect(pitches(3)).toEqual(['C2', 'D#2', 'F#2']);
    const kit = view.parts?.[0]?.devices?.[0];
    expect(kit?.pitches?.find((p) => p.pitch === 38)?.plays).toBe('snare (D2)');
    expect(view.parts?.[1]?.devices?.[0]?.applied).toMatchObject({
      filter: { type: 'lowpass', cutoff_hz: 1200, resonance: Math.SQRT1_2 },
      glide_ms: 0,
    });
    const lead2 = view.parts?.find((p) => p.part_id === lead?.part_id);
    const tune = lead2?.regions?.find((r) => r.region_id === melody?.region_id);
    expect(tune?.type === 'notes' && tune.notes?.[1]).toMatchObject({
      pitch: 72.5,
      at_beats: 2,
      length_beats: 1,
    });
    expect(view.automation).toHaveLength(1);
    expect(view.media[loop]).toEqual({ name: 'loop.wav', duration_seconds: 4 });

    // Narrowed: only what was asked for.
    const parts = ScoreView.parse(
      await ok(client, 'score.get', { score_id: bed.score_id, include: ['parts'] }),
    );
    expect(parts.parts?.[0]?.devices).toBeUndefined();
    expect(parts.markers).toBeUndefined();

    const history = ScoreHistoryResult.parse(
      await ok(client, 'score.history', { score_id: bed.score_id, limit: 50 }),
    );
    expect(history.entries.map((e) => e.tool)).toEqual([
      'score.add_region',
      'score.add_send',
      'score.add_device',
      'score.add_part',
      'score.set_automation',
      'score.set_tempo',
      'score.set_markers',
      'score.set_notes',
      'score.unique_region',
      'score.batch',
      'score.create',
    ]);
    expect(history.truncated).toBe(false);

    const diff = ScoreDiffResult.parse(
      await ok(client, 'score.diff', { from: first, to: bed.score_id }),
    );
    expect(diff.changed.map((c) => c.type)).toEqual(
      expect.arrayContaining([
        'tempo',
        'markers',
        'part',
        'device',
        'send',
        'region',
        'note',
        'automation',
      ]),
    );

    // The get document restores the same score.
    const loaded = ScoreIdResult.parse(await ok(client, 'score.load', { score: view }));
    const again = ScoreView.parse(await ok(client, 'score.get', { score_id: loaded.score_id }));
    expect({ ...again, score_id: null, parent: null }).toEqual({
      ...view,
      score_id: null,
      parent: null,
    });
    const same = ScoreDiffResult.parse(
      await ok(client, 'score.diff', { from: bed.score_id, to: loaded.score_id }),
    );
    expect(same.changed).toEqual([]);
  });

  it('cover every edit tool', async () => {
    const owner = 'every';
    const loop = await seed(env.runtime, owner, 'beat.wav', true, 8);
    const client = await connect(env.runtime, owner);
    let id = await create(client);
    const step = async <T extends ScoreEditTool>(tool: T, args: Record<string, unknown>) => {
      const r = await edit(client, tool, { score_id: id, ...args });
      expect(r.parent).toBe(id);
      id = r.score_id;
      return r;
    };
    expect(
      (await step('score.set_meter', { meter: { beats: 3, unit: 4 }, from_bar: 2 })).bars_total,
    ).toBe(1);
    const a = await step('score.add_part', { name: 'A' });
    const b = await step('score.add_part', { name: 'B' });
    const c = await step('score.add_part', { name: 'C', output: a.part_id });
    await step('score.set_part', {
      part_id: b.part_id,
      gain_db: -3,
      mute: true,
      solo: false,
      name: 'B2',
    });
    await step('score.set_part', { part_id: c.part_id, output: 'master' });
    const piano = await step('score.add_device', { part_id: a.part_id, name: 'grand_piano' });
    await step('score.set_device', {
      device_id: piano.device_id,
      params: { release_ms: 400 },
      enabled: false,
    });
    const gain = await step('score.add_device', {
      master: true,
      name: 'gain',
      params: { gain_db: -1 },
    });
    await step('score.remove_device', { device_id: gain.device_id });
    const region = await step('score.add_region', {
      part_id: a.part_id,
      at_seconds: 1,
      length_seconds: 2,
    });
    expect(region.region).toMatchObject({ at: { beats: 2, seconds: 1 }, length_beats: 4 });
    const added = await step('score.add_notes', {
      region_id: region.region_id,
      notes: [
        { pitch: 60, at_beats: 0, length_beats: 1, velocity: 64 },
        { pitch: 64, at_beats: 3, length_beats: 1, velocity: 64 },
      ],
    });
    await step('score.remove_notes', { note_ids: [added.note_ids[0]] });
    expect(
      (
        await step('score.move_region', {
          region_id: region.region_id,
          to_beats: 4,
          part_id: b.part_id,
        })
      ).region,
    ).toMatchObject({ part_id: b.part_id, at: { beats: 4 } });
    expect(
      (await step('score.trim_region', { region_id: region.region_id, edge: 'end', to_beats: 6 }))
        .region.length_beats,
    ).toBe(2);
    const split = await step('score.split_region', { region_id: region.region_id, at_beats: 5 });
    expect([split.left.end.beats, split.right.at.beats]).toEqual([5, 5]);
    await step('score.remove_region', { region_id: split.region_id });
    const audio = await step('score.add_region', {
      part_id: a.part_id,
      at_beats: 0,
      media_id: loop,
      source: { from_seconds: 2, until_seconds: 6 },
    });
    expect(audio.region.length_seconds).toBe(4);
    const copy = await step('score.alias_region', {
      region_id: audio.region_id,
      at_beats: 16,
      part_id: b.part_id,
    });
    expect(copy.region.at.beats).toBe(16);
    const send = await step('score.add_send', {
      from_part_id: a.part_id,
      to_part_id: b.part_id,
      level_db: -6,
      before_gain: true,
    });
    await step('score.set_send', { send_id: send.send_id, level_db: -3 });
    await step('score.set_automation', {
      target: { send_id: send.send_id, param: 'level_db' },
      points: [{ at_beats: 0, value: -20, curve: 'linear' }],
    });
    await step('score.remove_send', { send_id: send.send_id });
    await step('score.set_tempo', { tempo: 96.5 });
    await step('score.set_markers', { markers: [] });
    await step('score.remove_part', { part_id: b.part_id });
    const view = ScoreView.parse(await ok(client, 'score.get', { score_id: id }));
    expect(view.parts?.map((p) => p.part_id)).toEqual([a.part_id, c.part_id]);
    expect(view.automation).toEqual([]);
  });

  it('refuse what they cannot do, saying why', async () => {
    const owner = 'refused';
    const silent = await seed(env.runtime, owner, 'logo.png', false);
    const theirs = await seed(env.runtime, 'someone-else', 'theirs.wav', true);
    const client = await connect(env.runtime, owner);
    const id = await create(client);
    const part = await edit(client, 'score.add_part', { score_id: id });
    const region = await edit(client, 'score.add_region', {
      score_id: part.score_id,
      part_id: 'p1',
      at_beats: 0,
      length_beats: 4,
    });

    // Bad ids name what the score has.
    const noPart = await refusal(client, 'score.add_device', {
      score_id: id,
      part_id: 'p7',
      name: 'organ',
    });
    expect(noPart).toMatchObject({
      code: 'not_found',
      message: 'No part p7 in this score',
      hint: 'Its parts: none yet',
    });
    expect((await refusal(client, 'score.get', { score_id: `sc_${'f'.repeat(32)}` })).code).toBe(
      'not_found',
    );

    // A bad device param is refused with the device's whole param list inline.
    const bad = await refusal(client, 'score.add_device', {
      score_id: part.score_id,
      part_id: 'p1',
      name: 'reverb',
      params: { decay_seconds: 500, wet: 0.5 },
    });
    expect(bad.message).toMatch(/^reverb: decay_seconds:/);
    expect(bad.hint).toBe(deviceParamsText('reverb'));
    const unknown = await refusal(client, 'score.add_device', {
      score_id: part.score_id,
      part_id: 'p1',
      name: 'kazoo',
    });
    expect(unknown.hint).toMatch(/^Instruments: sampler, synth, grand_piano/);
    expect(unknown.hint).toMatch(/Effects: eq, filter, compressor/);

    // Media must be this owner's and have sound.
    expect(
      (
        await refusal(client, 'score.add_region', {
          score_id: part.score_id,
          part_id: 'p1',
          at_beats: 0,
          media_id: theirs,
        })
      ).code,
    ).toBe('not_found');
    expect(
      (
        await refusal(client, 'score.add_region', {
          score_id: part.score_id,
          part_id: 'p1',
          at_beats: 0,
          media_id: silent,
        })
      ).code,
    ).toBe('no_audio');

    // Platform limits are refused with their number.
    const many = Array.from({ length: 2001 }, (_, i) => ({
      pitch: 60,
      at_beats: i / 1000,
      length_beats: 0.1,
      velocity: 64,
    }));
    const limit = await refusal(client, 'score.add_notes', {
      score_id: region.score_id,
      region_id: region.region_id,
      notes: many,
    });
    expect(limit.text).toMatch(/up to 2,000 notes a call \(a limit of the platform\)/);

    // Positions take exactly one of beats or seconds.
    expect(
      (
        await refusal(client, 'score.add_region', {
          score_id: part.score_id,
          part_id: 'p1',
          at_beats: 0,
          at_seconds: 0,
          length_beats: 1,
        })
      ).message,
    ).toMatch(/one of at_beats or at_seconds/);

    // Batch: a bad $ref and a failing op name the op; nothing is applied.
    const ref = await refusal(client, 'score.batch', {
      score_id: part.score_id,
      ops: [
        {
          tool: 'score.add_region',
          args: { part_id: { $ref: 'ops[0].part_id' }, at_beats: 0, length_beats: 1 },
        },
      ],
    });
    expect(ref.message).toMatch(/has not run yet/);
    const failing = await refusal(client, 'score.batch', {
      score_id: part.score_id,
      ops: [
        { tool: 'score.add_part', args: {} },
        { tool: 'score.add_send', args: { from_part_id: 'p1', to_part_id: 'p1', level_db: 0 } },
      ],
    });
    expect(failing.message).toMatch(
      /^ops\[1\] \(score.add_send\): A send cannot feed its own part/,
    );
    const shape = await refusal(client, 'score.batch', {
      score_id: part.score_id,
      ops: [{ tool: 'score.trim_region', args: { region_id: 'r3', edge: 'middle', to_beats: 1 } }],
    });
    expect(shape.hint).toMatch(/score.trim_region args: \{region_id: string, edge: "start"\|"end"/);
  });

  it('serve the device catalogue', async () => {
    const client = await connect(env.runtime);
    const res = await client.readResource({ uri: 'video://catalog/devices' });
    const first = res.contents[0];
    const body = JSON.parse(first && 'text' in first ? first.text : '{}');
    expect(Object.keys(body.instruments)).toEqual(
      expect.arrayContaining(['sampler', 'synth', 'kit_808']),
    );
    expect(body.effects.delay.params.time_beats).toMatchObject({
      range: [0.001, 64],
      unit: 'beats',
      automatable: false,
    });
    expect(body.effects.eq.params.bands.list.gain_db).toMatchObject({
      automatable: true,
      default: 0,
    });
    expect(body.instruments.kit_acoustic.pitches['36']).toBe('kick (C2)');
  });
});
