import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import type { AccountGetResult } from '@cuttingfloor/schema';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { ACTIVATION_FROM, Lifecycle } from '../src/lifecycle.ts';
import { testLedger } from './test-ledger.ts';

// Activation (credits.claim) is for new accounts. One that ran a tool before activation existed
// was refused "This account isn't activated yet" on 2026-11-23 (three returning users); it must
// work as ever, without the refusal or the welcome. WorkOS is a stand-in holding each account's
// metadata.

const OLD = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
const NEW = 'user_01ABCDEFGHJKMNPQRSTVWXYZ02';
const users = new Map<string, Record<string, string>>([
  [OLD, { first_tool_at: new Date(ACTIVATION_FROM - 86_400_000).toISOString() }],
  [NEW, {}],
]);

let base: string;
let server: Server;
let keys: ScriptKeys;
const realFetch = globalThis.fetch;

async function workos(url: URL, init?: RequestInit): Promise<Response> {
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
  const dir = await mkdtemp(join(tmpdir(), 'cf-claim-gate-'));
  const runtime = new Runtime({
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
  const lifecycle = new Lifecycle({
    runtime,
    access: { get: async () => ({ allowed: false }) } as unknown as AccessCheck,
    ledger: testLedger(),
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
  });
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    scriptKeys: keys,
    access: async () => undefined,
    account: async () => ({}) as AccountGetResult,
    activeBefore: (owner) => lifecycle.activeBefore(owner),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

async function connect(owner: string): Promise<Client> {
  const { key } = await keys.create(owner, 'test');
  const client = new Client({ name: 'test-app', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

describe('activation', () => {
  it('lets an account active before activation work as ever, with no welcome', async () => {
    const client = await connect(OLD);
    expect(client.getInstructions()).not.toMatch(/credits\.claim/);
    const listed = await client.callTool({ name: 'media.list', arguments: {} });
    expect(listed.isError).toBeFalsy();
    await client.close();
  });

  it('still asks a new account to activate', async () => {
    const client = await connect(NEW);
    const listed = await client.callTool({ name: 'media.list', arguments: {} });
    expect(listed.isError).toBe(true);
    expect(JSON.stringify(listed.content)).toContain('claim_required');
    await client.close();
  });
});
