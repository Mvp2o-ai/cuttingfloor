import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { floorCursor, type MongoRecords } from '@cuttingfloor/core';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import type { AccountGetResult } from '@cuttingfloor/schema';
import {
  CLAIMS,
  createServer,
  meterEntries,
  Runtime,
  type RuntimeConfig,
  readCalls,
} from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EmailProvider, OutboundEmail } from '../src/email.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { Sequence, type Subscribers } from '../src/sequence.ts';
import { MONGO_TEST_TIMEOUT_MS, mongoReachable, TEST_MONGODB_URI, testDatabase } from './mongo.ts';

// One account's ordinary day, through the SDK client and the hosted pieces, on each record
// store: the same calls and the same assertions on the filesystem and on MongoDB. Engines are a
// stand-in that never finishes (as in the server's jobs tests), so a job stays working until it
// is cancelled and this runs the same with or without FFmpeg.

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
  return { saved };
});

afterAll(() => {
  for (const [k, v] of Object.entries(fake.saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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
const TEMPLATES = fileURLToPath(new URL('../email/', import.meta.url));

interface Env {
  runtime: Runtime;
  config: RuntimeConfig;
  dir: string;
  mediaDir: string;
  drop(): Promise<void>;
}

async function start(store: 'filesystem' | 'MongoDB'): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-records-flow-'));
  const mediaDir = join(dir, 'media');
  await mkdir(mediaDir, { recursive: true });
  const config: RuntimeConfig = {
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:8787',
    mediaRoots: [mediaDir],
    exportsDir: null,
    maxJobs: 1,
    shortJobs: 0,
    outputUrlTtlMs: 3_600_000,
    maxDownloadBytes: 1024 ** 3,
    allowPrivateUrls: true,
    inlineMaxBytes: 32 * 1024 ** 2,
    motionUrl: null,
    node: 'flow',
    ...(store === 'MongoDB'
      ? { records: { store: 'mongo', uri: TEST_MONGODB_URI, db: testDatabase() } }
      : {}),
  };
  const runtime = new Runtime(config);
  await runtime.start({ sweep: false });
  return {
    runtime,
    config,
    dir,
    mediaDir,
    drop: async () => {
      if (store === 'MongoDB') {
        const records = runtime.ws.records as MongoRecords;
        await records.idle();
        await (await records.database()).dropDatabase();
      }
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function connect(runtime: Runtime, owner: string): Promise<Client> {
  const server = createServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => owner,
    account: async () => ACCOUNT,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'flow', version: '0.0.0' });
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

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const SEQ = { width: 1280, height: 720, fps: { num: 25, den: 1 } };

describe.each((['filesystem', 'MongoDB'] as const).filter((store) => store === 'filesystem' || up))(
  'an account’s day with records on %s',
  (store) => {
    let env: Env;
    let client: Client;

    beforeAll(async () => {
      env = await start(store);
      client = await connect(env.runtime, OWNER);
    });

    afterAll(async () => {
      await env?.drop();
    });

    it('welcomes the account until its credits are claimed, and claims them once', async () => {
      expect(client.getInstructions()).toMatch(/^This is a new connection: welcome aboard\./);
      const first = await ok<{ claimed_now: boolean; job_id?: string }>(client, 'credits.claim', {
        use_case: 'cut a podcast into clips',
      });
      expect(first.claimed_now).toBe(true);
      const again = await ok<{ claimed_now: boolean }>(client, 'credits.claim', {
        use_case: 'something else',
      });
      expect(again.claimed_now).toBe(false);
      expect((await connect(env.runtime, OWNER)).getInstructions()).not.toContain('welcome aboard');
      // A server started later (another node, or this one restarted) reads the claim itself.
      const { creditsClaimed } = await import('@cuttingfloor/server');
      expect(await creditsClaimed(env.runtime, OWNER)).toBe(true);
      expect(await creditsClaimed(env.runtime, 'user_someone_else')).toBe(false);
      // The sample's import never ends on the stand-in engine: stopped, so the one slot is free.
      if (first.job_id) await call(client, 'job.cancel', { job_id: first.job_id });
    });

    it('creates a timeline, edits it, and reads both versions back', async () => {
      const made = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'Flow',
        sequence: SEQ,
      });
      const titled = await ok<{ timeline_id: string }>(client, 'title.add', {
        timeline_id: made.timeline_id,
        track_id: 't1',
        text: 'One second',
        duration_frames: 25,
        preview: 'none',
      });
      expect(titled.timeline_id).not.toBe(made.timeline_id);
      for (const timeline_id of [made.timeline_id, titled.timeline_id]) {
        const got = await ok<{ timeline_id: string }>(client, 'timeline.get', { timeline_id });
        expect(got.timeline_id).toBe(timeline_id);
      }
      const missing = await call<{ code: string }>(client, 'timeline.get', {
        timeline_id: `tl_${'0'.repeat(32)}`,
      });
      expect(missing.structured.code).toBe('not_found');
    });

    it('keeps a media record, lists it, and says what became of it once deleted', async () => {
      const { media } = env.runtime;
      await writeFile(join(env.mediaDir, 'clip.mp4'), 'not really a video');
      const record = await media.create(
        OWNER,
        { path: join(env.mediaDir, 'clip.mp4') },
        'clip.mp4',
      );
      record.status = 'ready';
      await media.save(OWNER, record);
      await media.saveAnalysis(OWNER, record.media_id, 'transcript', {
        model: 'tiny',
        language: 'en',
        text: 'hello',
        words: [{ text: 'hello', start: 0, end: 0.5, confidence: 0.9 }],
      });
      const listed = await ok<{ media: Array<{ media_id: string; expires_at: string }> }>(
        client,
        'media.list',
        {},
      );
      const mine = listed.media.find((m) => m.media_id === record.media_id);
      expect(Date.parse(mine?.expires_at ?? '')).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      const got = await ok<{ media_id: string; status: string }>(client, 'media.get', {
        media_id: record.media_id,
      });
      expect(got).toMatchObject({ media_id: record.media_id, status: 'ready' });
      expect((await media.find(OWNER, record.media_id))?.analyses?.transcript).toMatchObject({
        text: 'hello',
      });
      // Analyses are files beside the media on either record store: on disk where they always
      // were, in the bytes they always had.
      const analysesDir = env.runtime.ws.ownerDir(OWNER, 'media', record.media_id, 'analyses');
      expect(await readFile(join(analysesDir, 'transcript.json'), 'utf8')).toBe(
        '{\n  "model": "tiny",\n  "language": "en",\n  "text": "hello",\n  "words": [\n    {\n      "text": "hello",\n      "start": 0,\n      "end": 0.5,\n      "confidence": 0.9\n    }\n  ]\n}\n',
      );
      // One far past what a database document holds is written and read back whole.
      const events = Array.from({ length: 300_000 }, (_, i) => ({
        label: `sound ${i}`,
        start: i / 4,
        end: i / 4 + 0.2,
        probability: 0.5,
      }));
      expect(Buffer.byteLength(JSON.stringify({ events }))).toBeGreaterThan(20 * 1024 ** 2);
      await media.saveAnalysis(OWNER, record.media_id, 'sounds' as never, { events });
      const back = (await media.find(OWNER, record.media_id))?.analyses as unknown as {
        sounds: { events: typeof events };
        transcript: { text: string };
      };
      expect(back.sounds.events).toHaveLength(300_000);
      expect(back.sounds.events[299_999]).toEqual(events[299_999]);
      expect(back.transcript.text).toBe('hello');
      // Written again, it is the new one that is read; and it counts as the account's storage.
      await media.saveAnalysis(OWNER, record.media_id, 'sounds' as never, { events: [] });
      expect((await media.find(OWNER, record.media_id))?.analyses).toMatchObject({
        sounds: { events: [] },
      });
      expect((await readdir(analysesDir)).sort()).toEqual(['sounds.json', 'transcript.json']);
      expect(await env.runtime.ws.blobs.usage(OWNER)).toBeGreaterThan(100);
      // The listing gives records without their analyses.
      expect(JSON.stringify(await media.list(OWNER))).not.toContain('"analyses"');
      await ok(client, 'media.delete', { media_id: record.media_id });
      expect(await readdir(analysesDir).catch(() => 'gone')).toBe('gone');
      const gone = await call<{ code: string; message: string }>(client, 'media.get', {
        media_id: record.media_id,
      });
      expect(gone.isError).toBe(true);
      expect(gone.structured.message).toMatch(/deleted/);
      expect(await media.find(OWNER, record.media_id)).toBeUndefined();
    });

    it('records an upload and moves the account’s floor', async () => {
      const before = await floorCursor(env.runtime.ws, OWNER);
      const upload = await ok<{ upload_id: string }>(client, 'media.upload', { name: 'Beach.mov' });
      expect(await floorCursor(env.runtime.ws, OWNER)).not.toBe(before);
      const listed = await ok<{ uploads: Array<{ upload_id: string; complete: boolean }> }>(
        client,
        'media.list',
        {},
      );
      expect(listed.uploads).toEqual([
        expect.objectContaining({ upload_id: upload.upload_id, complete: false }),
      ]);
      const state = await env.runtime.uploads.receive(
        OWNER,
        upload.upload_id,
        (await import('node:stream')).Readable.from([Buffer.from('bytes')]),
        { length: 5, range: null },
      );
      expect(state).toMatchObject({ received: 5, complete: true });
      const after = await ok<{ uploads: Array<{ complete: boolean; bytes: number }> }>(
        client,
        'media.list',
        {},
      );
      expect(after.uploads[0]).toMatchObject({ complete: true, bytes: 5 });
    });

    it('starts a job once per idempotency key, and cancels it', async () => {
      const made = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'Export',
        sequence: SEQ,
      });
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'title.add', {
        timeline_id: made.timeline_id,
        track_id: 't1',
        text: 'One second',
        duration_frames: 25,
        preview: 'none',
      });
      const args = { timeline_id, preset: 'mp4_h264_fast', idempotency_key: 'flow-1' };
      const first = await ok<{ job_id: string; status: string }>(client, 'export.video', args);
      const repeat = await ok<{ job_id: string }>(client, 'export.video', args);
      expect(repeat.job_id).toBe(first.job_id);
      const listed = await ok<{ jobs: Array<{ job_id: string; status: string }> }>(
        client,
        'job.list',
        { status: 'working' },
      );
      expect(listed.jobs.map((j) => j.job_id)).toContain(first.job_id);
      await ok(client, 'job.cancel', { job_id: first.job_id });
      await until(
        async () =>
          (await ok<{ status: string }>(client, 'job.get', { job_id: first.job_id })).status !==
          'working',
      );
      const ended = await ok<{ status: string }>(client, 'job.get', { job_id: first.job_id });
      expect(ended.status).toBe('cancelled');
      // A cancelled job's key starts a fresh one.
      const fresh = await ok<{ job_id: string }>(client, 'export.video', args);
      expect(fresh.job_id).not.toBe(first.job_id);
      await ok(client, 'job.cancel', { job_id: fresh.job_id });
      expect(await env.runtime.jobs.store.working()).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ id: first.job_id })]),
      );
    });

    it('meters each judging call once, and logs the calls', async () => {
      const id = 'q_aaaaaaaaaaaaaaaaaaaaaaaaaa';
      await env.runtime.meterJudgments(OWNER, id, 'judge.ask', 5);
      await env.runtime.meterJudgments(OWNER, id, 'judge.ask', 5);
      const entries = [];
      for await (const entry of meterEntries(env.runtime.ws, OWNER, new Date(0))) {
        if (entry.job_id === id) entries.push(entry);
      }
      expect(entries).toEqual([expect.objectContaining({ tool: 'judge.ask', judgments: 5 })]);
      await until(async () =>
        (await readCalls(env.runtime.ws, OWNER)).some((c) => c.tool === 'export.video'),
      );
      const tools = (await readCalls(env.runtime.ws, OWNER)).map((c) => c.tool);
      expect(tools).toEqual(expect.arrayContaining(['credits.claim', 'timeline.create']));
    });

    it('makes a script key, finds its owner, and stops it when revoked', async () => {
      const keys = new ScriptKeys(env.runtime.ws);
      const made = await keys.create(OWNER, 'render box');
      expect(await keys.owner(made.key)).toBe(OWNER);
      expect(await keys.owner(`${made.key}x`)).toBeUndefined();
      expect((await keys.list(OWNER)).map((k) => k.key_id)).toEqual([made.key_id]);
      expect(await keys.revoke(OWNER, made.key_id)).toBe(true);
      expect(await keys.owner(made.key)).toBeUndefined();
      expect(await keys.list(OWNER)).toEqual([]);
      const other = await keys.create('user_other', 'theirs');
      await keys.removeAll('user_other');
      expect(await keys.owner(other.key)).toBeUndefined();
      await keys.sweep();
    });

    it('sends the welcome email once, however often the sequence looks', async () => {
      const sent: OutboundEmail[] = [];
      const provider: EmailProvider = {
        send: async (email) => {
          sent.push(email);
          return { id: `msg_${sent.length}` };
        },
      };
      const now = Date.now();
      const subscribers: Subscribers = {
        async *createdSince() {
          yield {
            id: OWNER,
            email: 'person@example.com',
            createdAt: new Date(now - 60_000).toISOString(),
            verified: true,
          };
        },
        current: async () => ({ email: 'person@example.com' }),
      };
      const options = {
        ws: env.runtime.ws,
        subscribers,
        provider,
        from: 'Ken at cuttingfloor <ken@cuttingfloor.ai>',
        replyTo: 'support@cuttingfloor.ai',
        signer: 'Ken',
        publicUrl: 'https://api.cuttingfloor.ai',
        unsubscribeSecret: 'unsubscribe-secret',
        followUpAfterMs: 3 * 86_400_000,
        creditsAfterMs: 7 * 86_400_000,
        credits: async () => ({ left: 23.1, perMonth: null, bought: 0 }),
        pollMs: 30_000,
        templatesDir: TEMPLATES,
      };
      // Two servers' sequences, looking at once and again.
      const a = new Sequence(options);
      const b = new Sequence(options);
      await Promise.all([a.tick(now), b.tick(now)]);
      await a.tick(now + 30_000);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe('person@example.com');
    });

    it('over HTTP, a signed-in account is welcomed until any server has its claim', async () => {
      const owner = 'user_01ABCDEFGHJKMNPQRSTVWXYZ02';
      const keys = new ScriptKeys(env.runtime.ws);
      const { key } = await keys.create(owner, 'script');
      const server = createHttpServer({
        runtime: env.runtime,
        credentials: new LocalCredentialStore({}, false),
        scriptKeys: keys,
        access: async () => undefined,
        account: async () => ACCOUNT,
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
      const instructions = async () => {
        const remote = new Client({ name: 'script', version: '0' });
        await remote.connect(
          new StreamableHTTPClientTransport(url, {
            requestInit: { headers: { authorization: `Bearer ${key}` } },
          }),
        );
        const text = remote.getInstructions() ?? '';
        await remote.close();
        return text;
      };
      try {
        expect(await instructions()).toMatch(/^This is a new connection: welcome aboard\./);
        // Claimed through another server on the same store: this one has not seen the claim.
        const elsewhere = new Runtime(env.config);
        await elsewhere.ws.records
          .collection(CLAIMS, { owner })
          .insertOnce('free-credits', { claimed: true, use_case: 'x', claimed_at: 'now' });
        await elsewhere.close();
        expect(await instructions()).not.toContain('welcome aboard');
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('sweeps without losing anything still in its time, and forgets a deleted account', async () => {
      const { ws } = env.runtime;
      await env.runtime.sweep();
      const listed = await ok<{ uploads: unknown[] }>(client, 'media.list', {});
      expect(listed.uploads).toHaveLength(1);
      // An upload that never got a byte and is past its time: its record goes, wherever it is.
      const empty = await ok<{ upload_id: string }>(client, 'media.upload', { name: 'never.mov' });
      const longAgo = new Date(Date.now() - 30 * 86_400_000);
      if (store === 'MongoDB') {
        const db = await (ws.records as MongoRecords).database();
        await db
          .collection('uploads')
          .updateOne({ id: empty.upload_id }, { $set: { used_at: longAgo } });
      } else {
        const folder = ws.ownerDir(OWNER, 'uploads', empty.upload_id);
        await utimes(join(folder, 'upload.json'), longAgo, longAgo);
        await utimes(folder, longAgo, longAgo);
      }
      expect((await ok<{ uploads: unknown[] }>(client, 'media.list', {})).uploads).toHaveLength(2);
      await env.runtime.uploads.sweep();
      expect((await ok<{ uploads: unknown[] }>(client, 'media.list', {})).uploads).toHaveLength(1);
      expect((await ws.records.owners()).sort()).toContain(OWNER);
      await ws.blobs.deletePrefix(ws.blobs.keys.owner(OWNER));
      await ws.records.forget(OWNER);
      expect(await ws.records.owners()).not.toContain(OWNER);
      expect(await floorCursor(ws, OWNER)).toBe('0');
    });
  },
);
