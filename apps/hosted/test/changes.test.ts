import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@cuttingfloor/core';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';

// POST /v1/floor.changes: an app holds it with the cursor it last saw instead of listing on a timer. It
// answers when the account's floor changes (here a real upload, sent through the tools, or a
// change another server wrote to the shared data root), or when the wait ends.

const USER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
const OTHER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ02';
const QUIET = 'user_01ABCDEFGHJKMNPQRSTVWXYZ03';
let base: string;
let server: Server;
let dataDir: string;
let key: string;
let otherKey: string;
let quietKey: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-changes-'));
  dataDir = join(dir, 'data');
  const runtime = new Runtime({
    dataDir,
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 1,
    outputUrlTtlMs: 60_000,
    maxDownloadBytes: 1024 ** 2,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
  });
  await runtime.start({ sweep: false });
  const keys = new ScriptKeys(runtime.ws);
  key = (await keys.create(USER, 'changes test')).key;
  otherKey = (await keys.create(OTHER, 'changes test')).key;
  quietKey = (await keys.create(QUIET, 'changes test')).key;
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    scriptKeys: keys,
    access: async () => undefined,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

type Answer = { cursor: string; changed: boolean };

const changes = async (body: Record<string, unknown>, bearer = key) =>
  fetch(`${base}/v1/floor.changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });

const cursorNow = async (bearer = key) =>
  ((await (await changes({}, bearer)).json()) as Answer).cursor;

const upload = async (name: string, bytes: number) => {
  const res = await fetch(`${base}/v1/media.upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ name, bytes }),
  });
  expect(res.status).toBe(200);
  const up = (await res.json()) as { upload_id: string; url: string };
  return { ...up, url: `${base}${new URL(up.url).pathname}${new URL(up.url).search}` };
};

describe('POST /v1/floor.changes', () => {
  it('answers at once with the cursor when no since is given', async () => {
    const res = await changes({ wait_seconds: 30 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Answer;
    expect(body).toEqual({ cursor: expect.any(String), changed: true });
  });

  it('wakes a held call when an upload starts and again when it completes', async () => {
    const since = await cursorNow();
    const started = Date.now();
    const held = changes({ since, wait_seconds: 30 });
    await new Promise((r) => setTimeout(r, 200));
    const up = await upload('a.bin', 4);
    const first = (await (await held).json()) as Answer;
    expect(first.changed).toBe(true);
    expect(first.cursor).not.toBe(since);
    expect(Date.now() - started).toBeLessThan(5000);

    // Unchanged since that answer: the next hold waits, then the PUT that completes it wakes it.
    const again = changes({ since: first.cursor, wait_seconds: 30 });
    await new Promise((r) => setTimeout(r, 200));
    const put = await fetch(up.url, { method: 'PUT', body: new Uint8Array([1, 2, 3, 4]) });
    expect(((await put.json()) as { complete: boolean }).complete).toBe(true);
    const second = (await (await again).json()) as Answer;
    expect(second.changed).toBe(true);
    expect(second.cursor).not.toBe(first.cursor);
    expect(await cursorNow()).toBe(second.cursor);

    // Importing it starts a job (and makes a media), which wakes the next hold.
    const third = changes({ since: second.cursor, wait_seconds: 30 });
    await new Promise((r) => setTimeout(r, 200));
    const imported = await fetch(`${base}/v1/media.import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ source: { upload_id: up.upload_id } }),
    });
    expect(((await imported.json()) as { job_id?: string }).job_id).toMatch(/^j_/);
    expect(((await (await third).json()) as Answer).changed).toBe(true);
  });

  it("hears a change another server wrote to the shared data root, and not another account's", async () => {
    // An account nothing else here touches, so only the write below can move it.
    const since = await cursorNow(quietKey);
    const otherSince = await cursorNow(otherKey);
    const held = changes({ since, wait_seconds: 30 }, quietKey);
    const otherHeld = changes({ since: otherSince, wait_seconds: 2 }, otherKey);
    await new Promise((r) => setTimeout(r, 200));
    // As another node would: its own Workspace over the same root, with no listener here.
    const elsewhere = new Workspace(dataDir);
    await elsewhere.writeJson(elsewhere.ownerDir(QUIET, 'floor.json'), { cursor: 'from-node-2' });
    expect(await (await held).json()).toEqual({ cursor: 'from-node-2', changed: true });
    expect(await (await otherHeld).json()).toEqual({ cursor: otherSince, changed: false });
  });

  it('answers changed: false when the wait ends with nothing new', async () => {
    const since = await cursorNow(otherKey);
    const started = Date.now();
    const body = (await (await changes({ since, wait_seconds: 1 }, otherKey)).json()) as Answer;
    expect(body).toEqual({ cursor: since, changed: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('refuses without a key, a wait over 100 s, a bad body, and any method but POST', async () => {
    expect((await fetch(`${base}/v1/floor.changes`, { method: 'POST' })).status).toBe(401);
    for (const body of [{ wait_seconds: 101 }, { since: 3 }, { wait_seconds: '5' }]) {
      const res = await changes(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('bad_request');
    }
    const notJson = await fetch(`${base}/v1/floor.changes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: '{',
    });
    expect(notJson.status).toBe(400);
    const get = await fetch(`${base}/v1/floor.changes`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(get.status).toBe(405);
  });

  it('is described in /openapi.json', async () => {
    const spec = (await (await fetch(`${base}/openapi.json`)).json()) as {
      paths: Record<string, { post?: { operationId: string } }>;
    };
    expect(spec.paths['/v1/floor.changes']?.post?.operationId).toBe('floor_changes');
  });
});
