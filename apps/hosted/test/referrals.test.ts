import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { ADMIN_KEYS, AdminApi } from '../src/admin-api.ts';
import { AppsSeen } from '../src/apps-seen.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';
import { referralCode } from '../src/referral.ts';
import { Rights } from '../src/rights.ts';

// Every account has its own link. A shared watch page credits the owner with it; someone who
// opens it and signs up keeps the code as `referred_by` (the site's /callback writes it into the
// WorkOS metadata, as the stand-in below receives it); the admin API then shows the sign-up on
// both accounts. WorkOS is a stand-in answering the calls the server makes.

const ADMIN = 'user_01ADM1NABCDEFGHJKMNPQRSTVW';
const CREATOR = 'user_01CREATORABCDEFGHJKMNPQRST';
const VIEWER = 'user_01V1EWERABCDEFGHJKMNPQRSTV';
const IDLE = 'user_01SDLEABCDEFGHJKMNPQRSTVWX';
let base: string;
let server: Server;
let runtime: Runtime;
let adminKey: string;

type User = { id: string; email: string; created_at: string; metadata: Record<string, string> };
const users = new Map<string, User>(
  [
    { id: ADMIN, email: 'admin@example.com', created_at: '2026-10-01T00:00:00.000Z' },
    { id: CREATOR, email: 'creator@example.com', created_at: '2026-11-01T00:00:00.000Z' },
  ].map((u) => [u.id, { ...u, metadata: {} }]),
);

const realFetch = globalThis.fetch;
async function workos(url: URL, init?: RequestInit): Promise<Response> {
  if (url.pathname === '/user_management/users') {
    const limit = Number(url.searchParams.get('limit'));
    const after = url.searchParams.get('after');
    const all = [...users.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const from = after ? all.findIndex((u) => u.id === after) + 1 : 0;
    const data = all.slice(from, from + limit);
    const more = from + limit < all.length;
    return Response.json({ data, list_metadata: { after: more ? data.at(-1)?.id : null } });
  }
  const user = users.get(decodeURIComponent(url.pathname.split('/').pop() ?? ''));
  if (user && init?.method === 'PUT')
    user.metadata = JSON.parse(String(init.body)).metadata as Record<string, string>;
  return user ? Response.json(user) : Response.json({}, { status: 404 });
}

/** A new account, made the way the site's /callback leaves one after a visit to /r/<code>. */
async function signUp(id: string, code: string, extra: Record<string, string> = {}) {
  users.set(id, {
    id,
    email: `${id}@example.com`,
    created_at: new Date().toISOString(),
    metadata: {},
  });
  const res = await fetch(`https://api.workos.com/user_management/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      metadata: { source: `referral / ${code}`, referred_by: code, ...extra },
    }),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === 'api.workos.com' ? workos(url, init) : realFetch(input, init);
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-referrals-'));
  runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 1,
    outputUrlTtlMs: 600_000,
    maxDownloadBytes: 1024,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
  });
  await runtime.start({ sweep: false });
  const access = {
    balance: async () => ({ plan: 'free', left: 3, used: 0, free: 3, bought: 0 }),
    payments: async () => [],
  } as unknown as AccessCheck;
  const lifecycle = new Lifecycle({
    runtime,
    access,
    ledger: new Ledger('http://127.0.0.1:9', 'none'),
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
  });
  const rights = new Rights(runtime.ws);
  await rights.grant(ADMIN, 'admin', 'test', 'reads the accounts');
  const keys = new ScriptKeys(runtime.ws, ADMIN_KEYS);
  adminKey = (await keys.create(ADMIN, 'crm')).key;
  const admin = new AdminApi({
    runtime,
    lifecycle,
    access,
    apps: new AppsSeen(runtime.ws),
    keys,
    rights,
    publicUrl: 'https://api.example.com',
    accountUrl: 'https://cuttingfloor.ai/account',
  });
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
    route: async (req, res, url) =>
      (await admin.route(req, res, url)) || lifecycle.route(req, res, url),
    accountUrl: 'https://cuttingfloor.ai/account',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (runtime.config as { publicUrl: string }).publicUrl = base;
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

const api = async (path: string) =>
  (await fetch(`${base}/admin/v1${path}`, {
    headers: { authorization: `Bearer ${adminKey}` },
  }).then((r) => r.json())) as Record<string, unknown>;

describe('a personal link for every account', () => {
  it('makes one short, stable code from the account id, with nothing else in it', () => {
    const code = referralCode(CREATOR);
    expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
    expect(referralCode(CREATOR)).toBe(code);
    expect(referralCode(VIEWER)).not.toBe(code);
    expect(code).not.toContain('creator');
  });

  it('credits the owner on a shared watch page, and a sign-up through it shows on both accounts', async () => {
    // The creator's export, shared by its watch page.
    const job = await runtime.jobs.store.create({ owner: CREATOR, tool: 'export.video' });
    await runtime.outputs.write(CREATOR, job.id, 'short.mp4', 'video', 'export');
    const { pageUrl } = await runtime.signOutput(CREATOR, job.id, 'short.mp4');
    const page = await (await fetch(pageUrl)).text();
    const link = /<p class="made">Made with <a href="([^"]+)">cuttingfloor<\/a><\/p>/.exec(
      page,
    )?.[1];
    expect(link).toMatch(/^https:\/\/cuttingfloor\.ai\/r\/[0-9a-hjkmnp-tv-z]{8}$/);
    const code = link?.split('/').pop() ?? '';

    // A viewer opens the link and signs up, then edits and exports; another only signs up.
    await signUp(VIEWER, code, {
      first_tool_at: '2026-11-26T10:00:00.000Z',
      first_export_at: '2026-11-26T10:20:00.000Z',
    });
    await signUp(IDLE, code);

    const list = (await api('/accounts')) as { data: Array<Record<string, unknown>> };
    const byId = new Map(list.data.map((a) => [a.id, a.referral]));
    expect(byId.get(CREATOR)).toEqual({
      code,
      link,
      referred_by: null,
      referred_by_account: null,
      referred: { signed_up: 2, used_a_tool: 1, exported: 1 },
    });
    expect(byId.get(VIEWER)).toEqual({
      code: referralCode(VIEWER),
      link: `https://cuttingfloor.ai/r/${referralCode(VIEWER)}`,
      referred_by: code,
      referred_by_account: CREATOR,
      referred: { signed_up: 0, used_a_tool: 0, exported: 0 },
    });
    expect(byId.get(IDLE)).toMatchObject({ referred_by: code, referred_by_account: CREATOR });

    // One account by id says the same.
    expect((await api(`/accounts/${CREATOR}`)).referral).toEqual(byId.get(CREATOR));
    expect((await api(`/accounts/${VIEWER}`)).referral).toEqual(byId.get(VIEWER));
  });

  it('leaves the credit off a file that has no account behind it', async () => {
    const job = await runtime.jobs.store.create({ owner: 'local', tool: 'export.video' });
    await runtime.outputs.write('local', job.id, 'self.mp4', 'video', 'export');
    const { pageUrl } = await runtime.signOutput('local', job.id, 'self.mp4');
    expect(await (await fetch(pageUrl)).text()).not.toContain('Made with');
  });
});
