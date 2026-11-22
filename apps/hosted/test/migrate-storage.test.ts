import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  type CollectionSpec,
  definedCollections,
  MongoRecords,
  randomId,
} from '@cuttingfloor/core';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import type { AccountGetResult } from '@cuttingfloor/schema';
import {
  createServer,
  MIGRATION,
  Runtime,
  type RuntimeConfig,
  readCalls,
  urlKeyFingerprint,
} from '@cuttingfloor/server';
import {
  EXIT,
  fsTarget,
  type MigrateOptions,
  type MigrateSummary,
  type MigrationTarget,
  migrate,
  s3Target,
} from '@cuttingfloor/server/migrate';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN_KEYS } from '../src/admin-api.ts';
import { hostedCollections } from '../src/collections.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { MONGO_TEST_TIMEOUT_MS, mongoReachable, TEST_MONGODB_URI, testDatabase } from './mongo.ts';
import { makeBucket, s3Reachable, testS3 } from './s3.ts';

// The storage migration, end to end: a data root made by the real runtime through the SDK
// client is moved into a second data root (records beside the files, and, when a MongoDB
// answers, in MongoDB), and a runtime started on the target answers as the source did. Engines
// are a stand-in that never finishes, so this runs the same with or without FFmpeg: what an
// engine would have written (a media's files, an export) is laid down through the runtime's own
// stores.

const fake = await vi.hoisted(async () => {
  const { chmodSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const dir = mkdtempSync(joinPath(tmp(), 'cf-fake-engine-'));
  const script = joinPath(dir, 'engine.sh');
  writeFileSync(script, '#!/bin/sh\n# A stand-in engine that never finishes.\nexec sleep 600\n');
  chmodSync(script, 0o755);
  const names = ['CUTTINGFLOOR_MELT', 'CUTTINGFLOOR_FFMPEG', 'CUTTINGFLOOR_FFPROBE'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  for (const name of names) process.env[name] = script;
  return { saved, dir };
});

const up = await mongoReachable();
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const ACCOUNT: AccountGetResult = {
  plan: 'free',
  plan_name: 'Free',
  credits: { left: 42, used: 18, free: 60, bought: 0, per_month: null, renews: null },
  warnings: [],
  top_up: null,
  packs: [],
  limits: { export_short_side: null, storage_gb: null },
  account_url: null,
};
const OWNER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
const OTHER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ02';
const SEQ = { width: 1280, height: 720, fps: { num: 25, den: 1 } };
const DAY = 86_400_000;
/** Small enough that a few KB of upload is several parts. */
const PART = 1024;

const config = (dataDir: string, more: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  dataDir,
  mode: 'hosted',
  publicUrl: 'http://127.0.0.1:8787',
  mediaRoots: [],
  exportsDir: null,
  maxJobs: 2,
  shortJobs: 0,
  outputUrlTtlMs: 7 * DAY,
  maxDownloadBytes: 1024 ** 3,
  allowPrivateUrls: true,
  inlineMaxBytes: 32 * 1024 ** 2,
  motionUrl: null,
  node: 'old',
  ...more,
});

async function connect(runtime: Runtime, owner: string): Promise<Client> {
  const server = createServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => owner,
    account: async () => ACCOUNT,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'migration', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; structured: T }> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: T;
  };
  return { isError: Boolean(res.isError), structured: (res.structuredContent ?? {}) as T };
}

async function ok<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await call<T>(client, name, args);
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.structured)}`);
  return res.structured;
}

async function until(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const spec = (name: string, kind?: string) => {
  const found = definedCollections().find((s) => s.name === name && s.kind === kind);
  if (!found) throw new Error(`No collection ${name}`);
  return found as CollectionSpec<Record<string, unknown>>;
};

/** Every file and folder under `dir` with its mtime, by path. */
async function mtimes(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name);
    out[path.slice(dir.length)] = (await lstat(path)).mtimeMs;
  }
  return out;
}

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (seed: string, n: number) => Buffer.alloc(n, seed);

interface Seeded {
  dir: string;
  root: string;
  runtime: Runtime;
  client: Client;
  secret: string;
  timeline: string;
  /** A job that finished with an output and a signed link in its result. */
  exported: string;
  cancelled: string;
  mediaA: string;
  mediaB: string;
  frames: string;
  whole: string;
  partway: string;
  scriptKey: string;
  expiredTimeline: string;
  expiredMedia: string;
}

/** A source data root with one of everything, made by the runtime as a server would. */
async function seed(): Promise<Seeded> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-migrate-src-'));
  const root = join(dir, 'data');
  const runtime = new Runtime(config(root));
  await runtime.start({ sweep: false });
  const { ws, media } = runtime;
  hostedCollections(ws);
  const client = await connect(runtime, OWNER);

  // Credits claimed (the claim and the sample's record), and its import stopped.
  const claim = await ok<{ job_id?: string }>(client, 'credits.claim', { use_case: 'shorts' });
  if (claim.job_id) await call(client, 'job.cancel', { job_id: claim.job_id });

  // A timeline and an edit of it; an interchange export that finishes; a render that is cancelled.
  const made = await ok<{ timeline_id: string }>(client, 'timeline.create', {
    name: 'Cut',
    sequence: SEQ,
  });
  const { timeline_id: timeline } = await ok<{ timeline_id: string }>(client, 'title.add', {
    timeline_id: made.timeline_id,
    track_id: 't1',
    text: 'One second',
    duration_frames: 25,
    preview: 'none',
  });
  const exporting = await ok<{ job_id: string }>(client, 'export.timeline', {
    timeline_id: timeline,
    format: 'otio',
  });
  await until(
    async () =>
      (await ok<{ status: string }>(client, 'job.get', { job_id: exporting.job_id })).status !==
      'working',
  );
  const render = await ok<{ job_id: string }>(client, 'export.video', {
    timeline_id: timeline,
    preset: 'mp4_h264_fast',
    idempotency_key: 'render-1',
  });
  await ok(client, 'job.cancel', { job_id: render.job_id });
  // As another server asks it: a cancel kept beside the job.
  await runtime.jobs.store.requestCancel(OWNER, render.job_id);
  await until(
    async () =>
      (await ok<{ status: string }>(client, 'job.get', { job_id: render.job_id })).status !==
      'working',
  );

  // A media with its files, analyses (a transcript and a look run) and derived files.
  const a = await media.create(OWNER, { url: 'https://example.com/a.mp4' }, 'a.mp4');
  const files = { file: 'source.mp4', mezzanine: 'mezzanine.mov', proxy: 'proxy.mp4' } as const;
  for (const [field, name] of Object.entries(files)) {
    const key = ws.blobs.keys.media(OWNER, a.media_id, name);
    await ws.blobs.put(key, { bytes: bytesOf(field, 3000 + name.length) });
    (a as unknown as Record<string, unknown>)[field] = key;
  }
  a.status = 'ready';
  a.fingerprint = 'fp-a';
  a.size = 3010;
  await media.save(OWNER, a);
  await ws.records.collection(spec('media_index'), { owner: OWNER }).put('fp-a', {
    media_id: a.media_id,
  });
  await media.saveAnalysis(OWNER, a.media_id, 'transcript', {
    model: 'tiny',
    language: 'en',
    text: 'hello',
    words: [{ text: 'hello', start: 0, end: 0.5, confidence: 0.9 }],
  });
  await media.saveAnalysis(OWNER, a.media_id, 'look', {
    id: 'r1',
    frames: [],
    questions: {},
  } as never);
  await ws.blobs.put(ws.blobs.keys.derived(OWNER, a.media_id, 'cleaned', 'voice.wav'), {
    bytes: bytesOf('c', 2222),
  });
  await ws.blobs.put(ws.blobs.keys.derived(OWNER, a.media_id, 'search', 'index.bin'), {
    bytes: bytesOf('s', 1500),
  });
  await media.writeDerived(OWNER, a.media_id, '{"error":"no frames"}', 'search', 'failed.json');

  // The same bytes imported again: the second media shares the first one's files.
  const b = await media.create(OWNER, { url: 'https://example.com/a-again.mp4' }, 'again.mp4');
  for (const [field, name] of Object.entries(files)) {
    (b as unknown as Record<string, unknown>)[field] = await ws.blobs.share(
      ws.blobs.keys.media(OWNER, a.media_id, name),
      ws.blobs.keys.media(OWNER, b.media_id, name),
    );
  }
  b.status = 'ready';
  b.fingerprint = 'fp-a';
  b.size = 3010;
  await media.save(OWNER, b);

  // Frames kept for download, and an email that carried their link.
  const frames = randomId('f_');
  await runtime.outputs.write(OWNER, frames, 'frame-000001.png', bytesOf('f', 4096), 'frames');
  const link = await runtime.signOutput(OWNER, frames, 'frame-000001.png');
  const day = new Date().toISOString().slice(0, 10);
  await ws.records.collection(spec('email_log'), { parent: day }).put('send-1', {
    subscriber: OWNER,
    text: `Your frames: ${link.url}`,
  });

  // An upload sent whole, and one that stopped part way (three and a half parts).
  const whole = await ok<{ upload_id: string }>(client, 'media.upload', { name: 'Beach.mov' });
  await runtime.uploads.receive(OWNER, whole.upload_id, Readable.from([bytesOf('w', 5000)]), {
    length: 5000,
    range: null,
  });
  const partway = await ok<{ upload_id: string }>(client, 'media.upload', { name: 'Long.mov' });
  const sent = Math.floor(PART * 3.5);
  await runtime.uploads.receive(OWNER, partway.upload_id, Readable.from([bytesOf('p', sent)]), {
    length: sent,
    range: { start: 0, total: 20_000 },
  });

  // Keys, a meter entry, a notice sent, a support message, and the deployment's own records.
  const keys = new ScriptKeys(ws);
  const scriptKey = (await keys.create(OWNER, 'render box')).key;
  await new ScriptKeys(ws, ADMIN_KEYS).create(OTHER, 'admin');
  await runtime.meterJudgments(OWNER, 'q_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'judge.ask', 5);
  const at = new Date().toISOString();
  await ws.records.collection(spec('notices'), { owner: OWNER }).insertOnce('welcome', { at });
  await ok(client, 'support.contact', { message: 'hello there' });
  await ws.records.collection(spec('rights')).put(OTHER, { user: OTHER, roles: [], grants: [] });
  await ws.records.collection(spec('partners'), { parent: 'kazi' }).put(sha('sub'), {
    owner: OWNER,
  });
  await ws.records.collection(spec('funnel'), { parent: day }).put('step-1', { step: 'visit' });
  await ws.records.collection(spec('email_suppressions')).put(sha('x@example.com'), {
    reason: 'bounced',
  });
  await ws.records.collection(spec('email_slots'), { owner: OWNER }).put('welcome', { at });
  await ws.records.collection(spec('email_unsubscribed'), { owner: OWNER }).put('unsubscribed', {
    at,
  });
  await ws.records.collection(spec('ledger_links'), { owner: OWNER }).put('link', {
    since: at,
    used_before: 0,
  });
  await ws.records.collection(spec('account_apps'), { owner: OWNER }).put('apps', [] as never);
  await until(async () => (await readCalls(ws, OWNER)).some((c) => c.tool === 'support.contact'));

  // Past their time: a timeline and a media nobody used for eight days.
  const old = new Date(Date.now() - 8 * DAY);
  const expiredTimeline = `tl_${'e'.repeat(32)}`;
  await ws.records.collection(spec('timelines'), { owner: OWNER }).put(expiredTimeline, {
    old: true,
  });
  await utimes(ws.ownerDir(OWNER, 'timelines', `${expiredTimeline}.json`), old, old);
  const gone = await media.create(OWNER, { url: 'https://example.com/old.mp4' }, 'old.mp4');
  const goneKey = ws.blobs.keys.media(OWNER, gone.media_id, 'source.mp4');
  await ws.blobs.put(goneKey, { bytes: bytesOf('o', 999) });
  gone.file = goneKey;
  await media.save(OWNER, gone);
  await utimes(join(media.dir(OWNER, gone.media_id), 'media.json'), old, old);

  // What stays behind: models, cached frames, a legacy count, a file half written.
  await mkdir(join(root, 'models'), { recursive: true });
  await writeFile(join(root, 'models', 'whisper.bin'), 'model');
  await ws.blobs.put(ws.blobs.keys.cache('frames', 'x.png'), { bytes: bytesOf('x', 10) });
  await ws.records.collection(spec('usage'), { owner: OWNER }).put('2026-01', { n: 1 });
  await writeFile(join(media.dir(OWNER, a.media_id), `proxy.mp4.${process.pid}.tmp`), 'half');

  const secret = (JSON.parse(await readFile(join(root, 'secret.key'), 'utf8')) as { key: string })
    .key;
  return {
    dir,
    root,
    runtime,
    client,
    secret,
    timeline,
    exported: exporting.job_id,
    cancelled: render.job_id,
    mediaA: a.media_id,
    mediaB: b.media_id,
    frames,
    whole: whole.upload_id,
    partway: partway.upload_id,
    scriptKey,
    expiredTimeline,
    expiredMedia: gone.media_id,
  };
}

interface Target {
  dir: string;
  root: string;
  state: string;
  target: MigrationTarget;
  /** A runtime on the target, as the new server would start. */
  runtime(secret: string): Promise<Runtime>;
  drop(): Promise<void>;
}

async function makeTarget(store: 'filesystem' | 'MongoDB'): Promise<Target> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-migrate-dst-'));
  const root = join(dir, 'data');
  const db = testDatabase();
  const mongo =
    store === 'MongoDB' ? new MongoRecords({ uri: TEST_MONGODB_URI, db, node: 'm' }) : undefined;
  const target = fsTarget(root, mongo, mongo ? `mongo:${db}` : undefined);
  const started: Runtime[] = [];
  return {
    dir,
    root,
    state: join(dir, 'state'),
    target,
    runtime: async (secret) => {
      const runtime = new Runtime(
        config(root, {
          node: 'new',
          urlSecret: secret,
          // As the new server runs until the cutover: in standby, so passes may still write.
          standby: true,
          ...(mongo ? { records: { store: 'mongo', uri: TEST_MONGODB_URI, db } } : {}),
        }),
      );
      await runtime.start({ sweep: false });
      started.push(runtime);
      return runtime;
    },
    drop: async () => {
      for (const runtime of started) await runtime.close();
      if (mongo) {
        await mongo.idle();
        await (await mongo.database()).dropDatabase();
      }
      await target.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const lines: string[] = [];
const run = async (source: Seeded, to: Target, more: Partial<MigrateOptions> = {}) => {
  const summary = await migrate({
    source: source.root,
    target: to.target,
    stateDir: to.state,
    specs: hostedCollections(source.runtime.ws),
    settleMs: 0,
    partBytes: PART,
    log: (line) => lines.push(line),
    ...more,
  });
  if (process.env.CF_MIGRATE_DEBUG) {
    console.log(
      summary.exit,
      JSON.stringify(summary.verify?.differences),
      JSON.stringify(summary.waiting),
      JSON.stringify(summary.failed),
    );
  }
  return summary;
};

const written = (summary: MigrateSummary) =>
  Object.values(summary.records).reduce((n, c) => n + (c.written ?? 0), 0) +
  Object.values(summary.blobs).reduce(
    (n, c) => n + (c.copied ?? 0) + (c.shared ?? 0) + (c.carried ?? 0),
    0,
  ) +
  (summary.logs.parts_written ?? 0);

afterAll(async () => {
  for (const [k, v] of Object.entries(fake.saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(fake.dir, { recursive: true, force: true });
});

describe.each((['filesystem', 'MongoDB'] as const).filter((store) => store === 'filesystem' || up))(
  'moving a data root, records to %s',
  (store) => {
    let src: Seeded;
    let dst: Target;
    let first: MigrateSummary;
    let before: Record<string, number>;

    beforeAll(async () => {
      src = await seed();
      dst = await makeTarget(store);
      before = await mtimes(src.root);
      first = await run(src, dst);
    });

    afterAll(async () => {
      src?.runtime.stop();
      await src?.runtime.close();
      await dst?.drop();
      if (src) await rm(src.dir, { recursive: true, force: true });
    });

    it('moves everything, verifies it, and leaves the source as it was', async () => {
      expect(first.verify?.differences).toEqual([]);
      expect(first.waiting).toEqual([]);
      expect(first.exit).toBe('ok');
      expect(await mtimes(src.root)).toEqual(before);
      // Every collection that had a record at the source has as many at the target.
      const counts = first.verify?.records ?? {};
      for (const name of [
        'timelines',
        'media',
        'media_index',
        'jobs',
        'job_cancels',
        'job_keys',
        'uploads',
        'outputs',
        'floor',
        'account_claims',
        'meter',
        'notices',
        'support_messages',
        'keys',
        'keys_listed',
        'admin_keys',
        'admin_keys_listed',
        'rights',
        'partners',
        'funnel',
        'email_log',
        'email_slots',
        'email_unsubscribed',
        'email_suppressions',
        'ledger_links',
        'account_apps',
      ]) {
        expect(counts[name]?.source, name).toBeGreaterThan(0);
        expect(counts[name]?.same, name).toBe(counts[name]?.source);
        expect(counts[name]?.target, name).toBe(counts[name]?.source);
      }
      expect(first.verify?.logs.source_entries).toBeGreaterThan(3);
      expect(first.verify?.logs.target_entries).toBe(first.verify?.logs.source_entries);
      expect(Object.keys(first.blobs).sort()).toEqual(
        expect.arrayContaining([
          'media:analysis',
          'media:cleaned',
          'media:own',
          'media:search',
          'output:frames',
          'output:timeline',
          'upload',
          'upload:part-way',
        ]),
      );
      expect(first.verify?.links).toMatchObject({ broken: 0 });
      expect(first.verify?.links.checked).toBeGreaterThan(0);
      // What is deliberately left: named, with why.
      expect(first.not_moved.whole.map((w) => w.path).sort()).toEqual([
        'cache',
        'models',
        'secret.key',
      ]);
      expect(first.not_moved.expired).toMatchObject({
        timelines: { files: 1 },
        media: { files: 1 },
        'media:own': { files: 1 },
      });
      expect(Object.keys(first.not_moved.files).join(' ')).toMatch(/legacy/);
      expect(first.not_moved.files['being written']).toMatchObject({ files: 1 });
      // Nothing printed names an owner, a key or an address.
      const printed = `${lines.join('\n')}\n${await readFile(first.files.summary, 'utf8')}`;
      expect(printed).not.toContain(OWNER);
      expect(printed).not.toContain(src.scriptKey);
      expect(printed).not.toContain('hello there');
      expect(printed).not.toContain('sig=');
    });

    it('stores shared bytes once, with the same stored bytes for the owner', async () => {
      const { blobs } = dst.target;
      const a = await blobs.head(blobs.keys.media(OWNER, src.mediaA, 'source.mp4'));
      const b = await blobs.head(blobs.keys.media(OWNER, src.mediaB, 'source.mp4'));
      expect(a?.refs).toBe(2);
      expect(b?.refs).toBe(2);
      const row = first.verify?.owners.find((o) => o.expected > 0);
      expect(row?.target).toBe(row?.expected);
      // Three files of 3,000-odd bytes, once, not twice.
      const shared = 3 * 3000 + 'source.mp4mezzanine.movproxy.mp4'.length;
      expect(row?.expected).toBeLessThan(
        (await src.runtime.ws.blobs.usage(OWNER)) - 999 - 'half'.length,
      );
      expect(row?.expected).toBeGreaterThan(shared);
    });

    it('carries a part-way upload’s whole parts, and the sender resumes from there', async () => {
      const runtime = await dst.runtime(src.secret);
      const state = await runtime.uploads.state(OWNER, src.partway);
      expect(state).toEqual({ upload_id: src.partway, received: 3 * PART, complete: false });
      const record = (await runtime.ws.records
        .collection(spec('uploads'), { owner: OWNER })
        .get(src.partway)) as { offset: number; multipart: { parts: unknown[] } };
      expect(record.offset).toBe(3 * PART);
      expect(record.multipart.parts).toHaveLength(3);
      // The sender is told where to carry on, and does.
      const rest = 20_000 - 3 * PART;
      const done = await runtime.uploads.receive(
        OWNER,
        src.partway,
        Readable.from([bytesOf('p', rest)]),
        { length: rest, range: { start: 3 * PART, total: 20_000 } },
      );
      expect(done).toMatchObject({ received: 20_000, complete: true });
    });

    it('a runtime on the target answers as the source does', async () => {
      const runtime = await dst.runtime(src.secret);
      const there = await connect(runtime, OWNER);
      const strip = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value)
            .replace(/exp=\d+&sig=[A-Za-z0-9_-]+/g, 'signed')
            .replace(/"(expires_at|url_expires_at|expiresAt|kept_until)":"[^"]+"/g, '"$1":"…"'),
        );
      type Listed = { media: Array<{ media_id: string; expires_at: string }>; uploads: unknown[] };
      const here = await ok<Listed>(src.client, 'media.list', {});
      const moved = await ok<Listed>(there, 'media.list', {});
      // All but the one past its time, which the source has yet to sweep.
      expect(moved.media.map((m) => m.media_id).sort()).toEqual(
        here.media
          .map((m) => m.media_id)
          .filter((id) => id !== src.expiredMedia)
          .sort(),
      );
      // Nothing got a fresh seven days: each media expires when it did at the source.
      for (const m of moved.media) {
        const was = here.media.find((h) => h.media_id === m.media_id);
        expect(Math.abs(Date.parse(m.expires_at) - Date.parse(was?.expires_at ?? ''))).toBeLessThan(
          5,
        );
      }
      expect(moved.media.map((m) => m.media_id)).not.toContain(src.expiredMedia);
      for (const [tool, args] of [
        ['timeline.get', { timeline_id: src.timeline }],
        ['job.get', { job_id: src.exported }],
        ['job.get', { job_id: src.cancelled }],
        ['media.get', { media_id: src.mediaA }],
      ] as const) {
        expect(strip(await ok(there, tool, args)), tool).toEqual(
          strip(await ok(src.client, tool, args)),
        );
      }
      // The expired timeline was not moved.
      const gone = await call(there, 'timeline.get', { timeline_id: src.expiredTimeline });
      expect(gone.isError).toBe(true);
      // Analyses came with the media.
      expect((await runtime.media.find(OWNER, src.mediaA))?.analyses).toMatchObject({
        transcript: { text: 'hello' },
        look: { runs: [{ id: 'r1' }] },
      });
      // A link the old server handed out downloads the same bytes from the new one.
      const job = await ok<{ result: { url: string } }>(src.client, 'job.get', {
        job_id: src.exported,
      });
      const frames = await src.runtime.signOutput(OWNER, src.frames, 'frame-000001.png');
      for (const link of [job.result.url, frames.url]) {
        const url = new URL(link);
        const args = [url.pathname, url.searchParams.get('exp'), url.searchParams.get('sig')];
        const [old, fresh] = await Promise.all([
          src.runtime.verifyOutput(...(args as [string, string, string])),
          runtime.verifyOutput(...(args as [string, string, string])),
        ]);
        expect(fresh).toBeDefined();
        expect(fresh).not.toBe(old);
        expect(sha(await readFile(fresh as string))).toBe(sha(await readFile(old as string)));
      }
      // The script key still names its owner, and the call log came across.
      expect(await new ScriptKeys(runtime.ws).owner(src.scriptKey)).toBe(OWNER);
      expect((await readCalls(runtime.ws, OWNER)).map((c) => c.tool)).toEqual(
        expect.arrayContaining(['timeline.create', 'support.contact']),
      );
    });
  },
);

describe.each((['filesystem', 'MongoDB'] as const).filter((store) => store === 'filesystem' || up))(
  'passes over a live source, records to %s',
  (store) => {
    let src: Seeded;
    let dst: Target;

    beforeAll(async () => {
      src = await seed();
      dst = await makeTarget(store);
    });

    afterAll(async () => {
      src?.runtime.stop();
      await src?.runtime.close();
      await dst?.drop();
      if (src) await rm(src.dir, { recursive: true, force: true });
    });

    it('a dry run says what a pass would do and touches nothing', async () => {
      const dry = await run(src, dst, { mode: 'dry-run' });
      expect(dry.exit).toBe('ok');
      expect(dry.blobs['media:own']).toMatchObject({ to_copy: 4, to_share: 3 });
      expect(dry.blobs['upload:part-way']).toMatchObject({ to_carry: 1 });
      expect(dry.records.timelines?.to_write).toBeGreaterThan(0);
      expect(await readdir(dst.root).catch(() => [])).toEqual([]);
      expect(await readdir(dst.state)).toEqual(['summary-dry-run.json']);
      expect(await dst.target.records.owners()).toEqual([]);
    });

    it('an interrupted pass is finished by the next, and a third changes nothing', async () => {
      const cut = await run(src, dst, { abortAfter: 7 });
      expect(cut.exit_code).toBe(EXIT.interrupted);
      const again = await run(src, dst);
      expect(again.exit).toBe('ok');
      expect(written(again)).toBeGreaterThan(0);
      const stamps = await mtimes(dst.root);
      const third = await run(src, dst);
      expect(third.exit).toBe('ok');
      expect(written(third)).toBe(0);
      expect(third.deletes.planned).toBe(0);
      expect(await mtimes(dst.root)).toEqual(stamps);
    });

    it('with its manifest lost, a pass finds everything already there', async () => {
      await rm(join(dst.state, 'manifest.json'));
      const stamps = await mtimes(dst.root);
      const found = await run(src, dst);
      expect(found.exit).toBe('ok');
      // Only the part-way upload, whose parts no store lists, and the log parts are sent again.
      expect(written(found) - (found.logs.parts_written ?? 0)).toBe(1);
      expect(found.blobs['upload:part-way']).toMatchObject({ carried: 1 });
      expect(found.blobs['media:own']).toMatchObject({ found_at_target: 4 });
      const now = await mtimes(dst.root);
      for (const [path, at] of Object.entries(stamps)) {
        if (!/\/(uploads|calls)(\/|$)/.test(path)) expect(now[path], path).toBe(at);
      }
    });

    it('what changed, came or went at the source does so at the target', async () => {
      const { ws, media } = src.runtime;
      // Changed: a media renamed. Added: a timeline. Deleted: the second media.
      const record = await media.get(OWNER, src.mediaA);
      await media.save(OWNER, { ...record, name: 'renamed.mp4' });
      const added = await ok<{ timeline_id: string }>(src.client, 'timeline.create', {
        name: 'Later',
        sequence: SEQ,
      });
      await ok(src.client, 'media.delete', { media_id: src.mediaB });
      const pass = await run(src, dst);
      expect(pass.exit).toBe('ok');
      expect(pass.deletes.done).toBeGreaterThanOrEqual(4);
      const runtime = await dst.runtime(src.secret);
      expect((await runtime.media.find(OWNER, src.mediaA))?.name).toBe('renamed.mp4');
      expect(await runtime.media.find(OWNER, src.mediaB)).toBeUndefined();
      expect(
        await runtime.ws.records
          .collection(spec('timelines'), { owner: OWNER })
          .has(added.timeline_id),
      ).toBe(true);
      const { blobs } = dst.target;
      expect(await blobs.head(blobs.keys.media(OWNER, src.mediaB, 'source.mp4'))).toBeUndefined();
      // The first media's own file is whole, and no longer shared.
      const kept = await blobs.head(blobs.keys.media(OWNER, src.mediaA, 'source.mp4'));
      expect(kept).toMatchObject({ refs: 1, bytes: 3010 });
      // Why the media went came across too.
      expect(
        await runtime.ws.records
          .collection(spec('gone', 'media'), { owner: OWNER })
          .has(src.mediaB),
      ).toBe(true);
      expect(await ws.records.owners()).toContain(OWNER);
    });

    it('refuses to remove a great deal from the target unless told to', async () => {
      const { ws } = src.runtime;
      // Another account stays, so the source is still a data root with accounts in it.
      await ws.records
        .collection(spec('timelines'), { owner: OTHER })
        .put(`tl_${'7'.repeat(32)}`, { kept: true });
      await ws.blobs.deletePrefix(ws.blobs.keys.owner(OWNER));
      await ws.records.forget(OWNER);
      // So much less than last time is refused outright, before anything is weighed.
      const shrunk = await run(src, dst);
      expect(shrunk.exit_code).toBe(EXIT.refused);
      expect(shrunk.refused?.why).toMatch(/at the last pass/);
      const refused = await run(src, dst, { allowShrink: true });
      expect(refused.exit_code).toBe(EXIT.deletesRefused);
      expect(refused.deletes).toMatchObject({ refused: true, done: 0 });
      expect(await dst.target.records.owners()).toContain(OWNER);
      // A count too small is refused too; one that covers it goes through.
      const few = await run(src, dst, { allowShrink: true, allowDeletes: 3 });
      expect(few.exit_code).toBe(EXIT.deletesRefused);
      const allowed = await run(src, dst, { allowShrink: true, allowDeletes: 10_000 });
      expect(allowed.exit).toBe('ok');
      expect(await dst.target.records.owners()).not.toContain(OWNER);
      expect(await dst.target.blobs.list(dst.target.blobs.keys.owner(OWNER))).toEqual([]);
    });

    it('fails, naming it, on a folder it does not know, and on a path import', async () => {
      await mkdir(join(src.root, 'mystery'), { recursive: true });
      await writeFile(join(src.root, 'mystery', 'thing.bin'), 'x');
      const stamps = await mtimes(dst.root);
      lines.length = 0;
      const refused = await run(src, dst);
      expect(refused.exit_code).toBe(EXIT.refused);
      expect(refused.refused?.unknown).toEqual([
        { path: 'mystery/', why: 'a folder no collection has' },
      ]);
      expect(lines.join('\n')).toMatch(/UNKNOWN mystery\//);
      expect(await mtimes(dst.root)).toEqual(stamps);
      // Left out by name, it no longer stops the pass.
      expect((await run(src, dst, { ignore: ['mystery'] })).exit).toBe('ok');
      await rm(join(src.root, 'mystery'), { recursive: true });
      const local = await src.runtime.media.create(OTHER, { path: '/media/own.mp4' }, 'own.mp4');
      await src.runtime.media.save(OTHER, { ...local, file: '/media/own.mp4' });
      const stopped = await run(src, dst);
      expect(stopped.exit_code).toBe(EXIT.refused);
      expect(stopped.refused?.path_imports).toHaveLength(1);
    });
  },
);

// The files into a bucket (CUTTINGFLOOR_BLOBS=s3), on the MinIO scripts/test-s3.sh starts;
// records beside it as JSON files, and in MongoDB when one answers.
const s3Up = await s3Reachable();

describe.each(
  (['filesystem', 'MongoDB'] as const).filter((store) => s3Up && (store === 'filesystem' || up)),
)('moving a data root into a bucket, records to %s', (store) => {
  let src: Seeded;
  let dir: string;
  let db: string;
  let target: MigrationTarget;
  let first: MigrateSummary;
  let runtime: Runtime;
  const s3 = testS3();

  const serverConfig = (root: string) =>
    config(root, {
      node: 'new',
      urlSecret: src.secret,
      s3,
      ...(store === 'MongoDB'
        ? { records: { store: 'mongo', uri: TEST_MONGODB_URI, db } }
        : { s3FileRecords: true }),
    });

  beforeAll(async () => {
    src = await seed();
    dir = await mkdtemp(join(tmpdir(), 'cf-migrate-s3-'));
    db = testDatabase();
    const mongo =
      store === 'MongoDB' ? new MongoRecords({ uri: TEST_MONGODB_URI, db, node: 'm' }) : undefined;
    target = s3Target(s3, {
      dir: join(dir, 'data'),
      ...(mongo ? { records: mongo, recordsName: `mongo:${db}` } : {}),
    });
    await makeBucket(target.blobs);
    // The second media's search index shares the first's by hard link (a deduplicated media),
    // and a third media names the first one's mezzanine as its own without a link (a copy an
    // older server made): the bucket must count three holders for it.
    const { ws, media } = src.runtime;
    await ws.blobs.share(
      ws.blobs.keys.derived(OWNER, src.mediaA, 'search', 'index.bin'),
      ws.blobs.keys.derived(OWNER, src.mediaB, 'search', 'index.bin'),
    );
    const c = await media.create(OWNER, { url: 'https://example.com/c.mp4' }, 'c.mp4');
    const mezzanine = ws.blobs.keys.media(OWNER, src.mediaA, 'mezzanine.mov');
    await media.save(OWNER, { ...c, status: 'ready', file: mezzanine, size: 3013 });
    first = await migrate({
      source: src.root,
      target,
      stateDir: join(dir, 'state'),
      specs: hostedCollections(src.runtime.ws),
      settleMs: 0,
      // As the script sends them: parts of one size, of which only the last may be small. The
      // bucket takes them at any size (what does not fill one of its own parts waits beside
      // the blob), so the test's small ones go the same way 16 MiB ones do.
      partBytes: PART,
      log: (line) => lines.push(line),
    });
  });

  afterAll(async () => {
    src?.runtime.stop();
    await src?.runtime.close();
    if (runtime) {
      for (const owner of [OWNER, OTHER]) {
        await runtime.uploads.forget(owner).catch(() => undefined);
        await runtime.ws.blobs.forget(owner).catch(() => undefined);
      }
      await runtime.close();
    }
    if (store === 'MongoDB') {
      const mongo = target.records as MongoRecords;
      await mongo.idle();
      await (await mongo.database()).dropDatabase();
    }
    await target?.close();
    if (src) await rm(src.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it('moves everything and verifies it: sizes, hashes, holders, stored bytes, ages, links', async () => {
    expect(first.verify?.differences).toEqual([]);
    expect(first.waiting).toEqual([]);
    expect(first.exit).toBe('ok');
    expect(first.target).toContain(`blobs=s3:${s3.bucket}`);
    expect(first.target).not.toContain(s3.secretAccessKey);
    const { blobs } = target;
    // The bucket's own layout, through its key functions.
    expect(blobs.keys.media(OWNER, src.mediaA, 'source.mp4')).toBe(
      `media/${OWNER}/${src.mediaA}/source.mp4`,
    );
    // Hard links at the source are one object with two holders, counted once: under the key
    // of whichever media came first, and the other media's record names that key.
    const heads = await Promise.all(
      [src.mediaA, src.mediaB].map((id) => blobs.head(blobs.keys.media(OWNER, id, 'source.mp4'))),
    );
    expect(heads.filter(Boolean)).toHaveLength(1);
    expect(heads.find(Boolean)).toMatchObject({ refs: 2, sha256: sha(bytesOf('file', 3010)) });
    const row = first.verify?.owners.find((o) => o.expected > 0);
    expect(row?.target).toBe(row?.expected);
    expect(await blobs.usage(OWNER)).toBe(row?.expected);
    // Every blob of the owner is listed under the owner's prefix, each with what verify reads.
    const listed = await blobs.list(blobs.keys.owner(OWNER));
    expect(listed.map((h) => h.key.split('/')[0])).toEqual(
      expect.arrayContaining(['media', 'derived', 'outputs']),
    );
    for (const { key } of listed)
      expect((await blobs.head(key))?.sha256, key).toMatch(/^[0-9a-f]{64}$/);
    // A second pass sends nothing again.
    const again = await migrate({
      source: src.root,
      target,
      stateDir: join(dir, 'state'),
      specs: hostedCollections(src.runtime.ws),
      settleMs: 0,
      partBytes: PART,
      log: (line) => lines.push(line),
    });
    expect(again.exit).toBe('ok');
    expect(again.verify?.differences).toEqual([]);
    expect(written(again)).toBe(0);
  });

  it('counts holders from records, and says what the bucket stores twice', async () => {
    const { blobs } = target;
    const heads = await Promise.all(
      [src.mediaA, src.mediaB].map((id) =>
        blobs.head(blobs.keys.media(OWNER, id, 'mezzanine.mov')),
      ),
    );
    expect(heads.find(Boolean)?.refs).toBe(3);
    // The shared search index is two objects in the bucket, one file at the source: counted.
    expect(first.verify?.stored_twice_bytes).toBe(1500);
    expect(first.verify?.differences.filter((d) => d.kind === 'usage')).toEqual([]);
  });

  it('checks a part-way upload against the parts the bucket lists', async () => {
    const state = join(dir, 'state');
    const manifest = JSON.parse(await readFile(join(state, 'manifest.json'), 'utf8')) as {
      partway: Record<string, { target: string; parts: Array<{ etag: string }> }>;
    };
    const carried = Object.values(manifest.partway)[0];
    const stateKey = carried?.parts.at(-1)?.etag.slice('seq:'.length) as string;
    expect(await target.blobs.head(stateKey)).toBeDefined();
    await target.blobs.delete(stateKey);
    const checked = await migrate({
      source: src.root,
      target,
      stateDir: state,
      specs: hostedCollections(src.runtime.ws),
      mode: 'verify',
      log: () => undefined,
    });
    expect(checked.verify?.differences).toEqual([
      expect.objectContaining({ kind: 'upload-state', of: 'upload:part-way' }),
    ]);
    // A repair sends its parts anew.
    const repaired = await migrate({
      source: src.root,
      target,
      stateDir: state,
      specs: hostedCollections(src.runtime.ws),
      settleMs: 0,
      partBytes: PART,
      repair: true,
      log: () => undefined,
    });
    expect(repaired.blobs['upload:part-way']).toMatchObject({ carried: 1 });
    expect(repaired.verify?.differences).toEqual([]);
  });

  it('a server on the bucket answers as the old one did, and a part-way upload carries on', async () => {
    runtime = new Runtime(serverConfig(join(dir, 'data')));
    await runtime.start({ sweep: false });
    const server = createHttpServer({ runtime, credentials: new LocalCredentialStore({}, false) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    (runtime.config as { publicUrl: string }).publicUrl = base;
    try {
      const client = await connect(runtime, OWNER);
      const held = await ok<{
        media: Array<{ media_id: string }>;
        uploads: Array<{ upload_id: string; received_bytes: number; complete: boolean }>;
      }>(client, 'media.list', {});
      expect(held.media.map((m) => m.media_id)).toEqual(
        expect.arrayContaining([src.mediaA, src.mediaB]),
      );
      // The upload that had three and a half parts stands at three: the sender resends the rest.
      const carried = PART * 3;
      expect(held.uploads.find((u) => u.upload_id === src.partway)).toMatchObject({
        received_bytes: carried,
        complete: false,
      });
      const { url } = await runtime.uploads.resume(OWNER, src.partway);
      const at = await fetch(url, { method: 'HEAD' });
      expect([
        at.status,
        at.headers.get('upload-offset'),
        at.headers.get('upload-complete'),
      ]).toEqual([200, String(carried), 'false']);
      const whole = bytesOf('p', 20_000);
      const send = (from: number, to: number) =>
        fetch(url, {
          method: 'PUT',
          headers: { 'content-range': `bytes ${from}-${to - 1}/20000` },
          body: whole.subarray(from, to) as unknown as BodyInit,
        });
      // From where the old server stood: refused, with where this one stands.
      const stale = await send(Math.floor(PART * 3.5), 20_000);
      expect([stale.status, stale.headers.get('upload-offset')]).toEqual([409, String(carried)]);
      const more = await send(carried, 9000);
      expect([more.status, more.headers.get('upload-offset')]).toEqual([200, '9000']);
      const rest = await send(9000, 20_000);
      expect([rest.status, rest.headers.get('upload-complete')]).toEqual([200, 'true']);
      const key = runtime.ws.blobs.keys.upload(OWNER, src.partway, 'data.mov');
      const chunks: Buffer[] = [];
      for await (const chunk of await runtime.ws.blobs.get(key)) chunks.push(chunk as Buffer);
      expect(sha(Buffer.concat(chunks))).toBe(sha(whole));
      // Imported, it is the media's file where it is.
      const job = await ok<{ job_id: string }>(client, 'media.import', {
        source: { upload_id: src.partway },
      });
      expect(job.job_id).toMatch(/^j_/);
      expect((await runtime.ws.blobs.head(key))?.bytes).toBe(20_000);
      // The upload sent whole before the move imports too, and an old link plays from the bucket.
      const before = await ok<{ result: { url: string } }>(client, 'job.get', {
        job_id: src.exported,
      });
      const file = await fetch(before.result.url, { redirect: 'manual' });
      expect(file.status).toBe(302);
      expect((await fetch(before.result.url)).status).toBe(200);
      const media = await ok<{ url: string }>(client, 'media.get', { media_id: src.mediaB });
      const played = await fetch(media.url);
      expect(played.status).toBe(200);
      expect(sha(Buffer.from(await played.arrayBuffer()))).toBe(sha(bytesOf('file', 3010)));
      // The frames kept for download are as old at the bucket as they were: not yet due.
      expect(await runtime.ws.blobs.expire(runtime.ws.blobs.keys.outputs(OWNER), 6 * DAY)).toEqual(
        [],
      );
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe.skipIf(!s3Up)('reading the bucket back on the new server', () => {
  it('hashes every file against the source’s hashes, without the source', async () => {
    const src = await seed();
    const dir = await mkdtemp(join(tmpdir(), 'cf-migrate-reread-'));
    const s3 = testS3();
    const target = s3Target(s3, { dir: join(dir, 'data') });
    await makeBucket(target.blobs);
    const options = {
      source: src.root,
      target,
      stateDir: join(dir, 'state'),
      specs: hostedCollections(src.runtime.ws),
      settleMs: 0,
      partBytes: PART,
      log: () => undefined,
    };
    try {
      expect((await migrate(options)).exit).toBe('ok');
      // The source is out of reach (another server): the manifest and the bucket are enough.
      const away = `${src.root}-away`;
      await rename(src.root, away);
      try {
        const back = await migrate({ ...options, mode: 'verify', reread: 'all' });
        expect(back.exit).toBe('ok');
        expect(back.reread?.checked).toBeGreaterThan(5);
        // Other bytes of the same size under one key: found by reading, whatever the store says.
        const manifest = JSON.parse(
          await readFile(join(dir, 'state', 'manifest.json'), 'utf8'),
        ) as { blobs: Record<string, { target: string }> };
        const key = Object.values(manifest.blobs).find((b) =>
          b.target.endsWith('/cleaned/voice.wav'),
        )?.target as string;
        const head = await target.blobs.head(key);
        await target.blobs.put(key, { bytes: bytesOf('Q', head?.bytes ?? 0) });
        const caught = await migrate({ ...options, mode: 'verify', reread: 'all' });
        expect(caught.exit_code).toBe(EXIT.differs);
        expect(caught.verify?.differences).toEqual([
          expect.objectContaining({ kind: 'blob-sha256', of: 'reread' }),
        ]);
        const some = await migrate({ ...options, mode: 'verify', reread: 2 });
        expect(some.reread?.checked).toBe(2);
      } finally {
        await rename(away, src.root);
      }
    } finally {
      await target.blobs.forget(OWNER).catch(() => undefined);
      await target.blobs.forget(OTHER).catch(() => undefined);
      await target.close();
      src.runtime.stop();
      await src.runtime.close();
      await rm(src.dir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Whether the tests run as root, whom file permissions do not stop. */
const ROOT = process.getuid?.() === 0;

describe('telling a target that differs', () => {
  let src: Seeded;
  let dst: Target;

  beforeAll(async () => {
    src = await seed();
    dst = await makeTarget('filesystem');
  });

  afterAll(async () => {
    src?.runtime.stop();
    await src?.runtime.close();
    await dst?.drop();
    if (src) await rm(src.dir, { recursive: true, force: true });
  });

  it('leaves what is still being written for the next pass', async () => {
    // Everything was written a moment ago: no file is taken, and no record that names one.
    const early = await run(src, dst, { settleMs: 3_600_000 });
    expect(early.exit_code).toBe(EXIT.waiting);
    expect(early.blobs['media:own']).toMatchObject({ waiting: 7 });
    expect(early.records.media).toMatchObject({ waiting: 3 });
    expect(early.records.timelines?.written).toBeGreaterThan(0);
    expect(early.verify?.differences).toEqual([]);
    // A file that changes while it is read is not kept as moved.
    const key = src.runtime.ws.blobs.keys.derived(OWNER, src.mediaA, 'cleaned', 'voice.wav');
    const put = dst.target.blobs.put.bind(dst.target.blobs);
    const spy = vi.spyOn(dst.target.blobs, 'put').mockImplementation(async (to, from, options) => {
      const head = await put(to, from, options);
      if (to === key) await src.runtime.ws.blobs.put(key, { bytes: bytesOf('d', 2300) });
      return head;
    });
    const torn = await run(src, dst);
    spy.mockRestore();
    expect(torn.exit_code).toBe(EXIT.waiting);
    expect(torn.waiting).toEqual([
      { what: expect.stringContaining('cleaned/voice.wav'), why: 'it changed while it was read' },
    ]);
    // On the final pass nothing may be left waiting, and nothing is.
    const final = await run(src, dst, {
      final: true,
      drainCheck: false,
      targetKeyFingerprint: urlKeyFingerprint(Buffer.from(src.secret, 'base64')),
    });
    expect(final.exit).toBe('ok');
    expect((await dst.target.blobs.head(key))?.bytes).toBe(2300);
  });

  it('verify names each kind of difference and exits non-zero', async () => {
    const { blobs, records } = dst.target;
    const clean = await run(src, dst, { mode: 'verify' });
    expect(clean.exit).toBe('ok');
    // A file with other bytes of the same size, one missing, one nobody moved.
    await blobs.put(blobs.keys.media(OWNER, src.mediaA, 'proxy.mp4'), {
      bytes: bytesOf('X', 3009),
    });
    await blobs.delete(blobs.keys.output(OWNER, src.frames, 'frame-000001.png'));
    await blobs.put(blobs.keys.derived(OWNER, src.mediaA, 'cleaned', 'stray.wav'), {
      bytes: bytesOf('z', 5),
    });
    // A record changed, one gone, one that was never at the source.
    const timelines = records.collection(spec('timelines'), { owner: OWNER });
    const jobs = records.collection(spec('jobs'), { owner: OWNER });
    await jobs.update(src.cancelled, { set: { statusMessage: 'tampered' } });
    await timelines.delete(src.timeline);
    await timelines.put(`tl_${'9'.repeat(32)}`, { extra: true });
    lines.length = 0;
    const report = await run(src, dst, { mode: 'verify', links: 'all' });
    expect(report.exit_code).toBe(EXIT.differs);
    const kinds = (report.verify?.differences ?? []).map((d) => `${d.kind} ${d.of}`).sort();
    expect(kinds).toEqual(
      expect.arrayContaining([
        'blob-extra blob',
        'blob-missing output:frames',
        'blob-sha256 media:own',
        'link link',
        'record-differs jobs',
        'record-extra timelines',
        'record-missing timelines',
        'usage owner',
      ]),
    );
    const changed = report.verify?.differences.find((d) => d.kind === 'record-differs');
    // The field that differs is named; what it holds is not.
    expect(changed?.detail).toMatch(/statusMessage/);
    expect(JSON.stringify(report.verify)).not.toContain('tampered');
    expect(lines.join('\n')).toMatch(/DIFFERENCES[\s\S]*record-differs\s+jobs/);
    expect(JSON.parse(await readFile(report.files.verify ?? '', 'utf8')).differences.length).toBe(
      report.verify?.differences.length,
    );
    // The next pass with --rehash puts back what a pass can: files it finds changed or missing.
    const mended = await run(src, dst, { rehash: true, verify: false, afterFinal: true });
    expect(mended.blobs['media:own']?.copied).toBe(1);
  });

  it('says in a dry run which records the target would refuse for their size', async () => {
    const small: MigrationTarget = { ...dst.target, maxRecordBytes: 300 };
    const fresh = await mkdtemp(join(tmpdir(), 'cf-migrate-state-'));
    try {
      const dry = await migrate({
        source: src.root,
        target: small,
        stateDir: fresh,
        specs: hostedCollections(src.runtime.ws),
        mode: 'dry-run',
        // The target had its final pass in the test before.
        afterFinal: true,
        log: () => undefined,
      });
      expect(dry.exit_code).toBe(EXIT.differs);
      expect(dry.oversize.length).toBeGreaterThan(0);
      expect(dry.oversize[0]).toMatchObject({ collection: expect.any(String) });
      expect(dry.oversize[0]?.bytes).toBeGreaterThan(300);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('refuses a state folder inside the source, and one that is another migration’s', async () => {
    await expect(
      migrate({
        source: src.root,
        target: dst.target,
        stateDir: join(src.root, 'state'),
        log: () => undefined,
      }),
    ).rejects.toThrow(/only ever read/);
    const other = await makeTarget('filesystem');
    try {
      await expect(
        migrate({
          source: src.root,
          target: other.target,
          stateDir: dst.state,
          mode: 'dry-run',
          afterFinal: true,
          log: () => undefined,
        }),
      ).rejects.toThrow(/another migration/);
    } finally {
      await other.drop();
    }
  });
});

describe('passes that must not lose data', () => {
  let src: Seeded;
  let dst: Target;
  const fingerprint = () => urlKeyFingerprint(Buffer.from(src.secret, 'base64'));

  beforeAll(async () => {
    src = await seed();
    dst = await makeTarget('filesystem');
    expect((await run(src, dst)).exit).toBe('ok');
  });

  afterAll(async () => {
    src?.runtime.stop();
    await src?.runtime.close();
    await dst?.drop();
    if (src) await rm(src.dir, { recursive: true, force: true });
  });

  const timelines = () => dst.target.records.collection(spec('timelines'), { owner: OWNER });

  it('refuses a source that is not a data root: an empty folder where the mount should be', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'cf-migrate-empty-'));
    try {
      const refused = await run(src, dst, { source: empty } as Partial<MigrateOptions>);
      expect(refused.exit_code).toBe(EXIT.refused);
      expect(refused.refused?.why).toMatch(/does not look like a server's data root/);
      expect(await timelines().has(src.timeline)).toBe(true);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  // Taking a folder's permissions away stops nobody who is root (the image's test stage is).
  it.skipIf(ROOT)('stops, removing nothing, when a folder cannot be listed', async () => {
    const folder = src.runtime.ws.ownerDir(OWNER, 'timelines');
    await chmod(folder, 0o000);
    try {
      const broke = await run(src, dst);
      expect(broke.exit_code).toBe(EXIT.failed);
      expect(broke.deletes.done).toBe(0);
    } finally {
      await chmod(folder, 0o755);
    }
    expect(await timelines().has(src.timeline)).toBe(true);
  });

  it('keeps an unreadable record waiting, with everything of it at the target', async () => {
    const file = join(src.runtime.media.dir(OWNER, src.mediaB), 'media.json');
    const text = await readFile(file, 'utf8');
    const { mtime } = await lstat(file);
    await writeFile(file, '{"not json');
    try {
      const pass = await run(src, dst);
      expect(pass.exit_code).toBe(EXIT.waiting);
      expect(pass.unreadable).toEqual([
        { what: expect.stringContaining(src.mediaB), why: 'the record not JSON' },
      ]);
      expect(pass.deletes.planned).toBe(0);
      const media = dst.target.records.collection(spec('media'), { owner: OWNER });
      expect(await media.has(src.mediaB)).toBe(true);
      const { blobs } = dst.target;
      expect(await blobs.head(blobs.keys.media(OWNER, src.mediaB, 'source.mp4'))).toBeDefined();
      expect((await run(src, dst, { mode: 'verify' })).exit_code).toBe(EXIT.waiting);
    } finally {
      await writeFile(file, text);
      await utimes(file, mtime, mtime);
    }
    expect((await run(src, dst)).exit).toBe('ok');
  });

  it('gives an upload the later of its record’s and folder’s times, and moves a user’s .part file', async () => {
    const { runtime } = src;
    const sent = await ok<{ upload_id: string }>(src.client, 'media.upload', { name: 'clip.part' });
    await runtime.uploads.receive(OWNER, sent.upload_id, Readable.from([bytesOf('k', 900)]), {
      length: 900,
      range: null,
    });
    const folder = runtime.ws.ownerDir(OWNER, 'uploads', sent.upload_id);
    const older = new Date(Date.now() - 2 * DAY);
    const newer = new Date(Date.now() - 3_600_000);
    await utimes(join(folder, 'upload.json'), older, older);
    await utimes(folder, newer, newer);
    expect((await run(src, dst)).exit).toBe('ok');
    const record = (
      await dst.target.records.collection(spec('uploads'), { owner: OWNER }).find()
    ).find((r) => r.id === sent.upload_id);
    expect(Math.abs((record?.usedAt.getTime() ?? 0) - newer.getTime())).toBeLessThan(1000);
    const { blobs } = dst.target;
    expect(await blobs.head(blobs.keys.upload(OWNER, sent.upload_id, 'data.part'))).toMatchObject({
      bytes: 900,
    });
  });

  it('sends a log line appended while its part was read on the next pass', async () => {
    const { FsBlobStore } = await import('@cuttingfloor/core');
    const proto = FsBlobStore.prototype;
    const real = proto.getRange;
    const line = { at: new Date().toISOString(), tool: 'appended.meanwhile' };
    let appended = false;
    const spy = vi.spyOn(proto, 'getRange').mockImplementation(async function (
      this: InstanceType<typeof FsBlobStore>,
      key: string,
      start: number,
      end?: number,
    ) {
      if (!appended && /\/calls\/.+\.jsonl$/.test(key)) {
        appended = true;
        const { appendFile } = await import('node:fs/promises');
        await appendFile(join(src.root, ...key.split('/')), `${JSON.stringify(line)}\n`);
      }
      return real.call(this, key, start, end);
    });
    try {
      // A call after the last pass, so the part has something new to send.
      await ok(src.client, 'timeline.create', { name: 'Log', sequence: SEQ });
      await until(async () =>
        (await readCalls(src.runtime.ws, OWNER)).some((c) => c.tool === 'timeline.create'),
      );
      await run(src, dst, { verify: false });
    } finally {
      spy.mockRestore();
    }
    expect(appended).toBe(true);
    expect((await run(src, dst)).exit).toBe('ok');
    const log = await dst.target.records.log(spec('calls'), { owner: OWNER }).read();
    expect(log).toEqual(expect.arrayContaining([expect.objectContaining(line)]));
  });

  it('repairs what a standby server changed, and lists and prunes what it added', async () => {
    const { blobs } = dst.target;
    await timelines().put(src.timeline, { tampered: true } as never);
    await timelines().put(`tl_${'8'.repeat(32)}`, { test: true } as never);
    const stray = blobs.keys.output(OWNER, 'j_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'test.mp4');
    await blobs.put(stray, { bytes: bytesOf('t', 10) });
    expect((await run(src, dst)).exit_code).toBe(EXIT.differs);
    const listed = await run(src, dst, { repair: true, pruneExtras: 1 });
    expect(listed.extras).toMatchObject({ records: 1, blobs: 1, pruned: 0 });
    expect(listed.exit_code).toBe(EXIT.deletesRefused);
    expect((await timelines().get(src.timeline)) as unknown).not.toEqual({ tampered: true });
    const pruned = await run(src, dst, { repair: true, pruneExtras: 5 });
    expect(pruned.exit).toBe('ok');
    expect(pruned.extras).toMatchObject({ pruned: 2 });
    expect(await blobs.head(stray)).toBeUndefined();
  });

  it('leaves an account that is only at the target alone when told to', async () => {
    const tester = 'user_01TESTACCOUNTONLYONTARGET0';
    await dst.target.records
      .collection(spec('timelines'), { owner: tester })
      .put(`tl_${'6'.repeat(32)}`, { test: true } as never);
    const seen = await run(src, dst, { mode: 'verify' });
    expect(seen.exit_code).toBe(EXIT.differs);
    // Named in reports by hash only.
    expect(JSON.stringify(seen.verify)).not.toContain('user_01TEST');
    const left = await run(src, dst, { excludeOwners: [tester] });
    expect(left.exit).toBe('ok');
    expect(await dst.target.records.owners()).toContain(tester);
  });

  it('keeps at the target what expired at the source and is still there', async () => {
    const old = new Date(Date.now() - 8 * DAY);
    await utimes(join(src.runtime.media.dir(OWNER, src.mediaA), 'media.json'), old, old);
    const pass = await run(src, dst, { excludeOwners: ['user_01TESTACCOUNTONLYONTARGET0'] });
    expect(pass.exit).toBe('ok');
    expect(pass.deletes.planned).toBe(0);
    const media = dst.target.records.collection(spec('media'), { owner: OWNER });
    expect(await media.has(src.mediaA)).toBe(true);
    const { blobs } = dst.target;
    expect(
      await blobs.head(blobs.keys.derived(OWNER, src.mediaA, 'cleaned', 'voice.wav')),
    ).toBeDefined();
  });

  it('compares the link-signing keys by fingerprint', async () => {
    const other = await run(src, dst, {
      mode: 'verify',
      targetKeyFingerprint: '0123456789abcdef',
      excludeOwners: ['user_01TESTACCOUNTONLYONTARGET0'],
    });
    expect(other.verify?.differences).toEqual([expect.objectContaining({ kind: 'signing-key' })]);
    expect(JSON.stringify(other)).not.toContain(src.secret);
    const same = await run(src, dst, {
      mode: 'verify',
      targetKeyFingerprint: fingerprint(),
      excludeOwners: ['user_01TESTACCOUNTONLYONTARGET0'],
    });
    expect(same.verify?.signing_key).toMatchObject({ same: true });
    expect(same.exit).toBe('ok');
  });

  it('fetches a download and an upload link signed with the old key from the new server', async () => {
    const serveOn = async (secret: string) => {
      const runtime = await dst.runtime(secret);
      const server = createHttpServer({
        runtime,
        credentials: new LocalCredentialStore({}, false),
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      return {
        url,
        stop: async () => {
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
        },
      };
    };
    const more = { mode: 'verify' as const, excludeOwners: ['user_01TESTACCOUNTONLYONTARGET0'] };
    const same = await serveOn(src.secret);
    try {
      const checked = await run(src, dst, { ...more, targetUrl: same.url });
      expect(checked.verify?.live_links).toBe(2);
      expect(checked.exit).toBe('ok');
    } finally {
      await same.stop();
    }
    const other = await serveOn(randomBytes(32).toString('base64'));
    try {
      const refused = await run(src, dst, { ...more, targetUrl: other.url });
      expect(refused.verify?.differences.map((d) => `${d.kind} ${d.of}`).sort()).toEqual([
        'link-live download',
        'link-live upload',
      ]);
    } finally {
      await other.stop();
    }
  });

  it('refuses a target a server serves on', async () => {
    const marks = dst.target.records.collection(MIGRATION);
    await marks.put('live', { node: 'new', since: new Date().toISOString() });
    try {
      const refused = await run(src, dst);
      expect(refused.exit_code).toBe(EXIT.refused);
      expect(refused.refused?.why).toMatch(/a server serves on the target/);
    } finally {
      await marks.delete('live');
    }
  });

  it('runs the final pass only on a drained source, then refuses any pass after it', async () => {
    const more = {
      excludeOwners: ['user_01TESTACCOUNTONLYONTARGET0'],
      targetKeyFingerprint: fingerprint(),
    };
    expect((await run(src, dst, { ...more, final: true })).refused?.why).toMatch(/not draining/);
    const marker = join(src.root, 'draining');
    const drained = (jobs: number) =>
      writeFile(
        marker,
        JSON.stringify({
          since: new Date().toISOString(),
          at: new Date().toISOString(),
          node: 'old',
          jobs_running: jobs,
        }),
      );
    await drained(2);
    expect((await run(src, dst, { ...more, final: true })).refused?.why).toMatch(
      /still runs 2 jobs/,
    );
    await drained(0);
    // An upload carried more than six hours ago is carried anew by the final pass.
    const file = join(dst.state, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')) as {
      partway: Record<string, { started_at: string }>;
    };
    for (const carried of Object.values(manifest.partway)) {
      carried.started_at = new Date(Date.now() - 7 * 3_600_000).toISOString();
    }
    await writeFile(file, JSON.stringify(manifest));
    const final = await run(src, dst, { ...more, final: true });
    expect(final.exit).toBe('ok');
    expect(final.blobs['upload:part-way']).toMatchObject({ carried: 1 });
    expect(await dst.target.records.collection(MIGRATION).get('final')).toMatchObject({
      source: src.root,
    });
    // After it: passes are refused, verify is not, and --after-final is the way through.
    const later = await run(src, dst, more);
    expect(later.exit_code).toBe(EXIT.refused);
    expect(later.refused?.why).toMatch(/final pass already ended clean/);
    expect((await run(src, dst, { ...more, mode: 'dry-run' })).exit_code).toBe(EXIT.refused);
    expect((await run(src, dst, { ...more, mode: 'verify' })).exit).toBe('ok');
    expect((await run(src, dst, { ...more, afterFinal: true })).exit).toBe('ok');
    await rm(marker, { force: true });
  });

  it.skipIf(ROOT)('stops at the start when its state folder cannot be written', async () => {
    const locked = await mkdtemp(join(tmpdir(), 'cf-migrate-locked-'));
    await chmod(locked, 0o500);
    try {
      await expect(run(src, dst, { stateDir: locked } as Partial<MigrateOptions>)).rejects.toThrow(
        /cannot be written/,
      );
    } finally {
      await chmod(locked, 0o700);
      await rm(locked, { recursive: true, force: true });
    }
  });
});

describe('the command line', () => {
  it('runs a dry run from the environment’s settings and exits 0', async () => {
    const src = await seed();
    const dir = await mkdtemp(join(tmpdir(), 'cf-migrate-cli-'));
    try {
      const { spawnSync } = await import('node:child_process');
      const script = fileURLToPath(new URL('../../../scripts/migrate-storage.ts', import.meta.url));
      const result = spawnSync(
        process.execPath,
        [
          script,
          '--source',
          src.root,
          '--state',
          join(dir, 'state'),
          '--target-dir',
          join(dir, 'data'),
          '--dry-run',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, CUTTINGFLOOR_RECORDS: '', CUTTINGFLOOR_BLOBS: '' },
        },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/dry-run ended: ok \(exit 0\)/);
      expect(result.stdout).toMatch(/records timelines: \d+ at the source, \d+ to write/);
      expect(result.stdout).not.toContain(OWNER);
      expect(await readdir(join(dir, 'data')).catch(() => [])).toEqual([]);
      // A bucket without its settings is refused by name, before anything is read.
      const s3 = spawnSync(
        process.execPath,
        [script, '--source', src.root, '--state', join(dir, 'state'), '--dry-run'],
        {
          encoding: 'utf8',
          env: { ...process.env, CUTTINGFLOOR_RECORDS: '', CUTTINGFLOOR_BLOBS: 's3' },
        },
      );
      expect(s3.status).toBe(1);
      expect(s3.stderr).toMatch(/CUTTINGFLOOR_BLOBS=s3/);
    } finally {
      src.runtime.stop();
      await src.runtime.close();
      await rm(src.dir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
