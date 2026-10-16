import { BatchResult, EditResult } from '@cuttingfloor/schema';
import { TASKS_EXTENSION_ID_V2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { call, connect, ok, SEQ_720P25, type TestEnv, testRuntime } from './helpers.ts';

const anyResult = z.object({}).passthrough();
/** tools/list as JSON, in bytes (about 4 bytes per token). */
const BUDGET_BYTES = 88_000;
let env: TestEnv;

beforeAll(async () => {
  env = await testRuntime();
});

describe('protocol surface', () => {
  it('advertises the Tasks extension and instructions', async () => {
    const client = await connect(env.runtime);
    expect(client.getServerCapabilities()?.extensions).toHaveProperty(TASKS_EXTENSION_ID_V2);
    expect(client.getInstructions()).toMatch(/timeline_id/);
  });

  it('lists the tools, each annotated', async () => {
    const client = await connect(env.runtime);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'audio.duck',
        'audio.fade',
        'audio.set_gain',
        'audio.set_loudness',
        'audio.set_master',
        'audio.set_pan',
        'caption.add',
        'clip.add',
        'clip.freeze',
        'clip.link',
        'clip.move',
        'clip.remove',
        'clip.replace',
        'clip.roll',
        'clip.set_animation',
        'clip.set_blend',
        'clip.set_enabled',
        'clip.set_mask',
        'clip.set_speed',
        'clip.set_transform',
        'clip.slide',
        'clip.slip',
        'clip.split',
        'clip.trim',
        'clip.unlink',
        'edit.batch',
        'export.video',
        'job.cancel',
        'job.get',
        'job.list',
        'media.get',
        'media.import',
        'qa.check',
        'range.extract',
        'range.lift',
        'render.frames',
        'text.set',
        'timeline.create',
        'timeline.diff',
        'timeline.get',
        'timeline.history',
        'timeline.load',
        'timeline.set_sequence',
        'title.add',
        'track.add',
        'track.remove',
        'track.set',
        'transition.add',
        'transition.remove',
        'transition.set',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.annotations?.title, tool.name).toBeTruthy();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe('boolean');
    }
  });

  it('keeps tool definitions inside the size budget', async () => {
    // Every connection pays for tools/list in tokens. Raise this deliberately, not by drift
    // (spec §21.5): catalogues belong in video://catalog resources, not in tool schemas.
    const client = await connect(env.runtime);
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools).length).toBeLessThan(BUDGET_BYTES);
  });

  it('serves catalogues as resources', async () => {
    const client = await connect(env.runtime);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(['video://catalog/eases', 'video://catalog/animations']),
    );
    const res = await client.readResource({ uri: 'video://catalog/blend_modes' });
    const first = res.contents[0];
    expect(JSON.parse(first && 'text' in first ? first.text : '{}')).toHaveProperty('screen');
    await expect(client.readResource({ uri: 'video://catalog/nope' })).rejects.toThrow(
      /Unknown catalogue/,
    );
  });

  it('serves health without key values', async () => {
    const client = await connect(env.runtime);
    const res = await client.readResource({ uri: 'video://server/health' });
    const first = res.contents[0];
    const body = JSON.parse(first && 'text' in first ? first.text : '{}');
    expect(body.providers.elevenlabs).toEqual({ configured: false });
    expect(body.mode).toBe('local');
    expect(body.engines).toHaveProperty('melt');
  });
});

describe('timelines', () => {
  it('creates, edits immutably, and keeps history', async () => {
    const client = await connect(env.runtime);
    const { timeline_id: t0 } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'Cut',
      sequence: SEQ_720P25,
    });
    const added = await ok<{
      timeline_id: string;
      track_id: string;
      changed: unknown[];
      preview: null;
    }>(client, 'track.add', {
      timeline_id: t0,
      kind: 'video',
      name: 'Titles',
      preview: 'none',
    });
    expect(EditResult.parse(added)).toBeTruthy();
    expect(added.timeline_id).not.toBe(t0);
    expect(added.changed).toEqual([{ id: added.track_id, type: 'track', change: 'added' }]);
    // The old timeline is unchanged and still usable.
    const before = await ok<{ tracks: unknown[] }>(client, 'timeline.get', { timeline_id: t0 });
    const after = await ok<{ tracks: unknown[] }>(client, 'timeline.get', {
      timeline_id: added.timeline_id,
    });
    expect(before.tracks).toHaveLength(2);
    expect(after.tracks).toHaveLength(3);
    const history = await ok<{ entries: Array<{ tool: string }> }>(client, 'timeline.history', {
      timeline_id: added.timeline_id,
    });
    expect(history.entries.map((e) => e.tool)).toEqual(['track.add', 'timeline.create']);
    const d = await ok<{ changed: unknown[] }>(client, 'timeline.diff', {
      from: t0,
      to: added.timeline_id,
    });
    expect(d.changed).toHaveLength(1);
    // The same edit on the same timeline gives the same id.
    const again = await ok<{ timeline_id: string }>(client, 'track.add', {
      timeline_id: t0,
      kind: 'video',
      name: 'Titles',
      preview: 'none',
    });
    expect(again.timeline_id).toBe(added.timeline_id);
  });

  it('restores a timeline from its JSON', async () => {
    const client = await connect(env.runtime);
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'Restore',
      sequence: SEQ_720P25,
    });
    const view = await ok(client, 'timeline.get', { timeline_id });
    const other = await connect(env.runtime, 'another-user');
    // Another owner cannot see it, but can load the JSON.
    expect((await call(other, 'timeline.get', { timeline_id })).structured).toMatchObject({
      code: 'expired',
    });
    const loaded = await ok<{ timeline_id: string }>(other, 'timeline.load', { timeline: view });
    expect(loaded.timeline_id).toMatch(/^tl_/);
  });

  it('returns typed, actionable errors', async () => {
    const client = await connect(env.runtime);
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'E',
      sequence: SEQ_720P25,
    });
    const missing = await call(client, 'clip.remove', { timeline_id, clip_id: 'c42' });
    expect(missing.isError).toBe(true);
    expect(missing.structured).toMatchObject({
      code: 'not_found',
      hint: 'The timeline has no clips',
    });
    const media = await call(client, 'clip.add', {
      timeline_id,
      track_id: 't1',
      media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(media.structured).toMatchObject({ code: 'not_found' });
    const expired = await call(client, 'timeline.get', { timeline_id: `tl_${'0'.repeat(32)}` });
    expect(expired.structured).toMatchObject({ code: 'expired' });
    const rate = await call(client, 'timeline.create', {
      name: 'x',
      sequence: { ...SEQ_720P25, fps: { num: 11, den: 1 } },
    });
    expect(rate.isError).toBe(true);
  });

  it('runs edit.batch atomically with $refs', async () => {
    const client = await connect(env.runtime);
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'B',
      sequence: SEQ_720P25,
    });
    const res = await ok<{ timeline_id: string; results: Array<{ track_id?: string }> }>(
      client,
      'edit.batch',
      {
        timeline_id,
        preview: 'none',
        ops: [
          { tool: 'track.add', args: { kind: 'audio', name: 'Music' } },
          { tool: 'track.set', args: { track_id: { $ref: 'ops[0].track_id' }, muted: true } },
        ],
      },
    );
    expect(BatchResult.parse(res)).toBeTruthy();
    const view = await ok<{ tracks: Array<{ name: string; muted: boolean }> }>(
      client,
      'timeline.get',
      { timeline_id: res.timeline_id },
    );
    expect(view.tracks.find((t) => t.name === 'Music')?.muted).toBe(true);
    const failed = await call(client, 'edit.batch', {
      timeline_id,
      ops: [
        { tool: 'track.add', args: { kind: 'audio' } },
        { tool: 'track.remove', args: { track_id: 't99' } },
      ],
    });
    expect(failed.structured).toMatchObject({ code: 'not_found', detail: { op_index: 1 } });
  });
});

describe('media and jobs without engines', () => {
  it('refuses paths outside the media roots before creating a job', async () => {
    const client = await connect(env.runtime);
    const res = await call(client, 'media.import', { source: { path: '/etc/passwd' } });
    expect(res.structured).toMatchObject({ code: 'path_not_allowed' });
    expect((await ok<{ jobs: unknown[] }>(client, 'job.list', {})).jobs).toHaveLength(0);
  });

  it('answers tasks/get only for the owner, and unknown jobs as errors', async () => {
    const job = await env.runtime.jobs.store.create({ owner: 'local', tool: 'export.video' });
    const client = await connect(env.runtime);
    const got = await client.request(
      { method: 'tasks/get', params: { taskId: job.id } } as never,
      anyResult,
    );
    expect(got).toMatchObject({ taskId: job.id, status: 'working' });
    const stranger = await connect(env.runtime, 'someone-else');
    await expect(
      stranger.request({ method: 'tasks/get', params: { taskId: job.id } } as never, anyResult),
    ).rejects.toThrow();
    expect((await call(stranger, 'job.get', { job_id: job.id })).structured).toMatchObject({
      code: 'not_found',
    });
  });

  it('marks jobs left working by a previous process as interrupted', async () => {
    const job = await env.runtime.jobs.store.create({ owner: 'local', tool: 'export.video' });
    await env.runtime.jobs.recover();
    const client = await connect(env.runtime);
    const view = await ok<{ status: string; error: { code: string } }>(client, 'job.get', {
      job_id: job.id,
    });
    expect(view).toMatchObject({ status: 'completed', error: { code: 'interrupted' } });
  });
});
