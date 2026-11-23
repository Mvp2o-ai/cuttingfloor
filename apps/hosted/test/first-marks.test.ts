import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import type { AccountGetResult } from '@cuttingfloor/schema';
import { CLAIM_GUIDED, Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// The first-use marks on an account's WorkOS metadata. An app's first request marks two of them
// at once (`first_call_at` and `first_client`), and WorkOS replaces the metadata whole on each
// update, so writes that overlapped erased each other (two accounts on 2026-11-13). WorkOS is a
// stand-in that replaces metadata the same way and answers slowly enough for writes to overlap.

const USER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
let base: string;
let server: Server;
let keys: ScriptKeys;
let runtime: Runtime;
let lifecycle: Lifecycle;

const users = new Map<string, Record<string, string>>([[USER, {}]]);

const realFetch = globalThis.fetch;
async function workos(url: URL, init?: RequestInit): Promise<Response> {
  await new Promise((r) => setTimeout(r, 30));
  const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  const metadata = users.get(id);
  if (!metadata) return Response.json({}, { status: 404 });
  if (init?.method === 'PUT') {
    const body = JSON.parse(String(init.body)) as { metadata: Record<string, string> };
    users.set(id, { ...body.metadata });
  }
  return Response.json({ id, email: 'someone@example.com', metadata: users.get(id) });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === 'api.workos.com' ? workos(url, init) : realFetch(input, init);
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-first-marks-'));
  runtime = new Runtime({
    dataDir: join(dir, 'data'),
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
  keys = new ScriptKeys(runtime.ws);
  lifecycle = new Lifecycle({
    runtime,
    access: { get: async () => ({ allowed: false }) } as unknown as AccessCheck,
    ledger: new Ledger('http://127.0.0.1:9', 'none'),
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
  });
  lifecycle.start();
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
    scriptKeys: keys,
    access: async () => undefined,
    onCall: (owner) => lifecycle.called(owner),
    onApp: (owner, app) => lifecycle.usedFrom(owner, app),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

async function settled(fields: string[]): Promise<Record<string, string>> {
  for (let i = 0; i < 100; i++) {
    const metadata = users.get(USER) ?? {};
    if (fields.every((f) => metadata[f])) return metadata;
    await new Promise((r) => setTimeout(r, 20));
  }
  return users.get(USER) ?? {};
}

describe('first-use marks', () => {
  it('keeps every mark when an app connects, and marks the first tool call apart', async () => {
    const { key } = await keys.create(USER, 'test');
    const client = new Client({ name: 'test-app', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    const connected = await settled(['first_call_at', 'first_client']);
    expect(connected.first_call_at).toBeTruthy();
    expect(connected.first_client).toBe('test-app');
    // Connecting and listing tools is not using one.
    await client.listTools();
    await new Promise((r) => setTimeout(r, 200));
    expect(users.get(USER)?.first_tool_at).toBeUndefined();

    await client.callTool({ name: 'media.list', arguments: {} });
    const used = await settled(['first_tool_at', 'last_used_at']);
    expect(used).toMatchObject({ first_client: 'test-app' });
    // The day of the latest tool call, for the admin API's last_used_at.
    expect(used.last_used_at?.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(used.first_call_at).toBeTruthy();
    expect(used.first_tool_at).toBeTruthy();
    await client.close();
  });

  it("counts only an account's first-ever connection as having had the welcome", async () => {
    const ACCOUNT: AccountGetResult = {
      plan: 'free',
      plan_name: 'Free',
      credits: { left: 25, used: 0, free: 25, bought: 0, per_month: null, renews: null },
      warnings: [],
      top_up: null,
      packs: [],
      limits: { export_short_side: null, storage_gb: null },
      account_url: null,
    };
    const fresh = 'user_01ABCDEFGHJKMNPQRSTVWXYZ04';
    const old = 'user_01ABCDEFGHJKMNPQRSTVWXYZ05';
    users.set(fresh, {});
    users.set(old, { first_call_at: '2026-11-01T00:00:00.000Z' });
    const welcoming = createHttpServer({
      runtime,
      credentials: new LocalCredentialStore({}, false),
      scriptKeys: keys,
      access: async () => undefined,
      account: async () => ACCOUNT,
      onCall: (owner) => lifecycle.called(owner),
      firstConnection: (owner) => lifecycle.firstConnection(owner),
    });
    await new Promise<void>((r) => welcoming.listen(0, '127.0.0.1', r));
    const url = new URL(`http://127.0.0.1:${(welcoming.address() as AddressInfo).port}/mcp`);
    const firstResult = async (owner: string) => {
      const { key } = await keys.create(owner, 'test');
      const client = new Client({ name: 'test-app', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${key}` } },
        }),
      );
      const res = await client.callTool({ name: 'media.list', arguments: {} });
      await client.close();
      return (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    };
    const guided = (owner: string) =>
      runtime.ws.records.collection(CLAIM_GUIDED, { owner }).has('claim-guided');
    try {
      // A new account's connection had the welcome fresh: its first result doesn't repeat it.
      expect(await firstResult(fresh)).not.toContain("aren't activated yet");
      expect(await guided(fresh)).toBe(true);
      // An account that connected before may be on a host's cached instructions: its first
      // result here carries the guidance.
      expect(await firstResult(old)).toContain("aren't activated yet");
    } finally {
      await new Promise((r) => welcoming.close(r));
    }
  });
});
