import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// Deleting a partner's user (DELETE /partner/users): when someone deletes their account in the
// partner's app (one-mcp, for Kazi and the Cutting Floor AI app), the same login's account here
// goes too, with everything kept for it. WorkOS is a stand-in, answering the calls the server
// makes; the real WorkOS runs in scripts/smoke-partner-keys.ts.

const SECRET = 'cfp_partner-secret-0123456789abcdef';
const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const DIRECT = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
const OTHER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ02';
let base: string;
let server: Server;
let dataDir: string;

// The stand-in WorkOS: users by id, as its user management API keeps them.
const users = new Map<string, { id: string; email: string; metadata: Record<string, string> }>();
const deleted: string[] = [];
let workosDown = false;
let deleteFails = false;
let made = 0;

const realFetch = globalThis.fetch;
async function workos(url: URL, init?: RequestInit): Promise<Response> {
  if (workosDown) return new Response('{}', { status: 500 });
  const reply = (body: unknown, status = 200) => Response.json(body, { status });
  const now = new Date().toISOString();
  if (url.pathname === '/user_management/users' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as {
      email: string;
      metadata: Record<string, string>;
    };
    const id = `user_01NEW${String(++made).padStart(21, '0')}`;
    users.set(id, { id, email: body.email, metadata: body.metadata });
    return reply({ id, email: body.email, metadata: body.metadata, created_at: now });
  }
  if (url.pathname === '/user_management/users') {
    const email = url.searchParams.get('email');
    const data = [...users.values()].filter((u) => !email || u.email === email);
    return reply({ data: data.map((u) => ({ ...u, created_at: now })), list_metadata: {} });
  }
  const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  const user = users.get(id);
  if (!user) return reply({}, 404);
  if (init?.method === 'DELETE') {
    if (deleteFails) return new Response('{}', { status: 500 });
    users.delete(id);
    deleted.push(id);
    return new Response(null, { status: 202 });
  }
  return reply({ ...user, created_at: now });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === 'api.workos.com' ? workos(url, init) : realFetch(input, init);
  });
  users.set(DIRECT, { id: DIRECT, email: 'signed-up-here@example.com', metadata: {} });
  users.set(OTHER, { id: OTHER, email: 'someone-else@example.com', metadata: {} });
  const dir = await mkdtemp(join(tmpdir(), 'cf-partner-users-'));
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
  const free = {
    allowed: true,
    plan: 'free',
    email: '',
    created_at: '2026-10-01T00:00:00.000Z',
  };
  const lifecycle = new Lifecycle({
    runtime,
    access: { get: async () => free, forget: () => undefined } as unknown as AccessCheck,
    ledger: new Ledger('http://127.0.0.1:9', 'none'),
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
    accountKey: ACCOUNT_KEY,
    keys,
    partners: new Map([[createHash('sha256').update(SECRET).digest('hex'), 'Kazi']]),
  });
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
    scriptKeys: keys,
    access: async () => undefined,
    route: (req, res, url) => lifecycle.route(req, res, url),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

const remove = (body: unknown, secret: string | null = SECRET, method = 'DELETE') =>
  fetch(`${base}/partner/users`, {
    method,
    headers: {
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

const provision = async (email: string, sub: string) =>
  (await (
    await fetch(`${base}/partner/keys`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, sub }),
    })
  ).json()) as { key: string; owner: string };

const v1 = async (key: string, tool: string, args: unknown = {}) =>
  fetch(`${base}/v1/${tool}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });

const exists = (...parts: string[]) =>
  readdir(join(dataDir, ...parts)).then(
    () => true,
    () => false,
  );

/** Files an account keeps besides what its tool calls write: media, an output, notices, email. */
async function holdings(owner: string): Promise<void> {
  const put = async (path: string, body: unknown) => {
    await mkdir(join(dataDir, path, '..'), { recursive: true });
    await writeFile(join(dataDir, path), JSON.stringify(body));
  };
  await put(`owners/${owner}/media/m_a/media.json`, { media_id: 'm_a' });
  await put(`owners/${owner}/outputs/j_a/out.mp4`, 'bytes');
  await put(`owners/${owner}/uploads/u_a/upload.json`, {});
  await put(`owners/${owner}/notices/welcome.json`, {});
  await put(`owners/${owner}/email/welcome.json`, { slot: 'welcome', outcome: 'sent' });
  await put(`owners/${owner}/ledger/link.json`, { account_id: 'acct_1' });
  await put(`email-log/2026-11-10/120000-${owner.slice(-4)}.json`, { subscriber: owner });
}

describe('deleting a partner user', () => {
  it('is refused without the partner secret, with another method or a bad body', async () => {
    const body = { email: 'signed-up-here@example.com', sub: 'platform-0' };
    expect((await remove(body, null)).status).toBe(401);
    expect((await remove(body, 'wrong')).status).toBe(401);
    expect((await remove(body, ACCOUNT_KEY)).status).toBe(401);
    expect((await remove(body, SECRET, 'POST')).status).toBe(405);
    expect((await remove({ email: 'not-an-email', sub: 'u1' })).status).toBe(400);
    expect((await remove({ email: 'signed-up-here@example.com' })).status).toBe(400);
    expect(users.has(DIRECT)).toBe(true);
    expect(deleted).toEqual([]);
  });

  it('answers 404 account_not_found for an email with no account', async () => {
    const res = await remove({ email: 'nobody-here@example.com', sub: 'platform-x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'account_not_found' });
  });

  it('deletes an account the partner made, with everything it keeps, and leaves others alone', async () => {
    const got = await provision('kazi.person@example.com', 'platform-1');
    const theirs = await provision('someone-else@example.com', 'platform-9');
    // Real data from tool calls: a timeline, and a cached frame of it.
    const tl = (await (
      await v1(got.key, 'timeline.create', {
        sequence: { width: 640, height: 360, fps: { num: 30, den: 1 } },
      })
    ).json()) as { timeline_id: string };
    expect(tl.timeline_id).toMatch(/^tl_/);
    await mkdir(join(dataDir, 'cache', 'frames'), { recursive: true });
    await writeFile(join(dataDir, 'cache', 'frames', `${tl.timeline_id}-0-640.webp`), 'x');
    await holdings(got.owner);
    await holdings(OTHER);
    const suppressed = createHash('sha256').update('kazi.person@example.com').digest('hex');
    await mkdir(join(dataDir, 'email-suppressions'), { recursive: true });
    await writeFile(join(dataDir, 'email-suppressions', `${suppressed}.json`), '{}');

    const res = await remove({ email: 'Kazi.Person@Example.com', sub: 'platform-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    expect(users.has(got.owner)).toBe(false);
    expect(deleted).toEqual([got.owner]);
    expect(await exists('owners', got.owner)).toBe(false);
    expect(await exists('partners', 'Kazi')).toBe(true);
    expect(await readdir(join(dataDir, 'partners', 'Kazi'))).toHaveLength(1);
    expect(await readdir(join(dataDir, 'cache', 'frames'))).toEqual([]);
    expect(await readdir(join(dataDir, 'email-log', '2026-11-10'))).toEqual([
      `120000-${OTHER.slice(-4)}.json`,
    ]);
    expect(await readdir(join(dataDir, 'email-suppressions'))).toEqual([]);
    // Its key stops at once; the other account's key and data stay.
    expect((await v1(got.key, 'media.list')).status).toBe(401);
    const seq = { sequence: { width: 640, height: 360, fps: { num: 30, den: 1 } } };
    expect((await v1(theirs.key, 'timeline.create', seq)).status).toBe(200);
    expect(await readdir(join(dataDir, 'keys'))).toHaveLength(1);
    expect(await exists('owners', OTHER, 'media', 'm_a')).toBe(true);
    expect(users.has(OTHER)).toBe(true);
  });

  it('answers 404 when called again for the same person', async () => {
    const res = await remove({ email: 'kazi.person@example.com', sub: 'platform-1' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'account_not_found' });
  });

  it('deletes an account made here directly, found by its email', async () => {
    await holdings(DIRECT);
    const res = await remove({ email: 'signed-up-here@example.com', sub: 'platform-2' });
    expect(res.status).toBe(200);
    expect(users.has(DIRECT)).toBe(false);
    expect(await exists('owners', DIRECT)).toBe(false);
  });

  it('deletes the account tied to the user id when the partner sends a changed email', async () => {
    const got = await provision('before@example.com', 'platform-3');
    await holdings(got.owner);
    const res = await remove({ email: 'after@example.com', sub: 'platform-3' });
    expect(res.status).toBe(200);
    expect(users.has(got.owner)).toBe(false);
    expect(await exists('owners', got.owner)).toBe(false);
    expect((await remove({ email: 'after@example.com', sub: 'platform-3' })).status).toBe(404);
  });

  it('answers 503 and deletes nothing when WorkOS cannot be read', async () => {
    const got = await provision('outage@example.com', 'platform-4');
    workosDown = true;
    try {
      expect((await remove({ email: 'outage@example.com', sub: 'platform-4' })).status).toBe(503);
    } finally {
      workosDown = false;
    }
    expect(users.has(got.owner)).toBe(true);
    expect((await v1(got.key, 'media.list')).status).toBe(200);
  });

  it('keeps the account findable when the WorkOS delete fails, so a retry finishes it', async () => {
    const got = await provision('retry@example.com', 'platform-5');
    await holdings(got.owner);
    deleteFails = true;
    try {
      expect((await remove({ email: 'retry@example.com', sub: 'platform-5' })).status).toBe(503);
    } finally {
      deleteFails = false;
    }
    expect(users.has(got.owner)).toBe(true);
    expect((await v1(got.key, 'media.list')).status).toBe(401);
    expect((await remove({ email: 'retry@example.com', sub: 'platform-5' })).status).toBe(200);
    expect(users.has(got.owner)).toBe(false);
    expect((await remove({ email: 'retry@example.com', sub: 'platform-5' })).status).toBe(404);
  });
});
