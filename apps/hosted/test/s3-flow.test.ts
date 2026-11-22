/// <reference lib="dom" />
// The page functions in the browser test below run in the browser.
import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer as plainHttpServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { MongoRecords, S3BlobStore, S3Settings } from '@cuttingfloor/core';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { createServer, Runtime, type RuntimeConfig, UPLOADS } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http.ts';
import { mongoReachable, TEST_MONGODB_URI, testDatabase } from './mongo.ts';
import { makeBucket, S3_TEST_TIMEOUT_MS, s3Reachable, testS3 } from './s3.ts';

// A hosted server with its files in a bucket (CUTTINGFLOOR_BLOBS=s3), as a client meets it:
// uploads over HTTP, imports and exports through the SDK client, downloads by following the
// link. On each record store, and with two servers on one bucket and one database.

const up = await s3Reachable();
const mongo = up && (await mongoReachable());
const exec = promisify(execFile);
// Imports probe and conform with FFmpeg; without it those tests skip, as the engine suites do.
const ffmpeg = await Promise.all([
  exec('ffmpeg', ['-version']),
  exec('ffprobe', ['-version']),
]).then(
  () => true,
  () => false,
);
vi.setConfig({ testTimeout: S3_TEST_TIMEOUT_MS, hookTimeout: S3_TEST_TIMEOUT_MS });

const MIB = 1024 ** 2;
const URL_SECRET = randomBytes(32).toString('base64');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

interface Node {
  runtime: Runtime;
  server: Server;
  base: string;
  dir: string;
  s3: S3Settings;
  stop(): Promise<void>;
}

interface Shared {
  s3?: S3Settings;
  db?: string;
}

async function node(
  store: 'filesystem' | 'MongoDB',
  shared: Shared = {},
  name = 'a',
): Promise<Node> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-s3-flow-'));
  const s3 = shared.s3 ?? testS3();
  const config: RuntimeConfig = {
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 2,
    outputUrlTtlMs: 3_600_000,
    maxDownloadBytes: 64 * MIB,
    allowPrivateUrls: true,
    inlineMaxBytes: 1 * MIB,
    motionUrl: null,
    node: name,
    urlSecret: URL_SECRET,
    s3,
    ...(store === 'MongoDB'
      ? { records: { store: 'mongo', uri: TEST_MONGODB_URI, db: shared.db ?? testDatabase() } }
      : { s3FileRecords: true }),
  };
  const runtime = new Runtime(config);
  if (!shared.s3) await makeBucket(runtime.ws.blobs);
  await runtime.start({ sweep: false });
  const server = createHttpServer({ runtime, credentials: new LocalCredentialStore({}, false) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (runtime.config as { publicUrl: string }).publicUrl = base;
  return {
    runtime,
    server,
    base,
    dir,
    s3,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await runtime.indexer.idle();
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Leaves nothing behind: every owner's files, and the test's database. */
async function wipe(n: Node, owners: string[]): Promise<void> {
  for (const owner of owners) {
    await n.runtime.uploads.forget(owner).catch(() => undefined);
    await n.runtime.ws.blobs.forget(owner).catch(() => undefined);
  }
  if (n.runtime.config.records) {
    const records = n.runtime.ws.records as MongoRecords;
    await records.idle();
    await (await records.database()).dropDatabase();
  }
}

async function connect(runtime: Runtime, owner: string): Promise<Client> {
  const server = createServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => owner,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 's3-flow', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function ok<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: T;
  };
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.structuredContent)}`);
  return (res.structuredContent ?? {}) as T;
}

async function settled<T = Record<string, unknown>>(
  client: Client,
  jobId: string,
): Promise<T & { status: string }> {
  const until = Date.now() + 60_000;
  for (;;) {
    const view = await ok<T & { status: string }>(client, 'job.get', { job_id: jobId });
    if (view.status !== 'working') return view;
    if (Date.now() > until) throw new Error(`job ${jobId} still working`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface Started {
  upload_id: string;
  url: string;
}

const startUpload = (client: Client, name: string, bytes?: number) =>
  ok<Started>(client, 'media.upload', { name, ...(bytes === undefined ? {} : { bytes }) });

/** The same link on another server (links are signed with a key the servers share). */
const on = (n: Node, url: string) => `${n.base}${new URL(url).pathname}${new URL(url).search}`;
/** The link with something after its path: /parts, /parts/2, /complete. */
const sub = (url: string, more: string, query = '') => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}${more}${u.search}${query}`;
};

async function put(url: string, body: Uint8Array, range?: { at: number; total: number | '*' }) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: range
      ? { 'content-range': `bytes ${range.at}-${range.at + body.length - 1}/${range.total}` }
      : {},
    body: body as unknown as BodyInit,
  });
  return {
    status: res.status,
    offset: Number(res.headers.get('upload-offset') ?? Number.NaN),
    complete: res.headers.get('upload-complete'),
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function offset(
  url: string,
): Promise<{ status: number; at: number; complete: string | null }> {
  const res = await fetch(url, { method: 'HEAD' });
  return {
    status: res.status,
    at: Number(res.headers.get('upload-offset') ?? Number.NaN),
    complete: res.headers.get('upload-complete'),
  };
}

async function stored(n: Node, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await n.runtime.ws.blobs.get(key)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const keysOf = async (n: Node, prefix: string) =>
  (await n.runtime.ws.blobs.list(prefix)).map((h) => h.key);

/** A second of quiet sound, different for each `seed`: a file FFmpeg reads without a picture. */
function wav(seed: number): Buffer {
  const samples = Buffer.alloc(16_000);
  for (let i = 0; i < samples.length; i += 2) samples.writeInt16LE(((i * seed) % 200) - 100, i);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + samples.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24);
  head.writeUInt32LE(16_000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(samples.length, 40);
  return Buffer.concat([head, samples]);
}

const stores = [
  { store: 'filesystem' as const, skip: !up },
  { store: 'MongoDB' as const, skip: !mongo },
];

describe.each(stores)('files in a bucket, records on $store', ({ store, skip }) => {
  const flow = (name: string, run: (n: Node, owner: string, client: Client) => Promise<void>) =>
    it.skipIf(skip)(name, async () => {
      const n = await node(store);
      const owner = 'alice';
      try {
        await run(n, owner, await connect(n.runtime, owner));
      } finally {
        await wipe(n, [owner]);
        await n.stop();
      }
    });

  flow(
    'a file sent whole is in the bucket, and importing it copies nothing',
    async (n, owner, client) => {
      const body = randomBytes(300_000);
      const upload = await startUpload(client, 'take one.bin', body.length);
      expect((await offset(upload.url)).at).toBe(0);
      const sent = await put(upload.url, body);
      expect(sent).toMatchObject({ status: 200, offset: body.length, complete: 'true' });
      expect(sent.body).toMatchObject({
        upload_id: upload.upload_id,
        received: body.length,
        complete: true,
        next: `media.import {source: {upload_id: "${upload.upload_id}"}}`,
      });
      expect(await offset(upload.url)).toEqual({ status: 200, at: body.length, complete: 'true' });
      // Sent again once it is complete: refused as on the filesystem.
      expect(await put(upload.url, body)).toMatchObject({
        status: 409,
        offset: body.length,
        complete: 'true',
        body: { error: 'this upload is complete; import it', received: body.length },
      });
      const key = `media/${owner}/${upload.upload_id}/data.bin`;
      expect(await keysOf(n, `media/${owner}/`)).toEqual([key]);
      expect(sha(await stored(n, key))).toBe(sha(body));
      const listed = await ok<{
        uploads: Array<Record<string, unknown>>;
        storage: { used_bytes: number };
      }>(client, 'media.list', {});
      expect(listed.uploads).toMatchObject([
        {
          upload_id: upload.upload_id,
          received_bytes: body.length,
          bytes: body.length,
          complete: true,
        },
      ]);
      expect(listed.storage.used_bytes).toBe(body.length);
      // Imported: the upload is no longer one, and its object is the media's file where it is.
      const job = await ok<{ job_id: string }>(client, 'media.import', {
        source: { upload_id: upload.upload_id },
      });
      await settled(client, job.job_id);
      expect(await keysOf(n, `media/${owner}/`)).toEqual([key]);
      expect((await offset(upload.url)).status).toBe(404);
      expect(await put(upload.url, body)).toMatchObject({
        status: 404,
        body: { error: 'no such upload, or it expired' },
      });
      const after = await ok<{ uploads: unknown[]; media: Array<{ media_id: string }> }>(
        client,
        'media.list',
        {},
      );
      expect(after.uploads).toEqual([]);
      expect(after.media).toHaveLength(1);
    },
  );

  flow(
    'parts of any size, a second sender, a broken connection, then the rest',
    async (n, owner, client) => {
      const body = randomBytes(12 * MIB + 4321);
      const total = body.length;
      const upload = await startUpload(client, 'long take.mov', total);
      const url = upload.url;
      const cut = (from: number, to: number) => body.subarray(from, to);
      // Under a part, across one, a single byte.
      let at = 0;
      for (const to of [1_000_003, 6 * MIB + 17, 6 * MIB + 18]) {
        const sent = await put(url, cut(at, to), { at, total });
        expect(sent).toMatchObject({ status: 200, offset: to, complete: 'false' });
        expect(sent.body).toMatchObject({ received: to, complete: false });
        at = to;
        expect(await offset(url)).toEqual({ status: 200, at, complete: 'false' });
      }
      // Not where the upload stands: told where it does, and nothing changes.
      for (const wrong of [0, at + 5]) {
        expect(await put(url, cut(wrong, wrong + 10), { at: wrong, total })).toMatchObject({
          status: 409,
          offset: at,
          complete: 'false',
          body: { error: `the upload has ${at} bytes; send from there`, received: at },
        });
      }
      // A sender that stops half way through a part: what arrived is kept, and it is told so.
      const half = cut(at, at + 3 * MIB);
      const { pathname, search, port } = new URL(url);
      const broken = request({
        host: '127.0.0.1',
        port,
        path: `${pathname}${search}`,
        method: 'PUT',
        headers: {
          'content-range': `bytes ${at}-${at + 5 * MIB - 1}/${total}`,
          'content-length': 5 * MIB,
        },
      });
      broken.on('error', () => undefined);
      // While it is sending, another sender is refused.
      await new Promise<void>((r) => broken.write(half.subarray(0, MIB), () => r()));
      await vi.waitFor(async () => {
        // (From a byte further on, so one that arrives before the first has begun lands nothing.)
        const second = await put(url, cut(at + 1, at + 11), { at: at + 1, total });
        expect(second).toMatchObject({
          status: 409,
          body: { error: 'another request is sending this upload' },
        });
      });
      await new Promise<void>((r) => broken.write(half.subarray(MIB), () => r()));
      await new Promise((r) => setTimeout(r, 200));
      broken.destroy();
      let landed = at;
      await vi.waitFor(async () => {
        const now = await offset(url);
        expect(now.at).toBeGreaterThan(at);
        landed = now.at;
      });
      expect(landed).toBeLessThanOrEqual(at + 3 * MIB);
      // The length is not said until the last part.
      const mid = landed + 1_000_000;
      expect(await put(url, cut(landed, mid), { at: landed, total: '*' })).toMatchObject({
        status: 200,
        offset: mid,
        complete: 'false',
      });
      expect(await put(url, cut(mid, total), { at: mid, total })).toMatchObject({
        status: 200,
        offset: total,
        complete: 'true',
      });
      const key = `media/${owner}/${upload.upload_id}/data.mov`;
      expect(await keysOf(n, `media/${owner}/`)).toEqual([key]);
      expect(sha(await stored(n, key))).toBe(sha(body));
    },
  );

  flow('a whole file replaces what was sent; one too big is refused', async (n, owner, client) => {
    const upload = await startUpload(client, 'clip.bin');
    const first = randomBytes(100_000);
    expect(
      await put(upload.url, first.subarray(0, 60_000), { at: 0, total: 100_000 }),
    ).toMatchObject({
      status: 200,
      offset: 60_000,
    });
    // A new name before it is whole: the page sends the file's own name.
    const second = randomBytes(70_000);
    const whole = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'upload-name': encodeURIComponent('the clip.mp4') },
      body: second,
    });
    expect(whole.status).toBe(200);
    expect(whole.headers.get('upload-complete')).toBe('true');
    const keys = await keysOf(n, `media/${owner}/`);
    expect(keys).toHaveLength(1);
    expect(sha(await stored(n, keys[0] as string))).toBe(sha(second));
    const big = await startUpload(client, 'big.bin');
    const refused = await fetch(big.url, {
      method: 'PUT',
      headers: { 'content-range': `bytes 0-9/${65 * MIB}` },
      body: Buffer.alloc(10),
    });
    expect(refused.status).toBe(413);
    expect(((await refused.json()) as { error: string }).error).toMatch(/^This file is too big/);
    expect((await fetch(`${big.url}x`, { method: 'HEAD' })).status).toBe(403);
  });

  flow('numbered parts, several at once, one sent again', async (n, owner, client) => {
    const body = randomBytes(34 * MIB + 77);
    const upload = await startUpload(client, 'feature.mp4');
    const url = upload.url;
    // Nothing is set up until the file's size is said.
    expect((await fetch(sub(url, '/parts'))).status).toBe(400);
    const begun = await fetch(sub(url, '/parts', `&bytes=${body.length}`), {
      headers: { 'upload-name': encodeURIComponent('the feature.mov') },
    });
    expect(begun.status).toBe(200);
    expect(await begun.json()).toEqual({
      upload_id: upload.upload_id,
      part_bytes: 16 * MIB,
      total_bytes: body.length,
      parts: [],
      received: 0,
      complete: false,
    });
    const part = (i: number) => body.subarray((i - 1) * 16 * MIB, i * 16 * MIB);
    const send = (i: number, bytes = part(i)) =>
      fetch(sub(url, `/parts/${i}`), { method: 'PUT', body: bytes });
    // One part comes up short the first time, and a part that is not one is refused.
    const [one, short, three, none] = await Promise.all([
      send(1),
      send(2, part(2).subarray(0, 1000)),
      send(3),
      send(4),
    ]);
    expect([one.status, short.status, three.status, none.status]).toEqual([200, 400, 200, 400]);
    expect(((await short.json()) as { error: string }).error).toBe(
      `part 2 is ${16 * MIB} bytes; send it with that Content-Length`,
    );
    // Asked again (a reload, a second device): what is in, so only the rest is sent.
    const listed = (await (await fetch(sub(url, '/parts'))).json()) as { parts: unknown[] };
    expect(listed.parts).toEqual([
      { part: 1, bytes: 16 * MIB },
      { part: 3, bytes: 2 * MIB + 77 },
    ]);
    expect((await offset(url)).at).toBe(18 * MIB + 77);
    const early = await fetch(sub(url, '/complete'), { method: 'POST' });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ missing: [2], complete: false });
    // The plain PUT does not mix with parts.
    expect((await put(url, body.subarray(0, 10), { at: 0, total: body.length })).status).toBe(409);
    expect((await send(2)).status).toBe(200);
    expect((await send(1)).status).toBe(200);
    const done = await fetch(sub(url, '/complete'), { method: 'POST' });
    expect(done.status).toBe(200);
    expect(done.headers.get('upload-complete')).toBe('true');
    expect(await done.json()).toEqual({
      upload_id: upload.upload_id,
      received: body.length,
      complete: true,
      next: `media.import {source: {upload_id: "${upload.upload_id}"}}`,
    });
    expect((await fetch(sub(url, '/complete'), { method: 'POST' })).status).toBe(200);
    expect(await offset(url)).toEqual({ status: 200, at: body.length, complete: 'true' });
    const key = `media/${owner}/${upload.upload_id}/data.mov`;
    expect(await keysOf(n, `media/${owner}/`)).toEqual([key]);
    expect(sha(await stored(n, key))).toBe(sha(body));
  });

  flow(
    'an export downloads from the bucket: a redirect, the exact bytes, a range',
    async (n, owner, client) => {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
        name: 'Hand off',
      });
      const started = await ok<{ job_id: string }>(client, 'export.timeline', {
        timeline_id,
        format: 'otio',
      });
      const job = await settled<{ result: { url: string; bytes: number; uri: string } }>(
        client,
        started.job_id,
      );
      expect(job.status).toBe('completed');
      const { url, bytes } = job.result;
      expect(url.startsWith(`${n.base}/outputs/${owner}/${started.job_id}/`)).toBe(true);
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop() as string);
      const key = `outputs/${owner}/${started.job_id}/${name}`;
      const body = await stored(n, key);
      expect(body.length).toBe(bytes);
      // The link is ours and is checked here; the file comes from the bucket.
      const hop = await fetch(url, { redirect: 'manual' });
      expect(hop.status).toBe(302);
      const location = hop.headers.get('location') as string;
      expect(location.startsWith(`${n.s3.endpoint}/${n.s3.bucket}/${key}?`)).toBe(true);
      expect(location).toMatch(/X-Amz-Expires=3600\b/);
      expect(hop.headers.get('access-control-allow-origin')).toBe('*');
      const file = await fetch(url);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-disposition')).toMatch(
        new RegExp(`^attachment; filename="${name}"`),
      );
      expect(file.headers.get('content-type')).toBe(
        hop.headers.get('content-type') ?? file.headers.get('content-type'),
      );
      expect(Buffer.from(await file.arrayBuffer()).equals(body)).toBe(true);
      const range = await fetch(url, { headers: { range: 'bytes=5-24' } });
      expect(range.status).toBe(206);
      expect(range.headers.get('content-range')).toBe(`bytes 5-24/${bytes}`);
      expect(Buffer.from(await range.arrayBuffer()).equals(body.subarray(5, 25))).toBe(true);
      // HEAD is answered here, as it always was.
      const head = await fetch(url, { method: 'HEAD', redirect: 'manual' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String(bytes));
      expect(head.headers.get('accept-ranges')).toBe('bytes');
      // A link that does not check out is refused here and never reaches the bucket.
      expect(
        (await fetch(url.replace(/sig=.{4}/, 'sig=AAAA'), { redirect: 'manual' })).status,
      ).toBe(403);
      // The page that plays it may load from the bucket, and asks for the file to be shown.
      const page = await fetch(url.replace('/outputs/', '/watch/'));
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain(
        `media-src 'self' ${n.s3.endpoint}; img-src 'self' ${n.s3.endpoint};`,
      );
      const html = await page.text();
      expect(html).toContain('>Download</a>');
      // A file that is not sound or a picture downloads, whatever the link asks.
      const shown = await fetch(`${url}&inline=1`);
      expect(shown.headers.get('content-disposition')).toMatch(/^attachment; /);
      // The MCP resource reads it from the bucket; job.get hands out links that work.
      const read = await client.readResource({ uri: job.result.uri });
      const content = read.contents[0] as { blob?: string; text?: string };
      expect(Buffer.from(content.blob ?? '', 'base64').equals(body)).toBe(true);
      const again = await ok<{ result: { url: string } }>(client, 'job.get', {
        job_id: started.job_id,
      });
      expect((await fetch(again.result.url)).status).toBe(200);
      // Views that play media are allowed the bucket too.
      const view = await client.readResource({ uri: 'ui://cuttingfloor/player' });
      expect(JSON.stringify(view.contents[0]?._meta)).toContain(n.s3.endpoint);
      // Gone from the bucket: the link says so itself.
      await n.runtime.ws.blobs.delete(key);
      const gone = await fetch(url, { redirect: 'manual' });
      expect([gone.status, await gone.text()]).toEqual([404, 'gone']);
    },
  );

  flow(
    'an in-order send that got no byte leaves nothing open once the file goes in parts',
    async (n, owner, client) => {
      const blobs = n.runtime.ws.blobs as S3BlobStore;
      const upload = await startUpload(client, 'x.bin');
      // MinIO lists open uploads by an object's whole name only.
      const key = `media/${owner}/${upload.upload_id}/data.bin`;
      const broken = new Readable({
        read() {
          this.destroy(new Error('sender gone'));
        },
      });
      await n.runtime.uploads
        .receive(owner, upload.upload_id, broken, { length: 100, range: { start: 0, total: 100 } })
        .catch(() => undefined);
      expect(await blobs.openUploads(key)).toHaveLength(1);
      const body = randomBytes(100);
      expect((await fetch(sub(upload.url, '/parts', '&bytes=100'))).status).toBe(200);
      expect(await blobs.openUploads(key)).toHaveLength(1);
      expect((await fetch(sub(upload.url, '/parts/1'), { method: 'PUT', body })).status).toBe(200);
      expect((await fetch(sub(upload.url, '/complete'), { method: 'POST' })).status).toBe(200);
      expect(await blobs.openUploads(key)).toEqual([]);
    },
  );

  flow(
    'a part the store holds other than as recorded is sent again, not refused for good',
    async (n, owner, client) => {
      const blobs = n.runtime.ws.blobs as S3BlobStore;
      const body = randomBytes(16 * MIB + 100);
      const upload = await startUpload(client, 'twice.bin');
      const url = upload.url;
      expect((await fetch(sub(url, '/parts', `&bytes=${body.length}`))).status).toBe(200);
      for (const [n_, bytes] of [
        [1, body.subarray(0, 16 * MIB)],
        [2, body.subarray(16 * MIB)],
      ] as const) {
        expect((await fetch(sub(url, `/parts/${n_}`), { method: 'PUT', body: bytes })).status).toBe(
          200,
        );
      }
      // Part 1 sent again by another sender, other bytes of another length, landing in the store
      // after the record was written.
      const record = await n.runtime.ws.records
        .collection(UPLOADS, { owner })
        .get(upload.upload_id);
      const key = `media/${owner}/${upload.upload_id}/data.bin`;
      await blobs.multipartPart(
        key,
        record?.mpu as string,
        1,
        Readable.from([randomBytes(6 * MIB)]),
        {
          bytes: 6 * MIB,
          anyOrder: true,
        },
      );
      const first = await fetch(sub(url, '/complete'), { method: 'POST' });
      expect(first.status).toBe(409);
      expect(((await first.json()) as { missing?: number[] }).missing).toEqual([1]);
      expect(
        (await fetch(sub(url, '/parts/1'), { method: 'PUT', body: body.subarray(0, 16 * MIB) }))
          .status,
      ).toBe(200);
      expect((await fetch(sub(url, '/complete'), { method: 'POST' })).status).toBe(200);
      expect(sha(await stored(n, key))).toBe(sha(body));
    },
  );

  flow(
    'an upload sent in order whose parts another sender wrote over starts again from what holds',
    async (n, owner, client) => {
      const blobs = n.runtime.ws.blobs as S3BlobStore;
      const body = randomBytes(12 * MIB);
      const upload = await startUpload(client, 'over.bin');
      const first = await put(upload.url, body.subarray(0, 6 * MIB), { at: 0, total: body.length });
      expect(first).toMatchObject({ status: 200, offset: 6 * MIB });
      // A sender that lost the upload writes over its first real part.
      const record = await n.runtime.ws.records
        .collection(UPLOADS, { owner })
        .get(upload.upload_id);
      const key = `media/${owner}/${upload.upload_id}/data.bin`;
      await blobs.multipartPart(
        key,
        record?.mpu as string,
        1,
        Readable.from([randomBytes(5 * MIB)]),
        {
          bytes: 5 * MIB,
          anyOrder: true,
        },
      );
      const rest = await put(upload.url, body.subarray(6 * MIB), {
        at: 6 * MIB,
        total: body.length,
      });
      expect(rest).toMatchObject({ status: 409, offset: 0 });
      // Sent again from there, it completes, and the bytes are the file.
      expect(await put(upload.url, body, { at: 0, total: body.length })).toMatchObject({
        status: 200,
        complete: 'true',
      });
      expect(sha(await stored(n, key))).toBe(sha(body));
    },
  );

  flow(
    'a link shows only sound, video and pictures in a page, and is kept no longer than it lasts',
    async (n, owner) => {
      const job = 'j_aaaaaaaaaaaaaaaaaaaaaaaaaa';
      const shown = async (name: string, link?: string) => {
        await n.runtime.ws.blobs.put(`outputs/${owner}/${job}/${name}`, {
          bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        });
        const url = link ?? (await n.runtime.signOutput(owner, job, name)).url;
        const hop = await fetch(`${url}&inline=1`, { redirect: 'manual' });
        const file = await fetch(`${url}&inline=1`);
        return {
          disposition: file.headers.get('content-disposition'),
          cache: hop.headers.get('cache-control'),
        };
      };
      expect(await shown('clip.mp4')).toEqual({
        disposition: 'inline',
        cache: 'private, max-age=600',
      });
      expect((await shown('still.png')).disposition).toBe('inline');
      expect((await shown('page.svg')).disposition).toMatch(/^attachment; filename="page.svg"/);
      expect((await shown('page.html')).disposition).toMatch(/^attachment; /);
      // A link with half a minute left is kept for no longer than that.
      const exp = Date.now() + 30_000;
      const path = `/outputs/${owner}/${job}/end.mp4`;
      const sig = createHmac('sha256', Buffer.from(URL_SECRET, 'base64'))
        .update(`${path}\n${exp}`)
        .digest('base64url');
      const ending = await shown('end.mp4', `${n.base}${path}?exp=${exp}&sig=${sig}`);
      const age = Number(/max-age=(\d+)/.exec(ending.cache ?? '')?.[1]);
      expect(age).toBeGreaterThan(0);
      expect(age).toBeLessThanOrEqual(30);
    },
  );

  flow(
    'sweeps: an upload left unfinished goes whole; a file nothing holds goes',
    async (n, owner, client) => {
      const { blobs, records } = n.runtime.ws;
      const upload = await startUpload(client, 'left.bin');
      await put(upload.url, randomBytes(6 * MIB + 5), { at: 0, total: 20 * MIB });
      const prefix = `media/${owner}/${upload.upload_id}`;
      await n.runtime.uploads.sweep();
      expect((await offset(upload.url)).at).toBe(6 * MIB + 5);
      // Eight days on: record, parts and what was held beside them are gone.
      const old = new Date(Date.now() - 8 * 86_400_000);
      if (store === 'filesystem') {
        await utimes(
          join(n.dir, 'data', 'owners', owner, 'uploads', upload.upload_id, 'upload.json'),
          old,
          old,
        );
      } else {
        const db = await (records as MongoRecords).database();
        await db.collection('uploads').updateMany({}, { $set: { used_at: old } });
      }
      await n.runtime.uploads.sweep();
      expect((await offset(upload.url)).status).toBe(404);
      expect(await keysOf(n, prefix)).toEqual([]);
      // A media file written whose media was never saved, and one an upload still holds.
      const stray = `media/${owner}/m_aaaaaaaaaaaaaaaaaaaaaaaaaa/source.bin`;
      await blobs.put(stray, { bytes: Buffer.alloc(10) });
      const sent = await startUpload(client, 'kept.bin');
      await put(sent.url, randomBytes(1000));
      await n.runtime.sweepOrphans();
      expect(await blobs.head(stray)).toBeDefined();
      // Met with nothing naming it, it is marked; a grace later (here at once) it goes.
      await n.runtime.sweepOrphans(-1000);
      expect(await blobs.head(stray)).toBeDefined();
      await n.runtime.sweepOrphans(-1000);
      expect(await blobs.head(stray)).toBeUndefined();
      expect(await keysOf(n, `media/${owner}/`)).toEqual([
        `media/${owner}/${sent.upload_id}/data.bin`,
      ]);
      // The account is deleted: nothing of the owner's is left in the bucket.
      await blobs.put(`outputs/${owner}/j_aaaaaaaaaaaaaaaaaaaaaaaaaa/x`, {
        bytes: Buffer.alloc(3),
      });
      await blobs.put(`derived/${owner}/m_aaaaaaaaaaaaaaaaaaaaaaaaaa/a/b`, {
        bytes: Buffer.alloc(3),
      });
      await n.runtime.uploads.forget(owner);
      await blobs.forget(owner);
      for (const kind of ['media', 'derived', 'outputs']) {
        expect(await keysOf(n, `${kind}/${owner}`)).toEqual([]);
      }
      expect(await blobs.usage(owner)).toBe(0);
    },
  );

  /** A server of the test's own and its client, gone after `run`. */
  const withNode = (name: string, run: (n: Node, client: Client) => Promise<void>) =>
    it.skipIf(skip || !ffmpeg)(name, async () => {
      const n = await node(store);
      try {
        await run(n, await connect(n.runtime, 'alice'));
      } finally {
        await wipe(n, ['alice']);
        await n.stop();
      }
    });

  /** Sends `body` as a new upload and imports it; the job as it ends. */
  const bring = async (client: Client, body: Buffer, name: string) => {
    const upload = await startUpload(client, name, body.length);
    await put(upload.url, body);
    return { upload, ...(await importUpload(client, upload.upload_id)) };
  };
  const importUpload = async (client: Client, upload_id: string) => {
    const job = await ok<{ job_id: string }>(client, 'media.import', { source: { upload_id } });
    const done = await settled<{
      result: { media_id: string };
      error?: unknown;
      status_message?: string;
    }>(client, job.job_id);
    expect([done.status, done.error]).toEqual(['completed', undefined]);
    return { media_id: done.result.media_id, done };
  };
  const play = async (client: Client, media_id: string) => {
    const got = await ok<{ url: string }>(client, 'media.get', { media_id });
    const res = await fetch(got.url);
    return [res.status, sha(Buffer.from(await res.arrayBuffer()))];
  };
  /** Moves an upload's record `days` back in time. */
  const ageUpload = async (n: Node, owner: string, uploadId: string, days: number) => {
    const at = new Date(Date.now() - days * 86_400_000);
    if (store === 'filesystem') {
      const file = join(n.dir, 'data', 'owners', owner, 'uploads', uploadId, 'upload.json');
      await utimes(file, at, at);
    } else {
      const db = await (n.runtime.ws.records as MongoRecords).database();
      await db.collection('uploads').updateMany({}, { $set: { used_at: at } });
    }
  };

  withNode(
    'the same bytes sent twice import as the media already there, as on the filesystem',
    async (n, client) => {
      const owner = 'alice';
      const body = wav(7);
      const first = await bring(client, body, 'one.wav');
      const key = `media/${owner}/${first.upload.upload_id}/data.wav`;
      expect(await keysOf(n, `media/${owner}/`)).toEqual([key]);
      const alone = await n.runtime.ws.blobs.usage(owner);
      // Sent again under another name: no second media, no ingest, and its copy goes.
      const second = await bring(client, body, 'two.wav');
      expect(second.media_id).toBe(first.media_id);
      expect(second.done.status_message).toBe('already imported');
      expect(await keysOf(n, `media/${owner}/`)).toEqual([key]);
      expect(await n.runtime.ws.blobs.usage(owner)).toBe(alone);
      const listed = await ok<{ media: unknown[]; uploads: unknown[] }>(client, 'media.list', {});
      expect([listed.media.length, listed.uploads.length]).toEqual([1, 0]);
      // A link to the same bytes is fetched and then shares the file: two media, one object.
      const site = plainHttpServer((_req, res) => res.end(body));
      await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
      try {
        const port = (site.address() as AddressInfo).port;
        const job = await ok<{ job_id: string }>(client, 'media.import', {
          source: { url: `http://127.0.0.1:${port}/again.wav` },
        });
        const fetched = await settled<{ result: { media_id: string } }>(client, job.job_id);
        expect(fetched.status).toBe('completed');
        const third = fetched.result.media_id;
        expect(third).not.toBe(first.media_id);
        expect(await keysOf(n, `media/${owner}/`)).toEqual([key]);
        expect((await n.runtime.ws.blobs.head(key))?.refs).toBe(2);
        expect(await play(client, first.media_id)).toEqual([200, sha(body)]);
        expect(await play(client, third)).toEqual([200, sha(body)]);
        // Deleting one frees nothing the other holds, and leaves it playable.
        const freed = await ok<{ freed_bytes?: number }>(client, 'media.delete', {
          media_id: first.media_id,
        });
        expect(freed.freed_bytes ?? 0).toBeLessThan(body.length);
        expect((await n.runtime.ws.blobs.head(key))?.refs).toBe(1);
        expect(await play(client, third)).toEqual([200, sha(body)]);
        await ok(client, 'media.delete', { media_id: third });
      } finally {
        await new Promise((r) => site.close(r));
      }
      expect(await keysOf(n, `media/${owner}/`)).toEqual([]);
      expect(await keysOf(n, `derived/${owner}`)).toEqual([]);
      expect(await n.runtime.ws.blobs.usage(owner)).toBe(0);
    },
  );

  withNode('two imports of one upload at once make one media', async (n, client) => {
    const owner = 'alice';
    const body = wav(11);
    const upload = await startUpload(client, 'both.wav', body.length);
    await put(upload.url, body);
    const [a, b] = await Promise.all([
      importUpload(client, upload.upload_id),
      importUpload(client, upload.upload_id),
    ]);
    expect(a.media_id).toBe(b.media_id);
    const listed = await ok<{ media: unknown[] }>(client, 'media.list', {});
    expect(listed.media).toHaveLength(1);
    const key = `media/${owner}/${upload.upload_id}/data.wav`;
    expect((await n.runtime.ws.blobs.head(key))?.refs).toBe(1);
    // Deleted, its file goes; nothing else held it.
    await ok(client, 'media.delete', { media_id: a.media_id });
    expect(await keysOf(n, `media/${owner}/`)).toEqual([]);
  });

  withNode(
    'an import whose upload could not be let go of: asked again it is the same media, and the upload sweep spares its file',
    async (n, client) => {
      const owner = 'alice';
      const body = wav(13);
      const upload = await startUpload(client, 'kept.wav', body.length);
      await put(upload.url, body);
      const remove = vi
        .spyOn(n.runtime.uploads, 'remove')
        .mockRejectedValueOnce(new Error('database away'));
      // The import goes on: the claim keeps the object the media's.
      const { media_id } = await importUpload(client, upload.upload_id);
      remove.mockRestore();
      const listed = await ok<{ media: unknown[]; uploads: unknown[] }>(client, 'media.list', {});
      expect([listed.media.length, listed.uploads.length]).toEqual([1, 1]);
      // The upload is still listed; its object is the media's. Seven days on, its record goes
      // and the object stays.
      await ageUpload(n, owner, upload.upload_id, 8);
      await n.runtime.sweep();
      expect((await offset(upload.url)).status).toBe(404);
      expect(await play(client, media_id)).toEqual([200, sha(body)]);
      // Imported again (a retry): the same media, nothing new.
      const again = await startUpload(client, 'kept-again.wav', body.length);
      await put(again.url, body);
      expect((await importUpload(client, again.upload_id)).media_id).toBe(media_id);
      expect(await play(client, media_id)).toEqual([200, sha(body)]);
    },
  );

  withNode(
    'a retried import of an upload already made a media is that media',
    async (n, client) => {
      const owner = 'alice';
      const body = wav(17);
      const upload = await startUpload(client, 'retry.wav', body.length);
      await put(upload.url, body);
      const remove = vi
        .spyOn(n.runtime.uploads, 'remove')
        .mockRejectedValueOnce(new Error('database away'));
      const first = await importUpload(client, upload.upload_id);
      remove.mockRestore();
      const retried = await importUpload(client, upload.upload_id);
      expect(retried.media_id).toBe(first.media_id);
      expect(retried.done.status_message).toBe('already imported');
      const listed = await ok<{ media: Array<{ media_id: string }>; uploads: unknown[] }>(
        client,
        'media.list',
        {},
      );
      expect(listed.media.map((m) => m.media_id)).toEqual([retried.media_id]);
      expect(listed.uploads).toEqual([]);
      const key = `media/${owner}/${upload.upload_id}/data.wav`;
      expect(await keysOf(n, `media/${owner}/`)).toEqual([key]);
      expect(await play(client, retried.media_id)).toEqual([200, sha(body)]);
      // The orphan sweep agrees the media holds it.
      await n.runtime.sweepOrphans(-1000);
      await n.runtime.sweepOrphans(-1000);
      expect(await play(client, retried.media_id)).toEqual([200, sha(body)]);
    },
  );
});

describe.skipIf(!mongo)('two servers on one bucket and one database', () => {
  it('an upload sent to both in turn, an export made on one and downloaded from the other', async () => {
    const a = await node('MongoDB', {}, 'a');
    const db = (a.runtime.config.records as { db: string }).db;
    const b = await node('MongoDB', { s3: a.s3, db }, 'b');
    const owner = 'alice';
    try {
      const onA = await connect(a.runtime, owner);
      const onB = await connect(b.runtime, owner);
      // Parts alternate between the servers; either says where the upload stands.
      const body = randomBytes(11 * MIB + 9);
      const upload = await startUpload(onA, 'both.mov', body.length);
      const cuts = [0, 2 * MIB + 1, 5 * MIB + 3, 5 * MIB + 4, 9 * MIB, body.length];
      for (let i = 1; i < cuts.length; i += 1) {
        const [from, to] = [cuts[i - 1] as number, cuts[i] as number];
        const [sender, other] = i % 2 ? [a, b] : [b, a];
        expect((await offset(on(other, upload.url))).at).toBe(from);
        const sent = await put(on(sender, upload.url), body.subarray(from, to), {
          at: from,
          total: body.length,
        });
        expect(sent).toMatchObject({ status: 200, offset: to });
      }
      // Two senders at one moment, one on each server: one stretch lands once.
      const again = await startUpload(onB, 'race.bin', 2000);
      const chunk = randomBytes(1000);
      const race = await Promise.all([
        put(on(a, again.url), chunk, { at: 0, total: 2000 }),
        put(on(b, again.url), chunk, { at: 0, total: 2000 }),
      ]);
      expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await offset(on(a, again.url))).at).toBe(1000);
      // Numbered parts, each to a different server; completed on the one that got the fewest.
      const large = randomBytes(18 * MIB);
      const parts = await startUpload(onA, 'parts.bin');
      expect((await fetch(sub(on(a, parts.url), '/parts', `&bytes=${large.length}`))).status).toBe(
        200,
      );
      const sent = await Promise.all([
        fetch(sub(on(a, parts.url), '/parts/1'), {
          method: 'PUT',
          body: large.subarray(0, 16 * MIB),
        }),
        fetch(sub(on(b, parts.url), '/parts/2'), { method: 'PUT', body: large.subarray(16 * MIB) }),
      ]);
      expect(sent.map((r) => r.status)).toEqual([200, 200]);
      expect((await fetch(sub(on(b, parts.url), '/complete'), { method: 'POST' })).status).toBe(
        200,
      );
      const keys = await keysOf(a, `media/${owner}/`);
      expect(keys.filter((k) => !k.includes('.parts/'))).toEqual(
        [
          `media/${owner}/${parts.upload_id}/data.bin`,
          `media/${owner}/${upload.upload_id}/data.mov`,
        ].sort(),
      );
      expect(sha(await stored(b, `media/${owner}/${upload.upload_id}/data.mov`))).toBe(sha(body));
      expect(sha(await stored(a, `media/${owner}/${parts.upload_id}/data.bin`))).toBe(sha(large));
      // Imported on B, seen on A.
      const job = await ok<{ job_id: string }>(onB, 'media.import', {
        source: { upload_id: upload.upload_id },
      });
      await settled(onB, job.job_id);
      const listed = await ok<{ media: unknown[]; uploads: Array<{ upload_id: string }> }>(
        onA,
        'media.list',
        {},
      );
      expect(listed.media).toHaveLength(1);
      expect(listed.uploads.map((u) => u.upload_id).sort()).toEqual(
        [again.upload_id, parts.upload_id].sort(),
      );
      // An export made on A downloads through B.
      const { timeline_id } = await ok<{ timeline_id: string }>(onA, 'timeline.create', {
        sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
      });
      const started = await ok<{ job_id: string }>(onA, 'export.timeline', {
        timeline_id,
        format: 'fcpxml',
      });
      const done = await settled<{ result: { url: string; bytes: number } }>(onA, started.job_id);
      expect(done.status).toBe('completed');
      const viaB = await fetch(on(b, done.result.url));
      expect(viaB.status).toBe(200);
      const text = Buffer.from(await viaB.arrayBuffer());
      expect(text.length).toBe(done.result.bytes);
      expect(text.toString()).toContain('<fcpxml');
      // A file one server made from a media is found by the other, and only that file.
      const media = 'm_bbbbbbbbbbbbbbbbbbbbbbbbbb';
      const dirA = await a.runtime.media.derivedDirWith(owner, media, ['cleaned'], ['x.wav']);
      await mkdir(dirA, { recursive: true });
      await writeFile(join(dirA, 'x.wav'), 'cleaned on a');
      await writeFile(join(dirA, 'y.wav'), 'also on a');
      await a.runtime.media.keepDerived(owner, media, ['cleaned'], ['x.wav']);
      const dirB = await b.runtime.media.derivedDirWith(
        owner,
        media,
        ['cleaned'],
        ['x.wav', 'y.wav'],
      );
      expect(await readFile(join(dirB, 'x.wav'), 'utf8')).toBe('cleaned on a');
      expect(await readFile(join(dirB, 'y.wav')).catch(() => 'not there')).toBe('not there');
    } finally {
      await wipe(a, [owner]);
      await b.stop();
      await a.stop();
    }
  });
});

describe.skipIf(!up)('a server told to keep its files in a bucket', () => {
  it('refuses to start when the bucket is not there or the keys are wrong, in plain words', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-s3-start-'));
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const config = (s3: S3Settings): RuntimeConfig => ({
        dataDir: join(dir, 'data'),
        mode: 'hosted',
        publicUrl: 'http://127.0.0.1:0',
        mediaRoots: [],
        exportsDir: null,
        maxJobs: 1,
        outputUrlTtlMs: 3_600_000,
        maxDownloadBytes: MIB,
        allowPrivateUrls: false,
        inlineMaxBytes: MIB,
        motionUrl: null,
        s3,
        s3FileRecords: true,
      });
      // Files in a bucket are for servers that share records in MongoDB.
      const { s3FileRecords: _files, ...alone } = config(testS3());
      expect(() => new Runtime(alone)).toThrow(
        /^CUTTINGFLOOR_BLOBS=s3 needs CUTTINGFLOOR_RECORDS=mongo/,
      );
      const none = new Runtime(config(testS3('cf-test-no-such-bucket')));
      await expect(none.start({ sweep: false })).rejects.toThrow(
        /^CUTTINGFLOOR_S3_BUCKET names a bucket that does not exist/,
      );
      await none.close();
      const secret = 'wrong-secret-wrong-secret';
      const wrong = new Runtime(config({ ...testS3(), secretAccessKey: secret }));
      const refused = (await wrong.start({ sweep: false }).catch((e) => e)) as Error;
      expect(refused.message).toMatch(/^The bucket refused CUTTINGFLOOR_S3_ACCESS_KEY_ID/);
      expect(refused.message).not.toContain(secret);
      expect(log.mock.calls.map((c) => String(c[0])).join('')).not.toContain(secret);
      await wrong.close();
    } finally {
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Docker has Chromium at /usr/bin/chromium; elsewhere CHROME_PATH names a Chrome to use.
const chrome = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const browserFound = await exec(chrome, ['--version']).then(
  () => true,
  () => false,
);

describe.skipIf(!browserFound)('the upload page in a browser', () => {
  /** Opens the upload link as a person would, picks the file, and waits for the page to say Sent. */
  async function sendFromPage(url: string, file: string): Promise<string[]> {
    const { launch } = await import('puppeteer-core');
    const browser = await launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });
    try {
      const page = await browser.newPage();
      const asked: string[] = [];
      page.on('request', (r) => {
        const path = new URL(r.url()).pathname;
        if (r.method() !== 'HEAD')
          asked.push(`${r.method()} ${path.replace(/^.*\/u_[0-9a-z]+/, '')}`);
      });
      await page.goto(url);
      const input = await page.waitForSelector('#pick');
      await (input as unknown as { uploadFile(path: string): Promise<void> }).uploadFile(file);
      await page.waitForFunction(() => document.querySelector('#status')?.className === 'done', {
        timeout: 60_000,
      });
      return asked;
    } finally {
      await browser.close();
    }
  }

  it.skipIf(!up)('sends the file in numbered parts to a server on a bucket', async () => {
    const n = await node('filesystem');
    const owner = 'alice';
    try {
      const client = await connect(n.runtime, owner);
      const body = randomBytes(34 * MIB + 1);
      const file = join(n.dir, 'Holiday film.mov');
      await writeFile(file, body);
      const upload = await startUpload(client, 'video');
      const asked = await sendFromPage(upload.url, file);
      expect(asked.filter((a) => a.startsWith('PUT')).sort()).toEqual([
        'PUT /parts/1',
        'PUT /parts/2',
        'PUT /parts/3',
      ]);
      expect(asked.at(-1)).toBe('POST /complete');
      expect(await offset(upload.url)).toEqual({ status: 200, at: body.length, complete: 'true' });
      const key = `media/${owner}/${upload.upload_id}/data.mov`;
      expect(sha(await stored(n, key))).toBe(sha(body));
      const listed = await ok<{ uploads: Array<{ name: string }> }>(client, 'media.list', {});
      expect(listed.uploads[0]?.name).toBe('Holiday film.mov');
    } finally {
      await wipe(n, [owner]);
      await n.stop();
    }
  });

  it('sends it whole, in order, to a server that keeps files on its disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-fs-page-'));
    const runtime = new Runtime({
      dataDir: join(dir, 'data'),
      mode: 'hosted',
      publicUrl: 'http://127.0.0.1:0',
      mediaRoots: [],
      exportsDir: null,
      maxJobs: 1,
      outputUrlTtlMs: 3_600_000,
      maxDownloadBytes: 64 * MIB,
      allowPrivateUrls: false,
      inlineMaxBytes: MIB,
      motionUrl: null,
    });
    await runtime.start({ sweep: false });
    const server = createHttpServer({ runtime, credentials: new LocalCredentialStore({}, false) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    (runtime.config as { publicUrl: string }).publicUrl =
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = await connect(runtime, 'alice');
      const body = randomBytes(300_000);
      const file = join(dir, 'clip.mov');
      await writeFile(file, body);
      const upload = await startUpload(client, 'video');
      const asked = await sendFromPage(upload.url, file);
      expect(asked.filter((a) => a.startsWith('PUT'))).toEqual(['PUT ']);
      expect(await offset(upload.url)).toEqual({ status: 200, at: body.length, complete: 'true' });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a server that keeps its files on its own disk', () => {
  it('takes a file whole and says so when asked for parts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-fs-parts-'));
    const runtime = new Runtime({
      dataDir: join(dir, 'data'),
      mode: 'hosted',
      publicUrl: 'http://127.0.0.1:0',
      mediaRoots: [],
      exportsDir: null,
      maxJobs: 1,
      outputUrlTtlMs: 3_600_000,
      maxDownloadBytes: MIB,
      allowPrivateUrls: false,
      inlineMaxBytes: MIB,
      motionUrl: null,
    });
    await runtime.start({ sweep: false });
    const server = createHttpServer({ runtime, credentials: new LocalCredentialStore({}, false) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    (runtime.config as { publicUrl: string }).publicUrl =
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = await connect(runtime, 'alice');
      const upload = await startUpload(client, 'a.bin');
      const asked = await fetch(sub(upload.url, '/parts', '&bytes=100'));
      expect(asked.status).toBe(404);
      expect(await asked.json()).toEqual({
        error: 'this server takes a file whole: PUT it to the upload link',
      });
      expect((await fetch(sub(upload.url, '/parts/1'), { method: 'PUT', body: 'x' })).status).toBe(
        404,
      );
      expect((await fetch(sub(upload.url, '/complete'), { method: 'POST' })).status).toBe(404);
      expect(await put(upload.url, Buffer.from('whole'))).toMatchObject({
        status: 200,
        complete: 'true',
      });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
