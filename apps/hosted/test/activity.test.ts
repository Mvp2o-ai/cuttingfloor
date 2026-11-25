import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Activity } from '../src/activity.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { type ActivityCall, Ledger } from '../src/ledger.ts';

// Every tool call a signed-in account makes reaches Kazi's admin page (activity contract v1):
// free or failed, with the app it came from and an error's code, never a tool list or a
// connection. Kazi is a stand-in that records calls by id, as the contract says, and can fail.

const USER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
const GONE = 'user_01GONEGONEGONEGONEGONEGO01';
const LEDGER_KEY = 'ledger-key-0123456789abcdef';
let base: string;
let server: Server;
let keys: ScriptKeys;
let activity: Activity;

// The stand-in Kazi: calls recorded by id, and how many requests came.
const recorded = new Map<string, ActivityCall & { workos_user_id: string; account_id?: string }>();
let requests = 0;
let failNext = 0;

const realFetch = globalThis.fetch;
function kazi(url: URL, init?: RequestInit): Response {
  if (url.pathname !== '/api/credits/activity' || init?.method !== 'POST')
    return Response.json({ error: 'not found' }, { status: 404 });
  if (new Headers(init.headers).get('authorization') !== `Bearer ${LEDGER_KEY}`)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  requests++;
  if (failNext > 0) {
    failNext--;
    return Response.json({ error: 'down' }, { status: 503 });
  }
  const body = JSON.parse(String(init.body)) as {
    workos_user_id?: string;
    account_id?: string;
    calls?: ActivityCall[];
  };
  if (!body.workos_user_id || !body.calls?.length || body.calls.length > 100)
    return Response.json({ error: 'bad shape' }, { status: 400 });
  if (body.workos_user_id === GONE)
    return Response.json({ error: 'credit account not found' }, { status: 404 });
  let duplicates = 0;
  for (const call of body.calls) {
    if (recorded.has(call.id)) duplicates++;
    else
      recorded.set(call.id, {
        ...call,
        workos_user_id: body.workos_user_id,
        ...(body.account_id ? { account_id: body.account_id } : {}),
      });
  }
  return Response.json({ recorded: body.calls.length - duplicates, duplicates });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === 'kazi.test' ? kazi(url, init) : realFetch(input, init);
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-activity-'));
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
  activity = new Activity({
    ledger: new Ledger('http://kazi.test', LEDGER_KEY),
    accountOf: (owner) => (owner === USER ? 'acct_1' : undefined),
    flushMs: 60_000,
    retryMs: [10, 10],
  });
  runtime.onToolCall((owner, entry) => activity.called(owner, entry));
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
    scriptKeys: keys,
    access: async () => undefined,
    onApp: (owner, app, from) => activity.usedFrom(owner, app, from),
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

describe('tool activity', () => {
  it('tells Kazi every tool call, worked or refused, once each, through an outage', async () => {
    const client = await connect(USER);
    await client.listTools();
    await client.callTool({ name: 'media.list', arguments: {} });
    await client.callTool({ name: 'media.get', arguments: { media_id: 'no-such-media' } });
    await expect(client.callTool({ name: 'no.such_tool', arguments: {} })).rejects.toThrow();
    await client.close();

    // Kazi is down for the first try; the batch goes again with the same ids.
    failNext = 1;
    await activity.flush();
    expect(requests).toBe(2);
    const calls = [...recorded.values()].filter((c) => c.workos_user_id === USER);
    expect(calls.map((c) => c.tool)).toEqual(['media.list', 'media.get', 'no.such_tool']);
    for (const call of calls) {
      expect(call).toMatchObject({ client: 'test-app', account_id: 'acct_1' });
      expect(call.duration_ms).toBeGreaterThanOrEqual(0);
      expect(Date.parse(call.at)).not.toBeNaN();
    }
    expect(calls[0]).toMatchObject({ ok: true });
    expect(calls[0]?.error).toBeUndefined();
    // An error's code, never its message (which can echo what was sent).
    expect(calls[1]).toMatchObject({ ok: false, error: 'invalid_call' });
    expect(calls[2]).toMatchObject({ ok: false, error: 'protocol_error' });
    expect(new Set(calls.map((c) => c.id)).size).toBe(3);

    // Nothing waiting: nothing sent.
    await activity.flush();
    expect(requests).toBe(2);
  });

  it('drops a batch Kazi has no account for, without retrying or holding up the call', async () => {
    const before = requests;
    const client = await connect(GONE);
    const result = await client.callTool({ name: 'media.list', arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
    await activity.flush();
    expect(requests - before).toBe(1);
    expect([...recorded.values()].some((c) => c.workos_user_id === GONE)).toBe(false);
  });
});
