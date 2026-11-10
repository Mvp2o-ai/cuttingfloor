import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';
import { WorkosSubscribers } from '../src/sequence.ts';

// Partner keys: a partner (one-mcp, for the Cutting Floor AI app) gets a script key for its user
// by email, and the key calls /mcp and /v1 as that account. WorkOS is a stand-in here, answering
// the calls the server makes; the real WorkOS runs in scripts/smoke-partner-keys.ts.

const SECRET = 'cfp_partner-secret-0123456789abcdef';
const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const EXISTING = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
let base: string;
let server: Server;
let dataDir: string;

// The stand-in WorkOS: users by id, as its user management API keeps them.
const users = new Map<string, { id: string; email: string; metadata: Record<string, string> }>();
const created: Array<Record<string, unknown>> = [];
let workosDown = false;
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
    created.push(body);
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
  if (init?.method === 'PUT') {
    user.metadata = (
      JSON.parse(String(init.body)) as { metadata: Record<string, string> }
    ).metadata;
  }
  return reply({ ...user, created_at: now });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === 'api.workos.com' ? workos(url, init) : realFetch(input, init);
  });
  users.set(EXISTING, { id: EXISTING, email: 'has-an-account@example.com', metadata: {} });
  const dir = await mkdtemp(join(tmpdir(), 'cf-partner-keys-'));
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
    lifetimeClients: new Map([['https://kazi.example/client', 'Kazi']]),
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

interface Provisioned {
  key: string;
  key_id: string;
  owner: string;
  expires_at: string;
  created: boolean;
}

const provision = (body: unknown, secret = SECRET) =>
  fetch(`${base}/partner/keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const site = (path: string) =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${ACCOUNT_KEY}` } });

describe('partner keys', () => {
  it('are refused without the partner secret, or with a bad body', async () => {
    const body = { email: 'someone@example.com', sub: 'u1' };
    expect((await provision(body, 'wrong')).status).toBe(401);
    expect((await provision(body, ACCOUNT_KEY)).status).toBe(401);
    expect((await provision({ email: 'not-an-email', sub: 'u1' })).status).toBe(400);
    expect((await provision({ email: 'someone@example.com' })).status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('make a verified lifetime account for a new email, and a key that calls /mcp and /v1', async () => {
    const res = await provision({ email: 'New.Person@Example.com', sub: 'platform-1' });
    expect(res.status).toBe(200);
    const got = (await res.json()) as Provisioned;
    expect(got.created).toBe(true);
    expect(got.key).toMatch(/^cf_/);
    expect(created).toEqual([
      {
        email: 'new.person@example.com',
        email_verified: true,
        metadata: expect.objectContaining({ plan: 'lifetime', plan_reason: 'made by Kazi' }),
      },
    ]);
    expect(users.get(got.owner)?.email).toBe('new.person@example.com');

    // The key works on /mcp as that account...
    const client = new Client({ name: 'kit', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${got.key}` } },
      }),
    );
    const listed = (await client.callTool({ name: 'media.list', arguments: {} })) as {
      isError?: boolean;
    };
    expect(listed.isError).toBeFalsy();
    await client.close();
    // ...and on /v1, as the phone calls it.
    const v1 = await fetch(`${base}/v1/media.list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${got.key}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(v1.status).toBe(200);

    // The account page shows it under the partner's name; only its SHA-256 is on disk.
    const keys = (await (await site(`/account/keys?user=${got.owner}`)).json()) as {
      keys: Array<{ key_id: string; label: string }>;
    };
    expect(keys.keys).toEqual([expect.objectContaining({ key_id: got.key_id, label: 'Kazi' })]);
    const files = (await readdir(dataDir, { recursive: true })) as string[];
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      const text = await readFile(join(dataDir, f), 'utf8').catch(() => '');
      expect(text).not.toContain(got.key);
      expect(text).not.toContain('platform-1');
    }
  });

  it('use the account an email already has, giving it lifetime', async () => {
    const got = (await (
      await provision({ email: 'has-an-account@example.com', sub: 'platform-2' })
    ).json()) as Provisioned;
    expect(got).toMatchObject({ owner: EXISTING, created: false });
    expect(created).toHaveLength(1);
    expect(users.get(EXISTING)?.metadata).toMatchObject({
      plan: 'lifetime',
      plan_reason: 'via Kazi',
    });
  });

  it('rotate: a second call makes a new key and the first stops working', async () => {
    const body = { email: 'has-an-account@example.com', sub: 'platform-2' };
    const first = (await (await provision(body)).json()) as Provisioned;
    const second = (await (await provision(body)).json()) as Provisioned;
    expect(second.key).not.toBe(first.key);
    expect(second.owner).toBe(first.owner);
    const call = (key: string) =>
      fetch(`${base}/v1/media.list`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: '{}',
      });
    expect((await call(first.key)).status).toBe(401);
    expect((await call(second.key)).status).toBe(200);
    const keys = (await (await site(`/account/keys?user=${EXISTING}`)).json()) as {
      keys: unknown[];
    };
    expect(keys.keys).toHaveLength(1);
  });

  it('refuse a user id arriving with another email, and an email arriving with another user id', async () => {
    const moved = await provision({ email: 'someone-else@example.com', sub: 'platform-2' });
    expect(moved.status).toBe(409);
    const taken = await provision({ email: 'has-an-account@example.com', sub: 'platform-3' });
    expect(taken.status).toBe(409);
    expect(users.size).toBe(2);
  });

  it('answer 503 when WorkOS cannot be reached, and make no key', async () => {
    workosDown = true;
    try {
      const res = await provision({ email: 'later@example.com', sub: 'platform-4' });
      expect(res.status).toBe(503);
    } finally {
      workosDown = false;
    }
  });

  it('leave accounts a partner made out of our sign-up email', async () => {
    const welcomed: string[] = [];
    for await (const user of new WorkosSubscribers('sk_test_none').createdSince(0))
      welcomed.push(user.email);
    expect(welcomed).toContain('has-an-account@example.com');
    expect(welcomed).not.toContain('new.person@example.com');
  });
});
