import { mkdtemp, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import type { Job } from '@cuttingfloor/jobs';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AccessCheck, linkPath } from '../src/access.ts';
import { ADMIN_KEYS, AdminApi, adminOpenApi } from '../src/admin-api.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';
import { Rights } from '../src/rights.ts';

// The admin API: an admin makes a key on the site, the key reads accounts, and the role is
// checked from cuttingfloor's own rights table on every call. WorkOS is a stand-in answering the
// calls the server makes.

const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const ADMIN = 'user_01ADM1NABCDEFGHJKMNPQRSTVW';
const NEVER_USED = 'user_01NEVERUSEDABCDEFGHJKMNPQR';
const ACTIVE = 'user_01ACT1VEABCDEFGHJKMNPQRSTV';
const DAY = 86_400_000;
let base: string;
let server: Server;
let runtime: Runtime;
let rights: Rights;
let scriptKeys: ScriptKeys;

const users = new Map<
  string,
  { id: string; email: string; created_at: string; metadata: Record<string, string> }
>([
  [
    ADMIN,
    { id: ADMIN, email: 'ken@example.com', created_at: '2026-10-01T00:00:00.000Z', metadata: {} },
  ],
  [
    ACTIVE,
    {
      id: ACTIVE,
      email: 'Active@Example.com',
      created_at: '2026-11-02T00:00:00.000Z',
      metadata: {
        first_call_at: '2026-11-02T01:00:00.000Z',
        first_tool_at: '2026-11-02T01:05:00.000Z',
        first_client: 'claude',
        last_used_at: '2026-11-19T10:00:00.000Z',
        expiry_emails: 'off',
      },
    },
  ],
  [
    NEVER_USED,
    {
      id: NEVER_USED,
      email: 'never@example.com',
      created_at: '2026-11-03T00:00:00.000Z',
      metadata: { plan_reason: 'made by Kazi' },
    },
  ],
]);

const realFetch = globalThis.fetch;
async function workos(url: URL): Promise<Response> {
  if (url.pathname === '/user_management/users') {
    const email = url.searchParams.get('email');
    const limit = Number(url.searchParams.get('limit'));
    const after = url.searchParams.get('after');
    const all = [...users.values()]
      .filter((u) => !email || u.email.toLowerCase() === email)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const from = after ? all.findIndex((u) => u.id === after) + 1 : 0;
    const data = all.slice(from, from + limit);
    const more = from + limit < all.length;
    return Response.json({ data, list_metadata: { after: more ? data.at(-1)?.id : null } });
  }
  const user = users.get(decodeURIComponent(url.pathname.split('/').pop() ?? ''));
  return user ? Response.json(user) : Response.json({}, { status: 404 });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === 'api.workos.com' ? workos(url) : realFetch(input, init);
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-admin-api-'));
  runtime = new Runtime({
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
  rights = new Rights(runtime.ws);
  scriptKeys = new ScriptKeys(runtime.ws);
  const access = {
    balance: async () => ({
      plan: 'credits',
      left: 12.5,
      used: 17.5,
      free: 25,
      bought: 5,
      per_month: null,
      renews: null,
    }),
  } as unknown as AccessCheck;
  const lifecycle = new Lifecycle({
    runtime,
    access,
    ledger: new Ledger('http://127.0.0.1:9', 'none'),
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
  });
  const admin = new AdminApi({
    runtime,
    lifecycle,
    access,
    keys: new ScriptKeys(runtime.ws, ADMIN_KEYS),
    rights,
    publicUrl: 'https://api.example.com',
    accountKey: ACCOUNT_KEY,
  });
  // The active account holds a file and an export, and is on the credit ledger.
  const now = Date.now();
  const media = runtime.media.list.bind(runtime.media);
  runtime.media.list = (async (owner: string) =>
    owner === ACTIVE
      ? [{ media_id: 'm_1', name: 'talk.mp4', expires_at: new Date(now + 3 * DAY).toISOString() }]
      : media(owner)) as typeof runtime.media.list;
  const jobs = runtime.jobs.store.list.bind(runtime.jobs.store);
  runtime.jobs.store.list = (async (owner: string, query: Parameters<typeof jobs>[1]) =>
    owner === ACTIVE
      ? [
          {
            id: 'j_1',
            tool: 'export.video',
            status: 'completed',
            lastUpdatedAt: new Date(now - 6 * DAY).toISOString(),
            ttlMs: 7 * DAY,
            result: {
              structuredContent: { url: 'https://api.example.com/outputs/x/j_1/short.mp4?exp=1' },
            },
          } as unknown as Job,
        ]
      : jobs(owner, query)) as typeof runtime.jobs.store.list;
  await runtime.ws.writeJson(linkPath(runtime.ws, ACTIVE), { account_id: 'acct_1' });
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
    scriptKeys,
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

const site = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${ACCOUNT_KEY}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const api = (path: string, key?: string) =>
  fetch(`${base}/admin/v1${path}`, key ? { headers: { authorization: `Bearer ${key}` } } : {});

let adminKey = '';

describe('admin API', () => {
  it('publishes its OpenAPI document without a key, as reviewed', async () => {
    const res = await api('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { servers: Array<{ url: string }> };
    expect(doc.servers).toEqual([{ url: 'https://api.example.com/admin/v1' }]);
    // The committed document is the contract: a schema change shows up in review.
    const committed = JSON.parse(
      await readFile(new URL('../admin-openapi.json', import.meta.url), 'utf8'),
    );
    expect(adminOpenApi('https://api.cuttingfloor.ai')).toEqual(committed);
    expect(JSON.stringify(committed)).not.toContain('"additionalProperties":false');
  });

  it('makes admin keys only for admins, from the site', async () => {
    expect((await fetch(`${base}/account/admin-keys?user=${ADMIN}`)).status).toBe(401);
    expect(await (await site(`/account/admin-keys?user=${ADMIN}`)).json()).toEqual({
      admin: false,
      keys: [],
    });
    expect((await site('/account/admin-keys', { user: ADMIN, label: 'crm' })).status).toBe(403);

    await rights.grant(ADMIN, 'admin', 'test', 'the only admin');
    const made = await site('/account/admin-keys', { user: ADMIN, label: 'crm' });
    expect(made.status).toBe(200);
    const key = (await made.json()) as { key: string; key_id: string };
    expect(key.key.startsWith('cfa_')).toBe(true);
    adminKey = key.key;
    const listed = (await (await site(`/account/admin-keys?user=${ADMIN}`)).json()) as {
      admin: boolean;
      keys: Array<{ key_id: string; label: string }>;
    };
    expect(listed.admin).toBe(true);
    expect(listed.keys).toEqual([expect.objectContaining({ key_id: key.key_id, label: 'crm' })]);
  });

  it('refuses calls without an admin key, and a script key', async () => {
    const none = await api('/me');
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const script = await scriptKeys.create(ADMIN, 'scripts');
    expect((await api('/me', script.key)).status).toBe(401);
    // And an admin key never reaches the tools.
    const tools = await fetch(`${base}/v1/media.list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(tools.status).toBe(401);
  });

  it('says whose key it is', async () => {
    const me = await (await api('/me', adminKey)).json();
    expect(me).toMatchObject({ user: ADMIN, email: 'ken@example.com', roles: ['admin'] });
    expect(me.key.key_id).toMatch(/^k_/);
    expect(Date.parse(me.key.expires_at)).toBeGreaterThan(Date.now());
  });

  it('lists accounts newest first, as facts, a page at a time', async () => {
    const first = await api('/accounts?limit=2', adminKey);
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      data: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    expect(page.data.map((a) => a.id)).toEqual([NEVER_USED, ACTIVE]);
    const [never, active] = page.data;
    expect(never).toMatchObject({
      first_tool_at: null,
      made_by: 'Kazi',
      credits: null,
      files: [],
      next_expiry_at: null,
      email_prefs: { expiry_emails: true, unsubscribed: false, suppressed: null },
    });
    expect(active).toMatchObject({
      email: 'Active@Example.com',
      first_tool_at: '2026-11-02T01:05:00.000Z',
      first_client: 'claude',
      last_used_at: '2026-11-19T10:00:00.000Z',
      made_by: null,
      credits: { plan: 'credits', left: 12.5, bought: 5 },
      email_prefs: { expiry_emails: false },
    });
    // Soonest to go first; the export (made 6 days ago, kept 7) goes before the media.
    const files = active?.files as Array<{
      kind: string;
      expires_at: string;
      download_url: string | null;
    }>;
    expect(files.map((f) => f.kind)).toEqual(['export', 'media']);
    expect(files.every((f) => f.download_url === null)).toBe(true);
    expect(active?.next_expiry_at).toBe(files[0]?.expires_at);

    const rest = (await (
      await api(`/accounts?limit=2&cursor=${page.next_cursor}`, adminKey)
    ).json()) as { data: Array<{ id: string }>; next_cursor: string | null };
    expect(rest.data.map((a) => a.id)).toEqual([ADMIN]);
    expect(rest.next_cursor).toBeNull();
  });

  it('finds an account by email, and one by id with export links', async () => {
    const found = (await (await api('/accounts?email=active@example.com', adminKey)).json()) as {
      data: Array<{ id: string }>;
    };
    expect(found.data.map((a) => a.id)).toEqual([ACTIVE]);
    expect((await api('/accounts?limit=500', adminKey)).status).toBe(400);

    const one = (await (await api(`/accounts/${ACTIVE}`, adminKey)).json()) as {
      files: Array<{ kind: string; download_url: string | null }>;
    };
    const exported = one.files.find((f) => f.kind === 'export');
    expect(exported?.download_url).toMatch(/\/outputs\/.+\/j_1\/short\.mp4\?exp=\d+&sig=/);
    expect((await api('/accounts/user_01NOSUCHUSERABCDEFGHJKMN', adminKey)).status).toBe(404);
  });

  it('stops every key of a user whose role is taken away', async () => {
    await rights.revoke(ADMIN, 'admin');
    const refused = await api('/me', adminKey);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await site('/account/admin-keys', { user: ADMIN })).status).toBe(403);
  });
});
