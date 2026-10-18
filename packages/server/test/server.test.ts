import { BatchResult, CfError, EditResult } from '@cuttingfloor/schema';
import { TASKS_EXTENSION_ID_V2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { call, connect, ok, SEQ_720P25, type TestEnv, testRuntime } from './helpers.ts';

const anyResult = z.object({}).passthrough();
/**
 * tools/list as JSON, in bytes (about 4 bytes per token). Raised from 110 000 for the look guide
 * in media.analyze, and from 115 000 for judge.ask.
 */
const BUDGET_BYTES = 123_000;
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

  it('advertises open output schemas, so added result fields never break cached clients', async () => {
    const client = await connect(env.runtime);
    const { tools } = await client.listTools();
    const withOutput = tools.filter((t) => t.outputSchema);
    expect(withOutput.length).toBeGreaterThan(5);
    for (const t of withOutput) {
      expect(JSON.stringify(t.outputSchema), t.name).not.toContain('"additionalProperties":false');
    }
  });

  it('waits on a job with wait_seconds instead of polling', async () => {
    const client = await connect(env.runtime, 'waiter');
    const job = await env.runtime.jobs.store.create({ owner: 'waiter', tool: 'export.video' });
    setTimeout(() => {
      void env.runtime.jobs.store.update(job, { status: 'completed', progress: 1 });
    }, 300);
    const started = Date.now();
    const got = await ok<{ status: string }>(client, 'job.get', {
      job_id: job.id,
      wait_seconds: 5,
    });
    expect(got.status).toBe('completed');
    expect(Date.now() - started).toBeLessThan(3000);
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
        'adjustment.add',
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
        'code.run',
        'create.cutout',
        'create.matte',
        'create.motion',
        'create.still',
        'create.voiceover',
        'edit.batch',
        'export.timeline',
        'export.video',
        'filter.add',
        'filter.remove',
        'filter.set',
        'job.cancel',
        'job.get',
        'job.list',
        'judge.ask',
        'media.analyze',
        'media.get',
        'media.import',
        'media.upload',
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
    const { timeline_id: t0, tracks } = await ok<{
      timeline_id: string;
      tracks: Array<{ id: string; kind: string; name: string }>;
    }>(client, 'timeline.create', { name: 'Cut', sequence: SEQ_720P25 });
    // The track ids come back, so the first clip.add needs no timeline.get or guess.
    expect(tracks).toEqual([
      { id: 't1', kind: 'video', name: 'V1' },
      { id: 't2', kind: 'audio', name: 'A1' },
    ]);
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
  it('moves analyses a record kept inline into their own files, keeping every one', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const client = await connect(env.runtime, 'legacy');
    const id = 'm_aaaaaaaaaaaaaaaaaaaaaaaaab';
    const dir = env.runtime.media.dir('legacy', id);
    const now = new Date().toISOString();
    const run = { id: 'j_a', model: 'jev-1.14.0', questions: {}, with_previous: false, frames: [] };
    await env.runtime.ws.writeJson(`${dir}/media.json`, {
      media_id: id,
      name: 'old.mp4',
      status: 'ready',
      source: { path: '/media/old.mp4' },
      file: null,
      size: null,
      fingerprint: null,
      probe: null,
      conform: [],
      mezzanine: null,
      proxy: null,
      analysis: null,
      analyses: {
        beats: { bpm: 120, beats: [0.5], downbeats: [0.5] },
        look: { runs: [run] },
      },
      created_at: now,
      updated_at: now,
    });
    const got = await ok<Record<string, unknown>>(client, 'media.get', {
      media_id: id,
      include: ['beats', 'look'],
    });
    expect(got).toMatchObject({ beats: { bpm: 120 }, look: { runs: [{ id: 'j_a' }] } });
    expect(JSON.parse(await readFile(`${dir}/media.json`, 'utf8'))).not.toHaveProperty('analyses');
    expect((await readdir(`${dir}/analyses`)).sort()).toEqual([
      'beats.json',
      `look-${'0'.repeat(14)}-j_a.json`,
    ]);

    // Two runs stored at the same moment (two servers) both stay; only the newest 10 are kept.
    await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        env.runtime.media.saveAnalysis('legacy', id, 'look', { ...run, id: `j_${i}` }),
      ),
    );
    const after = await env.runtime.media.get('legacy', id);
    expect(after.analyses?.look?.runs).toHaveLength(10);
    expect(after.analyses?.beats?.bpm).toBe(120);
  });

  it('asks for a TypeSafe key and questions before a look starts a job', async () => {
    const bare = await connect(env.runtime, 'looker');
    const look = { media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'look' };
    const noKey = await call(bare, 'media.analyze', {
      ...look,
      questions: { speaker: { type: 'noul', instructions: 'Is a person in `frame`?' } },
    });
    expect(noKey.structured).toMatchObject({
      code: 'credential_required',
      detail: { provider: 'typesafe', env: 'TYPESAFE_API_KEY' },
    });
    const keyed = await connect(env.runtime, 'looker', { TYPESAFE_API_KEY: 'ts-secret-test' });
    const noQuestions = await call(keyed, 'media.analyze', look);
    expect(noQuestions.structured).toMatchObject({ code: 'bad_request' });
    expect((await ok<{ jobs: unknown[] }>(keyed, 'job.list', {})).jobs).toHaveLength(0);
    expect(JSON.stringify([noKey, noQuestions])).not.toContain('ts-secret-test');
  });

  it('refuses paths outside the media roots before creating a job', async () => {
    const client = await connect(env.runtime);
    const res = await call(client, 'media.import', { source: { path: '/etc/passwd' } });
    expect(res.structured).toMatchObject({ code: 'path_not_allowed' });
    expect((await ok<{ jobs: unknown[] }>(client, 'job.list', {})).jobs).toHaveLength(0);
  });

  it('drops cached frames on start, so a new build never serves an old render', async () => {
    const { mkdir, writeFile, access } = await import('node:fs/promises');
    const stale = env.runtime.ws.path('cache', 'frames', 'tl_x-1-640.webp');
    await mkdir(env.runtime.ws.path('cache', 'frames'), { recursive: true });
    await writeFile(stale, 'old');
    await env.runtime.start({ sweep: false });
    await expect(access(stale)).rejects.toThrow();
  });

  it('imports only a completed export.video, and says why not otherwise', async () => {
    const client = await connect(env.runtime, 'renders');
    const store = env.runtime.jobs.store;
    const notExport = await store.create({ owner: 'renders', tool: 'qa.check' });
    const rendering = await store.create({ owner: 'renders', tool: 'export.video' });
    const missing = await call(client, 'media.import', {
      source: { job_id: 'j_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(missing.structured).toMatchObject({ code: 'not_found' });
    const wrong = await call(client, 'media.import', { source: { job_id: notExport.id } });
    expect(wrong.structured).toMatchObject({ code: 'bad_request' });
    const busy = await call(client, 'media.import', { source: { job_id: rendering.id } });
    expect(busy.structured).toMatchObject({ code: 'media_not_ready' });
  });

  it('shows a job whose tool failed as failed', async () => {
    const client = await connect(env.runtime, 'failer');
    const job = await env.runtime.jobs.store.create({ owner: 'failer', tool: 'media.import' });
    await env.runtime.jobs.store.update(job, {
      status: 'completed',
      statusMessage: 'failed',
      result: {
        isError: true,
        content: [],
        structuredContent: { code: 'path_not_allowed', message: 'nope' },
      } as never,
    });
    const view = await ok<{ status: string; error: { code: string } }>(client, 'job.get', {
      job_id: job.id,
    });
    expect(view.status).toBe('failed');
    expect(view.error.code).toBe('path_not_allowed');
  });

  it('names the host folder behind a media root when a path is not found', async () => {
    const local = await testRuntime({ mediaHostPath: '/Users/someone/Movies' });
    local.runtime.media.config.hostFolders = { [local.mediaDir]: '/Users/someone/Movies' };
    const client = await connect(local.runtime);
    const res = await call(client, 'media.import', { source: { path: '/Users/someone/clip.mp4' } });
    expect(String(res.structured.hint)).toContain(`${local.mediaDir} is /Users/someone/Movies`);
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
    expect(view).toMatchObject({ status: 'failed', error: { code: 'interrupted' } });
  });
});

describe('access', () => {
  it('runs no tool for an owner the access check refuses, and says where to subscribe', async () => {
    const env = await testRuntime();
    let allowed = false;
    const client = await connect(env.runtime, 'user_x', {}, async () => {
      if (!allowed)
        throw new CfError('subscription_required', 'The free trial ended', {
          hint: 'Subscribe at https://example.com/account',
        });
    });
    const sequence = SEQ_720P25;
    const refused = await call(client, 'timeline.create', { name: 'A', sequence });
    expect(refused.isError).toBe(true);
    expect(refused.structured).toMatchObject({ code: 'subscription_required' });
    expect(String(refused.structured.hint)).toContain('/account');
    // Listing tools still works, so the client can show the refusal's hint.
    expect((await client.listTools()).tools.length).toBeGreaterThan(40);
    allowed = true;
    expect((await call(client, 'timeline.create', { name: 'A', sequence })).isError).toBe(false);
  });
});
