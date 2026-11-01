import { installedFonts } from '@cuttingfloor/engine';
import { BatchResult, CfError, EditResult, QaCheckResult, withJob } from '@cuttingfloor/schema';
import { TASKS_EXTENSION_ID_V2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { call, connect, ok, SEQ_720P25, settled, type TestEnv, testRuntime } from './helpers.ts';

const anyResult = z.object({}).passthrough();
/**
 * tools/list as JSON, in bytes (about 4 bytes per token). Raised from 110 000 for the look guide
 * in media.analyze, from 115 000 for judge.ask, and from 123 000 to 230 000 when every tool
 * declared its full output schema (about 117 000 of the total): clients chain calls on those
 * shapes, so they are the contract and are not slimmed to fit a harness. Raised to
 * 240 000 for media.seek, which finds moments from plain words, to 250 000 for other_tracks
 * on every rippling edit, to 256 000 for create.stabilized, to 266 000 for paging media.get
 * (time range, offset, limit and pages per analysis), to 286 000 for media origin (where
 * each media came from), declared on every tool that returns media, and media.delete, to
 * 301 000 for the source map of a render and the full probe facts on media, and to 331 000
 * for the speech and sound facts (media.analyze speech and loudness, media.correlate, qa.check
 * cut facts), and to 366 000 for the sound tools (media.analyze sounds, media.listen,
 * create.stems), whose results carry every score, to 386 000 for create.lipsync, and to
 * 392 000 for effect names and eases as enums plus the units, coordinate spaces and defaults
 * descriptions now state, since many clients can't read the catalogue resources, and to
 * 414 000 for create.upscaled (its full media result is most of it), each channel's levels on
 * every tool that returns media, and clip.set_speed's in-between frames, and to
 * 449 000 for the measured facts (media.analyze speakers, voice, colour and picture, picture
 * kinds on a timeline, beat strengths, placements after a transform, file fingerprints), and
 * to 460 000 for the stalled error code (in every declared error), the job a media is waiting
 * on (media.get job) and job.get's wait, estimates, for and result summaries.
 */
const BUDGET_BYTES = 460_000;
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

  it('advertises an open output schema on every tool, so clients can chain calls and added fields never break cached clients', async () => {
    const client = await connect(env.runtime);
    const { tools } = await client.listTools();
    expect(tools.filter((t) => !t.outputSchema).map((t) => t.name)).toEqual([]);
    for (const t of tools) {
      expect(JSON.stringify(t.outputSchema), t.name).not.toContain('"additionalProperties":false');
    }
  });

  it('answers job.get at once with where a working job stands', async () => {
    const client = await connect(env.runtime, 'reader');
    const job = await env.runtime.jobs.store.create({ owner: 'reader', tool: 'export.video' });
    const started = Date.now();
    const got = await ok<{ status: string }>(client, 'job.get', { job_id: job.id });
    expect(got.status).toBe('working');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reads many jobs in one job.get, saying which ids it has no job for', async () => {
    const client = await connect(env.runtime, 'many');
    const a = await env.runtime.jobs.store.create({ owner: 'many', tool: 'export.video' });
    const b = await env.runtime.jobs.store.create({ owner: 'many', tool: 'media.import' });
    const theirs = await env.runtime.jobs.store.create({ owner: 'other', tool: 'export.video' });
    const got = await ok<{
      jobs: Array<{ job_id: string; tool: string; status: string }>;
      not_found: string[];
    }>(client, 'job.get', { job_ids: [b.id, theirs.id, a.id, b.id] });
    expect(got.jobs.map((j) => [j.job_id, j.tool, j.status])).toEqual([
      [b.id, 'media.import', 'working'],
      [a.id, 'export.video', 'working'],
    ]);
    expect(got.not_found).toEqual([theirs.id]);
    expect(
      (await call(client, 'job.get', { job_id: a.id, job_ids: [b.id] })).structured,
    ).toMatchObject({ code: 'bad_request' });
  });

  it('lists the tools, each annotated', async () => {
    const client = await connect(env.runtime);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'audio.fade',
        'audio.set_gain',
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
        'create.cutout',
        'create.lipsync',
        'create.matte',
        'create.motion',
        'create.stabilized',
        'create.stems',
        'create.still',
        'create.upscaled',
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
        'media.correlate',
        'media.delete',
        'media.get',
        'media.import',
        'media.list',
        'media.listen',
        'media.seek',
        'media.upload',
        'qa.check',
        'range.extract',
        'range.lift',
        'render.frames',
        'skills.get',
        'skills.search',
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
      const a = tool.annotations ?? {};
      expect(a.title, tool.name).toBeTruthy();
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(typeof a[hint as keyof typeof a], `${tool.name} ${hint}`).toBe('boolean');
      }
    }
  });

  it('marks exactly the tools that change nothing read-only, so clients run them without asking', async () => {
    // Claude Cowork and ChatGPT ask the user before every tool not marked read-only. Edits write
    // a new timeline and create.* writes new media, so they are not read-only; a tool that only
    // reads or measures is, even when it runs as a job or keeps a cached render. A new tool
    // lands in one of these lists deliberately.
    const client = await connect(env.runtime);
    const { tools } = await client.listTools();
    const where = (hint: 'readOnlyHint' | 'destructiveHint' | 'openWorldHint') =>
      tools
        .filter((t) => t.annotations?.[hint])
        .map((t) => t.name)
        .sort();
    expect(where('readOnlyHint')).toEqual(
      [
        'job.get',
        'job.list',
        'judge.ask',
        'media.correlate',
        'media.get',
        'media.list',
        'media.listen',
        'media.seek',
        'qa.check',
        'render.frames',
        'skills.get',
        'skills.search',
        'timeline.diff',
        'timeline.get',
        'timeline.history',
      ].sort(),
    );
    // The test runtime has an exports folder, where overwrite: true replaces a file.
    expect(where('destructiveHint')).toEqual(
      ['export.timeline', 'export.video', 'job.cancel', 'media.delete'].sort(),
    );
    expect(where('openWorldHint')).toEqual(
      ['create.lipsync', 'judge.ask', 'media.analyze', 'media.import', 'media.seek'].sort(),
    );
    for (const t of tools) {
      if (t.annotations?.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
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

  it('offers a player view (MCP Apps) on export.video and media.get results', async () => {
    const client = await connect(env.runtime);
    const { tools } = await client.listTools();
    const withPlayer = tools
      .filter((t) => (t._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri)
      .map((t) => t.name);
    expect(withPlayer.sort()).toEqual(['export.video', 'media.get']);
    const { resources } = await client.listResources();
    const listed = resources.find((r) => r.uri === 'ui://cuttingfloor/player');
    expect(listed?.mimeType).toBe('text/html;profile=mcp-app');
    const res = await client.readResource({ uri: 'ui://cuttingfloor/player' });
    const page = res.contents[0] as { mimeType?: string; text?: string; _meta?: unknown };
    expect(page.mimeType).toBe('text/html;profile=mcp-app');
    expect(page.text).toContain("'ui/initialize'");
    expect(page.text).not.toContain('__VERSION__');
    // The sandbox may load media only from this server.
    expect(page._meta).toEqual({
      ui: {
        csp: { resourceDomains: ['http://127.0.0.1:8787'] },
        permissions: { clipboardWrite: {} },
        prefersBorder: false,
      },
    });
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

describe('cross-track ripple', () => {
  it('warns which clips on other tracks a ripple trim leaves late, and keeps them in sync on request', async () => {
    const client = await connect(env.runtime);
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'Ripple',
      sequence: SEQ_720P25,
    });
    const built = await ok<{
      timeline_id: string;
      results: Array<{ clip_id?: string; track_id?: string }>;
    }>(client, 'edit.batch', {
      timeline_id,
      preview: 'none',
      ops: [
        { tool: 'track.add', args: { kind: 'video', name: 'Titles' } },
        {
          tool: 'title.add',
          args: { track_id: 't1', text: 'Cold open', at_frame: 0, duration_frames: 50 },
        },
        {
          tool: 'title.add',
          args: { track_id: 't1', text: 'Main', at_frame: 50, duration_frames: 50 },
        },
        {
          tool: 'title.add',
          args: {
            track_id: { $ref: 'ops[0].track_id' },
            text: 'Lower third',
            at_frame: 60,
            duration_frames: 20,
          },
        },
      ],
    });
    const v2 = built.results[0]?.track_id as string;
    const open = built.results[1]?.clip_id as string;
    const third = built.results[3]?.clip_id as string;
    const trim = {
      timeline_id: built.timeline_id,
      clip_id: open,
      edge: 'end',
      to_frame: 34,
      ripple: true,
      preview: 'none',
    };
    const stay = await ok<{ warnings: string[] }>(client, 'clip.trim', trim);
    expect(EditResult.parse(stay)).toBeTruthy();
    expect(stay.warnings.join('\n')).toContain(
      `now play 16 frames late against it: ${third} (${v2})`,
    );
    const sync = await ok<{ timeline_id: string; warnings: string[] }>(client, 'clip.trim', {
      ...trim,
      other_tracks: 'sync',
    });
    expect(sync.warnings).toEqual([]);
    const view = await ok<{
      tracks: Array<{ id: string; clips: Array<{ id: string; start: number; end: number }> }>;
    }>(client, 'timeline.get', { timeline_id: sync.timeline_id });
    expect(view.tracks.find((t) => t.id === v2)?.clips).toMatchObject([
      { id: third, start: 44, end: 64 },
    ]);
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

  it('reads a long transcript in pieces: by media time, then by page', async () => {
    const client = await connect(env.runtime, 'pager');
    const record = await env.runtime.media.create('pager', { path: '/media/talk.mp4' }, 'talk.mp4');
    // A word every second: word i runs from i to i + 0.5.
    const words = Array.from({ length: 50 }, (_, i) => ({
      text: `w${i}`,
      start: i,
      end: i + 0.5,
      confidence: 0.9,
    }));
    await env.runtime.media.saveAnalysis('pager', record.media_id, 'transcript', {
      model: 'tiny',
      language: 'en',
      text: words.map((w) => w.text).join(' '),
      words,
    });
    await env.runtime.media.saveAnalysis('pager', record.media_id, 'beats', {
      bpm: 60,
      beats: words.map((w) => w.start),
      downbeats: words.filter((_, i) => i % 4 === 0).map((w) => w.start),
    });
    type Got = {
      transcript: { text: string; words: Array<{ text: string }> };
      beats: { beats: number[]; downbeats: number[] };
      pages: Record<string, Record<string, unknown>>;
    };
    const stretch = await ok<Got>(client, 'media.get', {
      media_id: record.media_id,
      include: ['transcript', 'beats'],
      from_seconds: 10.2,
      to_seconds: 20,
      limit: 4,
    });
    // w10 still runs at 10.2; w20 starts at 20, outside.
    expect(stretch.transcript.words.map((w) => w.text)).toEqual(['w10', 'w11', 'w12', 'w13']);
    expect(stretch.transcript.text).toBe('w10 w11 w12 w13');
    expect(stretch.pages.transcript).toEqual({
      list: 'transcript.words',
      first: 10,
      returned: 4,
      matching: 10,
      total: 50,
      next_offset: 4,
    });
    expect(stretch.beats).toMatchObject({ beats: [11, 12, 13, 14], downbeats: [12] });
    const last = await ok<Got>(client, 'media.get', {
      media_id: record.media_id,
      include: ['transcript'],
      from_seconds: 10.2,
      to_seconds: 20,
      offset: 8,
      limit: 4,
    });
    expect(last.transcript.words.map((w) => w.text)).toEqual(['w18', 'w19']);
    expect(last.pages.transcript).toMatchObject({ first: 18, returned: 2, next_offset: null });
    // Without a window, the whole list, as before.
    const whole = await ok<Got>(client, 'media.get', {
      media_id: record.media_id,
      include: ['transcript'],
    });
    expect(whole.transcript.words).toHaveLength(50);
    expect(whole).not.toHaveProperty('pages');
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

  it('answers qa.check on a long timeline with a job handle its output schema allows', async () => {
    const client = await connect(env.runtime);
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'Long',
      sequence: SEQ_720P25,
    });
    const titled = await ok<{ timeline_id: string }>(client, 'title.add', {
      timeline_id,
      track_id: 't1',
      text: 'Thirty seconds',
      duration_frames: 750,
      preview: 'none',
    });
    // The client checks structured results against the advertised schema, so ok() alone
    // would fail on a mismatch; parse too, against the zod schema the server declares.
    const reply = await ok(client, 'qa.check', { timeline_id: titled.timeline_id });
    expect(withJob(QaCheckResult).parse(reply)).toMatchObject({ status: 'working' });
    await ok(client, 'job.cancel', { job_id: reply.job_id });
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

const fonts = await installedFonts();

describe('text fonts', () => {
  it.skipIf(!fonts.length)('refuses a font that is not installed and names real ones', async () => {
    const client = await connect(env.runtime);
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'fonts',
      sequence: SEQ_720P25,
    });
    const refused = await call(client, 'edit.batch', {
      timeline_id,
      ops: [
        {
          tool: 'title.add',
          args: { track_id: 't1', text: 'Hi', style: { font: 'Nonexistent Sans Display' } },
        },
      ],
    });
    expect(refused.structured).toMatchObject({ code: 'bad_request' });
    expect(String(refused.structured.message)).toMatch(
      /"Nonexistent Sans Display" is not installed/,
    );
    expect(String(refused.structured.hint)).toMatch(/video:\/\/catalog\/fonts/);
    const real = fonts[0] as string;
    const kept = await call(client, 'title.add', {
      timeline_id,
      track_id: 't1',
      text: 'Hi',
      style: { font: real.toLowerCase() },
      preview: 'none',
    });
    expect(kept.isError).toBe(false);
  });
});

describe('what results and errors say back', () => {
  /** A ready video record of a given size, written as an import leaves it (no engines). */
  const fakeVideo = async (owner: string, id: string, width: number, height: number) => {
    const dir = env.runtime.media.dir(owner, id);
    const now = new Date().toISOString();
    await env.runtime.ws.writeJson(`${dir}/media.json`, {
      media_id: id,
      name: `${id}.mp4`,
      status: 'ready',
      source: { path: '/media/clip.mp4' },
      file: `${dir}/source.mp4`,
      size: 1,
      fingerprint: null,
      probe: {
        format: 'mov,mp4,m4a,3gp,3g2,mj2',
        kind: 'video',
        duration: 4,
        video: {
          codec: 'h264',
          width,
          height,
          fps: { num: 25, den: 1 },
          vfr: false,
          rotation: 0,
          transfer: null,
          primaries: null,
          pix_fmt: 'yuv420p',
          frames: 100,
        },
        audio: { codec: 'aac', sample_rate: 48000, channels: 2 },
      },
      conform: [],
      mezzanine: null,
      proxy: null,
      analysis: null,
      created_at: now,
      updated_at: now,
    });
    return id;
  };

  it("lists every effect name, and an effect's params with ranges, units and defaults", async () => {
    const client = await connect(env.runtime, 'names');
    const media = await fakeVideo('names', 'm_aaaaaaaaaaaaaaaaaaaaaaaana', 1280, 720);
    const { timeline_id: t0 } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      sequence: SEQ_720P25,
    });
    const { timeline_id: t1, clip_id } = await ok<{ timeline_id: string; clip_id: string }>(
      client,
      'clip.add',
      { timeline_id: t0, track_id: 't1', media_id: media, preview: 'none' },
    );
    const unknown = await call(client, 'filter.add', {
      timeline_id: t1,
      clip_id,
      name: 'delogo',
      preview: 'none',
    });
    expect(unknown.isError).toBe(true);
    const said = JSON.stringify(unknown.content);
    for (const name of ['brightness_contrast', 'chroma_key', 'pitch', 'telephone']) {
      expect(said).toContain(name);
    }
    const param = await call(client, 'filter.add', {
      timeline_id: t1,
      clip_id,
      name: 'chroma_key',
      params: { tolerance: 3 },
      preview: 'none',
    });
    expect(param.structured).toMatchObject({ code: 'bad_request' });
    expect(String(param.structured.hint)).toMatch(
      /^chroma_key \(video\) takes color: #RRGGBB, default #00FF00/,
    );
    expect(String(param.structured.hint)).toContain('tolerance: 0 to 1, default 0.2');
    const ease = await call(client, 'clip.set_transform', {
      timeline_id: t1,
      clip_id,
      x: { keyframes: [{ frame: 0, value: 0.4, ease: 'ease_in_out' }] },
      preview: 'none',
    });
    expect(ease.isError).toBe(true);
    expect(JSON.stringify(ease.content)).toContain('bounce_in_out');
    // timeline.get shows what the effect applies, defaults included.
    const { timeline_id: t2 } = await ok<{ timeline_id: string }>(client, 'filter.add', {
      timeline_id: t1,
      clip_id,
      name: 'chroma_key',
      params: { tolerance: 0.3 },
      preview: 'none',
    });
    const view = await ok<{ tracks: Array<{ clips: Array<{ effects?: unknown[] }> }> }>(
      client,
      'timeline.get',
      { timeline_id: t2 },
    );
    expect(view.tracks[0]?.clips[0]?.effects?.[0]).toMatchObject({
      name: 'chroma_key',
      params: { color: '#00FF00', tolerance: 0.3 },
    });
  });

  it('says when a range takes the sound too, and which clips each track lost', async () => {
    const client = await connect(env.runtime, 'ranges');
    const media = await fakeVideo('ranges', 'm_aaaaaaaaaaaaaaaaaaaaaaaara', 1280, 720);
    const { timeline_id: t0 } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      sequence: SEQ_720P25,
    });
    const added = await ok<{ timeline_id: string; clip_ids: string[] }>(client, 'clip.add', {
      timeline_id: t0,
      track_id: 't1',
      media_id: media,
      source: { in: 0, out: 40 },
      preview: 'none',
    });
    const cut = await ok<{
      changed: Array<{ id: string; change: string; track_id?: string }>;
      warnings: string[];
    }>(client, 'range.extract', {
      timeline_id: added.timeline_id,
      range: { start: 0, end: 40 },
      preview: 'none',
    });
    expect(cut.changed.filter((c) => c.change === 'removed')).toEqual(
      expect.arrayContaining([
        { id: added.clip_ids[0], type: 'clip', change: 'removed', track_id: 't1' },
        { id: added.clip_ids[1], type: 'clip', change: 'removed', track_id: 't2' },
      ]),
    );
    expect(cut.warnings.join('\n')).toMatch(
      /The sound in frames 0–40 went with the picture, from A1 \(t2: /,
    );
    // Naming the picture track alone leaves the sound and says nothing about it.
    const picture = await ok<{ warnings: string[] }>(client, 'range.lift', {
      timeline_id: added.timeline_id,
      range: { start: 0, end: 40 },
      track_ids: ['t1'],
      preview: 'none',
    });
    expect(picture.warnings).toEqual([]);
  });

  it('warns how many clips no longer fill the frame after a sequence change', async () => {
    const client = await connect(env.runtime, 'reshape');
    const wide = await fakeVideo('reshape', 'm_aaaaaaaaaaaaaaaaaaaaaaaawd', 1920, 1080);
    const { timeline_id: t0 } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      sequence: SEQ_720P25,
    });
    const { timeline_id: t1, clip_id } = await ok<{ timeline_id: string; clip_id: string }>(
      client,
      'clip.add',
      { timeline_id: t0, track_id: 't1', media_id: wide, preview: 'none' },
    );
    const vertical = await ok<{ timeline_id: string; warnings: string[] }>(
      client,
      'timeline.set_sequence',
      { timeline_id: t1, sequence: { ...SEQ_720P25, width: 720, height: 1280 }, preview: 'none' },
    );
    expect(vertical.warnings).toEqual([
      `1 clip filled the old 1280x720 frame and no longer fills the new 720x1280 one, showing bars: ${clip_id}. clip.set_transform {fit: "cover"} fills the frame, cropping`,
    ]);
    const { timeline_id: covered } = await ok<{ timeline_id: string }>(
      client,
      'clip.set_transform',
      { timeline_id: t1, clip_id, fit: 'cover', preview: 'none' },
    );
    const fine = await ok<{ warnings: string[] }>(client, 'timeline.set_sequence', {
      timeline_id: covered,
      sequence: { ...SEQ_720P25, width: 720, height: 1280 },
      preview: 'none',
    });
    expect(fine.warnings).toEqual([]);
  });

  it('says when an included analysis was never run', async () => {
    const client = await connect(env.runtime, 'unrun');
    const media = await fakeVideo('unrun', 'm_aaaaaaaaaaaaaaaaaaaaaaaaun', 1280, 720);
    const got = await ok<{ warnings?: string[]; speech?: unknown }>(client, 'media.get', {
      media_id: media,
      include: ['speech'],
    });
    expect(got.speech).toBeUndefined();
    expect(got.warnings?.[0]).toMatch(/^include speech: none stored for this media/);
  });

  it('refuses a motion render over budget with the largest size that fits', async () => {
    const client = await connect(env.runtime, 'budget');
    const res = await call(client, 'create.motion', {
      html: '<b>x</b>',
      width: 1920,
      height: 1080,
      fps: 30,
      duration_seconds: 45,
    });
    expect(res.structured).toMatchObject({
      code: 'limit_exceeded',
      detail: { largest_width: 1566, largest_height: 880, longest_seconds: 30 },
    });
    expect(String(res.structured.hint)).toMatch(/largest of this shape that fits is 1566x880/);
  });

  it('warns that referenced media stays on this server and goes after a while', async () => {
    const client = await connect(env.runtime, 'handoff');
    const media = await fakeVideo('handoff', 'm_aaaaaaaaaaaaaaaaaaaaaaaaho', 1280, 720);
    const { timeline_id: t0 } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      sequence: SEQ_720P25,
    });
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'clip.add', {
      timeline_id: t0,
      track_id: 't1',
      media_id: media,
      preview: 'none',
    });
    const started = await ok<{ job_id: string }>(client, 'export.timeline', {
      timeline_id,
      format: 'otio',
    });
    const done = await settled<{ result: { warnings: string[] } }>(client, started.job_id);
    expect(done.status).toBe('completed');
    expect(done.result.warnings.join('\n')).toMatch(
      /media reference: the file points at 1 media where this server keeps them .* 7 days after last use.* media: collect/,
    );
  });
});

describe('a busy or restarting sandbox', () => {
  it('fails create.still with a retryable server_busy, and names docker only locally', async () => {
    const down = await testRuntime({ motionUrl: 'http://127.0.0.1:9' });
    for (const mode of ['local', 'hosted']) {
      const before = process.env.CUTTINGFLOOR_MODE;
      process.env.CUTTINGFLOOR_MODE = mode;
      try {
        const client = await connect(down.runtime, `busy-${mode}`);
        const started = await ok<{ job_id: string }>(client, 'create.still', {
          html: `<b>${mode}</b>`,
        });
        const view = await settled<{ error: { code: string; hint: string } }>(
          client,
          started.job_id,
        );
        expect(view).toMatchObject({ status: 'failed', error: { code: 'server_busy' } });
        expect(view.error.hint).toMatch(/again in about a minute/);
        if (mode === 'local') expect(view.error.hint).toMatch(/docker compose ps/);
        else expect(view.error.hint).not.toMatch(/docker/i);
      } finally {
        if (before === undefined) delete process.env.CUTTINGFLOOR_MODE;
        else process.env.CUTTINGFLOOR_MODE = before;
      }
    }
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
