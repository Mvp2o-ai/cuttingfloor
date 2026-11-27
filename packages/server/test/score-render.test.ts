import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BIN, checkMusicProject, MUSIC_CONTENT } from '@cuttingfloor/engine';
import { ScoreRenderResult, type withJob } from '@cuttingfloor/schema';
import type { Client } from '@modelcontextprotocol/client';
import { beforeAll, describe, expect, it } from 'vitest';
import type * as z from 'zod/v4';
import { musicProject } from '../src/score-render.ts';
import { call, connect, ok, settled, type TestEnv, testRuntime } from './helpers.ts';

// score.render: the project a score is written as for the engine (checked anywhere), and the
// render itself through the tool (where cf-music, its content and FFmpeg are: the image).

const exec = promisify(execFile);
const engine = await (async () => {
  try {
    await exec(BIN.ffmpeg, ['-version']);
    const { stdout } = await exec(BIN.music, ['catalog', '--content', MUSIC_CONTENT]);
    return stdout.includes('grand_piano');
  } catch {
    return false;
  }
})();
if (!engine && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but cf-music or FFmpeg is missing');
}

let env: TestEnv;
let client: Client;
beforeAll(async () => {
  env = await testRuntime();
  client = await connect(env.runtime);
});

type Edit = { score_id: string } & Record<string, unknown>;
const edit = (tool: string, args: Record<string, unknown>) => ok<Edit>(client, tool, args);

/** Two bars at 120: a synth bass and a kit, the bass through a filter that opens, into a reverb part. */
async function piece(): Promise<{ score_id: string; bass: string; drums: string; room: string }> {
  const made = await edit('score.create', {
    tempo: 120,
    meter: { beats: 4, unit: 4 },
    sample_rate: 48_000,
    fps: { num: 30, den: 1 },
    name: 'two bars',
  });
  const built = await ok<Edit & { results: Array<Record<string, string>> }>(client, 'score.batch', {
    score_id: made.score_id,
    ops: [
      { tool: 'score.add_part', args: { name: 'bass', gain_db: -6 } },
      { tool: 'score.add_part', args: { name: 'drums' } },
      { tool: 'score.add_part', args: { name: 'room' } },
      {
        tool: 'score.add_device',
        args: {
          part_id: { $ref: 'ops[0].part_id' },
          name: 'synth',
          params: {
            oscillators: [{ wave: 'saw' }],
            filter: { type: 'lowpass', cutoff_hz: 400 },
          },
        },
      },
      { tool: 'score.add_device', args: { part_id: { $ref: 'ops[1].part_id' }, name: 'kit_808' } },
      {
        tool: 'score.add_device',
        args: {
          part_id: { $ref: 'ops[2].part_id' },
          name: 'reverb',
          params: { decay_seconds: 1.5, wet: 1, dry: 0 },
        },
      },
      {
        tool: 'score.add_send',
        args: {
          from_part_id: { $ref: 'ops[1].part_id' },
          to_part_id: { $ref: 'ops[2].part_id' },
          level_db: -12,
        },
      },
      {
        tool: 'score.add_region',
        args: {
          part_id: { $ref: 'ops[0].part_id' },
          at_beats: 0,
          length_beats: 8,
          notes: [
            { pitch: 'C2', at_beats: 0, length_beats: 2, velocity: 100 },
            { pitch: 'G1', at_beats: 4, length_beats: 2, velocity: 100 },
          ],
        },
      },
      {
        tool: 'score.add_region',
        args: {
          part_id: { $ref: 'ops[1].part_id' },
          at_beats: 0,
          length_beats: 8,
          notes: [0, 2, 4, 6].flatMap((b) => [
            { pitch: 'C2', at_beats: b, length_beats: 0.5, velocity: 110 },
            { pitch: 'D2', at_beats: b + 1, length_beats: 0.5, velocity: 100 },
          ]),
        },
      },
      {
        tool: 'score.set_automation',
        args: {
          target: { device_id: { $ref: 'ops[3].device_id' }, param: 'filter.cutoff_hz' },
          points: [
            { at_beats: 0, value: 400, curve: 'linear' },
            { at_beats: 8, value: 4000, curve: 'linear' },
          ],
        },
      },
    ],
  });
  const ids = built.results;
  return {
    score_id: built.score_id,
    bass: ids[0]?.part_id as string,
    drums: ids[1]?.part_id as string,
    room: ids[2]?.part_id as string,
  };
}

describe('the project a score is written as', () => {
  it('gives the engine tracks, notes in the score’s own seconds, sends and lanes', async () => {
    const p = await piece();
    const doc = await env.runtime.scores.get('local', p.score_id);
    const { project, performance } = musicProject(doc, { from_beats: 0, until_beats: 8 }, () => '');
    // The engine accepts exactly this: nothing in a score is outside what it checks.
    expect(() => checkMusicProject(project)).not.toThrow();
    expect(project).toMatchObject({ sample_rate: 48_000, from: 0, until: 4 });
    expect(project.tracks.map((t) => t.id)).toEqual([p.bass, p.drums, p.room]);
    const bass = project.tracks[0];
    expect(bass?.notes).toEqual([
      { start: 0, length: 1, pitch: 36, velocity: 100 },
      { start: 2, length: 1, pitch: 31, velocity: 100 },
    ]);
    expect(bass?.gain_db).toBe(-6);
    expect(bass?.devices?.[0]).toMatchObject({ name: 'synth' });
    expect(project.tracks[1]?.sends).toEqual([
      { id: expect.any(String), to: p.room, level_db: -12, before_gain: false },
    ]);
    expect(project.automation?.[0]).toMatchObject({
      target: { device: bass?.devices?.[0]?.id, param: 'filter.cutoff_hz' },
    });
    expect(performance.played.sort()).toEqual([p.bass, p.drums].sort());
  });

  it('a later range still plays from the start, and keeps only the range', async () => {
    const p = await piece();
    const doc = await env.runtime.scores.get('local', p.score_id);
    const { project, performance } = musicProject(doc, { from_beats: 4, until_beats: 8 }, () => '');
    expect(project).toMatchObject({ from: 2, until: 4 });
    // The note that began before the range is still there, at its own time in the score.
    expect(project.tracks[0]?.notes?.[0]).toMatchObject({ start: 0, pitch: 36 });
    expect(performance.range).toMatchObject({ from_seconds: 2, until_seconds: 4 });
  });

  it('parts asked for play alone, with what they sound through', async () => {
    const p = await piece();
    const doc = await env.runtime.scores.get('local', p.score_id);
    const { project, performance } = musicProject(
      doc,
      { from_beats: 0, until_beats: 8, parts: [p.drums] },
      () => '',
    );
    expect(performance.played).toEqual([p.drums]);
    const byId = new Map(project.tracks.map((t) => [t.id, t]));
    expect(byId.get(p.bass)?.notes ?? []).toEqual([]);
    expect(byId.get(p.drums)?.notes?.length).toBe(8);
    // The reverb part its send reaches is still there to carry it.
    expect(byId.has(p.room)).toBe(true);
  });
});

describe('score.render refusals that need no engine', () => {
  it('refuses a score with nothing to render to, and a range that ends before it starts', async () => {
    const empty = await edit('score.create', {
      tempo: 100,
      meter: { beats: 4, unit: 4 },
      sample_rate: 44_100,
    });
    const none = await call(client, 'score.render', { score_id: empty.score_id });
    expect(none.isError).toBe(true);
    expect(none.structured).toMatchObject({ code: 'bad_request' });
    expect(String(none.structured.hint)).toContain('until_beats');
    const p = await piece();
    const back = await call(client, 'score.render', {
      score_id: p.score_id,
      from_beats: 6,
      until_beats: 2,
    });
    expect(back.structured).toMatchObject({ code: 'bad_request' });
    const both = await call(client, 'score.render', {
      score_id: p.score_id,
      from_beats: 0,
      from_seconds: 0,
    });
    expect(both.isError).toBe(true);
  });
});

describe.skipIf(!engine)('score.render through the engine', () => {
  type Job = z.infer<ReturnType<typeof withJob<typeof ScoreRenderResult>>>;
  const render = async (args: Record<string, unknown>) => {
    const started = await ok<{ job_id: string; media_id: string }>(client, 'score.render', args);
    const job = await settled<Job>(client, started.job_id, 120_000);
    expect(job.status, JSON.stringify(job)).toBe('completed');
    const result = ScoreRenderResult.parse(job.result);
    return { ...result, job_id: started.job_id };
  };

  it('makes audio media with what it measured, and the same render is the same media', async () => {
    const p = await piece();
    const full = await render({ score_id: p.score_id });
    expect(full).toMatchObject({ kind: 'audio', status: 'ready' });
    expect(full.render.length_seconds).toBeCloseTo(4, 2);
    expect(full.render.loudness.integrated_lufs).toBeGreaterThan(-60);
    expect(full.render.clipped_samples).toBe(0);
    expect(full.render.parts_sounded.sort()).toEqual([p.bass, p.drums].sort());
    expect(full.render.bars).toEqual([
      { bar: 1, beats: 0, seconds: 0, frames: 0 },
      { bar: 2, beats: 4, seconds: 2, frames: 60 },
    ]);
    expect(full.render.ends_seconds).toBeUndefined();
    const again = await render({ score_id: p.score_id });
    expect(again.media_id).toBe(full.media_id);
    expect(again.render).toEqual(full.render);
  }, 180_000);

  it('one part alone is quieter than the mix, a tail runs past the end, and MP3 is MP3', async () => {
    const p = await piece();
    const full = await render({ score_id: p.score_id });
    const drums = await render({ score_id: p.score_id, parts: [p.drums] });
    expect(drums.media_id).not.toBe(full.media_id);
    expect(drums.render.parts_sounded).toEqual([p.drums]);
    const tail = await render({ score_id: p.score_id, tail_db: -60 });
    // How far past the end depends on how loud the piece is against tail_db: only that it runs on.
    expect(tail.render.ends_seconds).toBeGreaterThan(4);
    expect(tail.render.length_seconds).toBeGreaterThan(4);
    expect(tail.render.length_seconds).toBeCloseTo(tail.render.ends_seconds as number, 1);
    const mp3 = await render({ score_id: p.score_id, format: 'mp3', from_seconds: 2 });
    expect(mp3.render.from).toMatchObject({ beats: 4, seconds: 2, frames: 60 });
    expect(mp3.render.length_seconds).toBeCloseTo(2, 1);
    const info = await ok<{ probe?: { format?: string } }>(client, 'media.get', {
      media_id: mp3.media_id,
    });
    expect(JSON.stringify(info)).toContain('mp3');
  }, 240_000);

  it('goes under a picture: the render is a clip on a timeline', async () => {
    const p = await piece();
    const music = await render({ score_id: p.score_id });
    const timeline = await ok<{ timeline_id: string; tracks: Array<{ id: string; kind: string }> }>(
      client,
      'timeline.create',
      { sequence: { width: 1280, height: 720, fps: { num: 30, den: 1 } } },
    );
    const audio = timeline.tracks.find((t) => t.kind === 'audio')?.id;
    const placed = await ok<{ timeline_id: string; clip_id: string }>(client, 'clip.add', {
      timeline_id: timeline.timeline_id,
      track_id: audio,
      media_id: music.media_id,
      preview: 'none',
    });
    expect(placed.clip_id).toBeTruthy();
  }, 180_000);

  it('a score can be looked at as sound: render.spectrogram takes its score_id', async () => {
    const p = await piece();
    const picture = await call(client, 'render.spectrogram', { score_id: p.score_id });
    expect(picture.isError, JSON.stringify(picture.structured)).toBe(false);
    expect(picture.content.some((c) => c.type === 'image')).toBe(true);
    expect((picture.structured.bars as unknown[]).length).toBe(2);
  }, 180_000);
});
