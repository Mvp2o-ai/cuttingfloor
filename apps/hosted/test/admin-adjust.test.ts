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
import { Lifecycle } from '../src/lifecycle.ts';
import { Rights } from '../src/rights.ts';
import { testLedger } from './test-ledger.ts';

// The admin API's one write, adjust_credits, and the site's door into the API: the site's own key
// with the signed-in person's id, checked against the rights table like an admin key. Over HTTP,
// on a real filesystem ledger; WorkOS is a stand-in answering the calls the server makes.

const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const ADMIN = 'user_01ADM1NABCDEFGHJKMNPQRSTVW';
const STRANGER = 'user_01STRANGERABCDEFGHJKMNPQRS';
const RICH = 'user_01R1CHABCDEFGHJKMNPQRSTVWX';
const FRESH = 'user_01FRESHABCDEFGHJKMNPQRSTVW';
let base: string;
let server: Server;
let rights: Rights;
let adminKey = '';
let strangerKey = '';

const users = new Map(
  [
    { id: ADMIN, email: 'ken@example.com', created_at: '2026-10-01T00:00:00.000Z', metadata: {} },
    {
      id: STRANGER,
      email: 'someone@example.com',
      created_at: '2026-10-05T00:00:00.000Z',
      metadata: { last_used_at: '2026-11-20T00:00:00.000Z' },
    },
    {
      id: RICH,
      email: 'rich@example.com',
      created_at: '2026-10-10T00:00:00.000Z',
      metadata: { last_used_at: '2026-11-01T00:00:00.000Z' },
    },
    { id: FRESH, email: 'fresh@example.com', created_at: '2026-11-20T00:00:00.000Z', metadata: {} },
  ].map((u) => [u.id, u]),
);

const realFetch = globalThis.fetch;
async function workos(url: URL): Promise<Response> {
  if (url.pathname === '/user_management/users') {
    const email = url.searchParams.get('email');
    const all = [...users.values()]
      .filter((u) => !email || u.email === email)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return Response.json({ data: all, list_metadata: { after: null } });
  }
  const user = users.get(decodeURIComponent(url.pathname.split('/').pop() ?? ''));
  return user ? Response.json(user) : Response.json({}, { status: 404 });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === 'api.workos.com' ? workos(url) : realFetch(input, init);
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-admin-adjust-'));
  const runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'https://api.example.com',
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
  const ledger = testLedger();
  const open = (owner: string) =>
    ledger.open(owner, async () => ({
      used_before: 0,
      entries: [{ id: 'grant:activation', kind: 'grant', credits: 3 }],
    }));
  // The rich account has used cuttingfloor and bought a pack; the fresh one never opened.
  await open(RICH);
  await ledger.credit(RICH, { id: 'pi_1', kind: 'purchase', credits: 100, pack: 'p100' });
  await open(STRANGER);
  const access = {
    opened: (owner: string) => ledger.get(owner),
    creditAccount: open,
    forget: () => undefined,
    balance: async (owner: string) => {
      const a = await open(owner);
      return {
        plan: 'free',
        left: a.balance,
        used: a.used_total,
        free: a.granted_total,
        bought: a.bought_total,
        per_month: null,
        renews: null,
      };
    },
    payments: async () => [],
  } as unknown as AccessCheck;
  const lifecycle = new Lifecycle({
    runtime,
    access,
    ledger,
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
  });
  rights = new Rights(runtime.ws);
  await rights.grant(ADMIN, 'admin', 'test', 'runs the admin page');
  const keys = new ScriptKeys(runtime.ws, ADMIN_KEYS);
  adminKey = (await keys.create(ADMIN, 'crm')).key;
  strangerKey = (await keys.create(STRANGER, 'made before any role')).key;
  const admin = new AdminApi({
    runtime,
    lifecycle,
    access,
    ledger,
    apps: new AppsSeen(runtime.ws),
    keys,
    rights,
    publicUrl: 'https://api.example.com',
    accountKey: ACCOUNT_KEY,
  });
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
    access: async () => undefined,
    route: async (req, res, url) =>
      (await admin.route(req, res, url)) || lifecycle.route(req, res, url),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

/** A call as an admin key makes it. */
const api = (path: string, init: { key?: string; body?: unknown; method?: string } = {}) =>
  fetch(`${base}/admin/v1${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
      'content-type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

/** A call as the site makes it for the person signed in. */
const site = (path: string, as: string, body?: unknown, key = ACCOUNT_KEY) =>
  fetch(`${base}/admin/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'x-cuttingfloor-admin': as,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const adjust = (owner: string, body: unknown, key = adminKey) =>
  api(`/accounts/${owner}/adjustments`, { key, body });

describe('who may call', () => {
  it('lets the site in only for an admin signed in on it', async () => {
    const ok = await site('/accounts?limit=10', ADMIN);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { total: number }).total).toBe(4);
    const refused = await site('/accounts', STRANGER);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'forbidden' } });
    // Naming an admin takes the site's key: an admin key, or no key, does not do.
    expect((await site('/accounts', ADMIN, undefined, adminKey)).status).toBe(401);
    expect((await site('/accounts', ADMIN, undefined, 'wrong-key-0123456789abcdef')).status).toBe(
      401,
    );
    expect((await site('/accounts', 'not-a-user')).status).toBe(401);
    // The site's key alone opens nothing.
    expect((await api('/accounts', { key: ACCOUNT_KEY })).status).toBe(401);
    // /me describes a key, which the site's calls don't have.
    expect((await site('/me', ADMIN)).status).toBe(400);
  });

  it('refuses a write without a key, or from an account that is not an admin', async () => {
    const body = { id: 'nope', credits: 5, reason: 'test' };
    expect((await adjust(RICH, body, '')).status).toBe(401);
    expect((await adjust(RICH, body, strangerKey)).status).toBe(403);
    expect((await site(`/accounts/${RICH}/adjustments`, STRANGER, body)).status).toBe(403);
    const ledger = (await (await api(`/accounts/${RICH}/ledger`, { key: adminKey })).json()) as {
      balance: number;
    };
    expect(ledger.balance).toBe(103);
  });
});

describe('adjust_credits', () => {
  it('writes an adjust entry with the admin and reason, once per id', async () => {
    const res = await adjust(RICH, {
      id: 'support-42',
      credits: 10,
      reason: 'export failed twice',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entry: {
        id: 'adjust:support-42',
        kind: 'adjust',
        credits: 10,
        at: expect.any(String),
        balance: 113,
        reason: 'export failed twice',
        by: ADMIN,
      },
      balance: 113,
      duplicate: false,
    });
    // A retry answers the first entry and adds nothing.
    const again = await adjust(RICH, {
      id: 'support-42',
      credits: 10,
      reason: 'export failed twice',
    });
    expect(await again.json()).toMatchObject({ balance: 113, duplicate: true });
    // The same id for something else is refused rather than passed off as the first.
    const other = await adjust(RICH, {
      id: 'support-42',
      credits: 20,
      reason: 'export failed twice',
    });
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: { code: 'conflict' } });

    const ledger = (await (await api(`/accounts/${RICH}/ledger`, { key: adminKey })).json()) as {
      opened: boolean;
      balance: number;
      entries: Array<{ id: string; kind: string; credits: number; by?: string }>;
    };
    expect(ledger.opened).toBe(true);
    expect(ledger.balance).toBe(113);
    // Newest first.
    expect(ledger.entries.map((e) => e.id)).toEqual([
      'adjust:support-42',
      'pi_1',
      'grant:activation',
    ]);
    expect(ledger.entries[0]).toMatchObject({ kind: 'adjust', credits: 10, by: ADMIN });
  });

  it('takes credits away, but never below zero', async () => {
    const over = await adjust(RICH, { id: 'too-much', credits: -500, reason: 'mistake' });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: 'insufficient' } });
    // From the site, for the admin signed in there: the entry names them.
    const taken = await site(`/accounts/${RICH}/adjustments`, ADMIN, {
      id: 'chargeback-1',
      credits: -13,
      reason: 'card charged back',
    });
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({
      entry: { credits: -13, by: ADMIN, reason: 'card charged back' },
      balance: 100,
    });
  });

  it('opens the ledger account of one that never used cuttingfloor', async () => {
    const before = await (await api(`/accounts/${FRESH}/ledger`, { key: adminKey })).json();
    expect(before).toEqual({ opened: false, balance: null, entries: [] });
    const res = await adjust(FRESH, { id: 'welcome', credits: 7, reason: 'beta tester' });
    expect(await res.json()).toMatchObject({ balance: 10, duplicate: false });
    const after = (await (await api(`/accounts/${FRESH}/ledger`, { key: adminKey })).json()) as {
      entries: Array<{ id: string }>;
    };
    expect(after.entries.map((e) => e.id)).toEqual(['adjust:welcome', 'grant:activation']);
  });

  it('refuses a malformed adjustment, an unknown account and the wrong method', async () => {
    for (const body of [
      { id: 'a', credits: 5 },
      { id: 'a', credits: 0, reason: 'zero' },
      { id: 'a', credits: 'five', reason: 'text' },
      { id: 'has space', credits: 5, reason: 'bad id' },
      { id: 'a', credits: 1_000_000, reason: 'too many' },
    ]) {
      const res = await adjust(RICH, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'bad_request' } });
    }
    const notJson = await fetch(`${base}/admin/v1/accounts/${RICH}/adjustments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminKey}` },
      body: 'credits=5',
    });
    expect(notJson.status).toBe(400);
    const missing = await adjust('user_01NOSUCHUSERABCDEFGHJKMN', {
      id: 'a',
      credits: 5,
      reason: 'nobody',
    });
    expect(missing.status).toBe(404);
    expect((await api(`/accounts/${RICH}/adjustments`, { key: adminKey })).status).toBe(405);
    expect((await api('/accounts', { key: adminKey, method: 'POST', body: {} })).status).toBe(405);
  });
});

describe('list_accounts search and sort', () => {
  const ids = async (query: string) =>
    (
      (await (await site(`/accounts?${query}`, ADMIN)).json()) as { data: Array<{ id: string }> }
    ).data.map((a) => a.id);

  it('finds accounts by part of an email or id', async () => {
    expect(await ids('q=RICH@')).toEqual([RICH]);
    expect(await ids('q=example.com')).toEqual([FRESH, RICH, STRANGER, ADMIN]);
    expect(await ids(`q=${STRANGER.slice(5, 15).toLowerCase()}`)).toEqual([STRANGER]);
  });

  it('sorts by last active and credits, with what lacks the fact last', async () => {
    expect(await ids('sort=last_active')).toEqual([STRANGER, RICH, FRESH, ADMIN]);
    // RICH holds 100, FRESH 10, STRANGER 3; ADMIN never opened a ledger account.
    expect(await ids('sort=credits')).toEqual([RICH, FRESH, STRANGER, ADMIN]);
    expect(await ids('sort=exports')).toEqual([FRESH, RICH, STRANGER, ADMIN]);
    const page = (await (await site('/accounts?sort=credits&limit=1&q=example', ADMIN)).json()) as {
      next: string;
    };
    expect(page.next).toBe(
      'https://api.example.com/admin/v1/accounts?limit=1&page=2&q=example&sort=credits',
    );
    expect((await site('/accounts?sort=biggest', ADMIN)).status).toBe(400);
  });

  it('stops the site for someone whose role is taken away', async () => {
    await rights.revoke(ADMIN, 'admin');
    expect((await site('/accounts', ADMIN)).status).toBe(403);
    expect((await adjust(RICH, { id: 'late', credits: 1, reason: 'after revoke' })).status).toBe(
      403,
    );
    await rights.grant(ADMIN, 'admin', 'test', 'back again');
  });
});
