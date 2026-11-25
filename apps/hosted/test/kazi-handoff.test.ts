import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { CLAIMS, createServer, ONBOARDING, Runtime } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// The site's sign-up goes on into Kazi: the server reads the email from WorkOS and asks Kazi for
// a one-time link with its own key. WorkOS and Kazi are stand-ins here, answering what the server
// sends them; the real pair is probed end to end after both deploy.

const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const KAZI_KEY = 'kazi-service-key-0123456789';
const VERIFIED = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
const UNVERIFIED = 'user_01ABCDEFGHJKMNPQRSTVWXYZ02';
let base: string;
let server: Server;
let runtime: Runtime;

const users = new Map([
  [
    VERIFIED,
    {
      id: VERIFIED,
      email: 'maker@example.com',
      email_verified: true,
      first_name: 'Ada',
      last_name: 'Okafor',
      metadata: {},
    },
  ],
  [UNVERIFIED, { id: UNVERIFIED, email: 'who@example.com', email_verified: false, metadata: {} }],
]);
const asked: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
let kaziStatus = 200;

const realFetch = globalThis.fetch;
async function stand(url: URL, init?: RequestInit): Promise<Response> {
  if (url.hostname === 'api.workos.com') {
    const user = users.get(decodeURIComponent(url.pathname.split('/').pop() ?? ''));
    return Response.json(user ?? {}, { status: user ? 200 : 404 });
  }
  asked.push({
    auth: new Headers(init?.headers).get('authorization'),
    body: JSON.parse(String(init?.body)),
  });
  if (url.pathname !== '/api/partner/cuttingfloor/handoff')
    return new Response('{}', { status: 404 });
  if (kaziStatus !== 200) return Response.json({ error: 'no' }, { status: kaziStatus });
  return Response.json({
    url: 'https://app.apifunnel.ai/handoff/tok123',
    expires_at: '2026-11-24T23:02:00.000Z',
  });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === 'api.workos.com' || url.hostname === 'kazi.test'
      ? stand(url, init)
      : realFetch(input, init);
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-kazi-handoff-'));
  runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 1,
    outputUrlTtlMs: 60_000,
    maxDownloadBytes: 64 * 1024 ** 2,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
  });
  await runtime.start({ sweep: false });
  const lifecycle = new Lifecycle({
    runtime,
    access: { get: async () => undefined, forget: () => undefined } as unknown as AccessCheck,
    ledger: new Ledger('https://kazi.test', KAZI_KEY),
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
    accountKey: ACCOUNT_KEY,
  });
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
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

const handoff = (body: unknown, key = ACCOUNT_KEY) =>
  fetch(`${base}/account/kazi-handoff`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** credits.claim as Kazi's arrival call makes it, on the account's own connection. */
async function claim(owner: string): Promise<Record<string, unknown>> {
  const mcp = createServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => owner,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: 'kazi', version: '0' });
  await client.connect(clientSide);
  const res = (await client.callTool({
    name: 'credits.claim',
    arguments: { use_case: 'Kazi live demo: give the Big Buck Bunny ending a happier ending' },
  })) as { structuredContent: Record<string, unknown> };
  await client.close();
  return res.structuredContent;
}

describe('kazi handoff', () => {
  it('asks Kazi, with its key, for a link as the WorkOS email and answers it', async () => {
    asked.length = 0;
    const res = await handoff({ user: VERIFIED, share_code: 'PsFVYwBiOA', via: 'chatgpt' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: 'https://app.apifunnel.ai/handoff/tok123',
      expires_at: '2026-11-24T23:02:00.000Z',
    });
    expect(asked).toEqual([
      {
        auth: `Bearer ${KAZI_KEY}`,
        body: {
          email: 'maker@example.com',
          workos_user_id: VERIFIED,
          share_code: 'PsFVYwBiOA',
          name: 'Ada Okafor',
          via: 'chatgpt',
        },
      },
    ]);
  });

  it('activates the account with the demo clip in its library before Kazi opens', async () => {
    const res = await handoff({ user: VERIFIED, share_code: 'PsFVYwBiOA' });
    expect(res.status).toBe(200);
    const records = runtime.ws.records;
    expect(await records.collection(CLAIMS, { owner: VERIFIED }).get('free-credits')).toMatchObject(
      { use_case: 'Kazi live demo: give the Big Buck Bunny ending a happier ending' },
    );
    const named = await records.collection(ONBOARDING, { owner: VERIFIED }).get('onboarding');
    expect(named?.sample).toBe('kazi-demo');
    const clip = await runtime.media.get(VERIFIED, named?.media_id as string);
    expect(clip.name).toBe('big-buck-bunny-ending.mp4');
    // Kazi's arrival call finds it: already active, the same clip, no second import.
    const got = await claim(VERIFIED);
    expect(got).toMatchObject({ claimed_now: false, media_id: clip.media_id });
    expect(await runtime.media.list(VERIFIED)).toHaveLength(1);
    // A second hand-off keeps the clip it has.
    await handoff({ user: VERIFIED, share_code: 'PsFVYwBiOA' });
    expect(await runtime.media.list(VERIFIED)).toHaveLength(1);
  });

  it('leaves out a via that is not an app name, and still answers', async () => {
    asked.length = 0;
    const res = await handoff({ user: VERIFIED, share_code: 'PsFVYwBiOA', via: '../Evil App' });
    expect(res.status).toBe(200);
    expect(asked[0]?.body).not.toHaveProperty('via');
  });

  it('refuses a caller without the site key, a bad body or an unverified email, without asking Kazi', async () => {
    asked.length = 0;
    expect((await handoff({ user: VERIFIED, share_code: 'PsFVYwBiOA' }, 'wrong')).status).toBe(401);
    expect((await handoff({ user: 'nobody', share_code: 'PsFVYwBiOA' })).status).toBe(400);
    expect((await handoff({ user: VERIFIED, share_code: '../x' })).status).toBe(400);
    const res = await handoff({ user: UNVERIFIED, share_code: 'PsFVYwBiOA' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'email_unverified' });
    expect(asked).toHaveLength(0);
  });

  it('answers 502 when Kazi refuses, so the site sends them to the welcome page', async () => {
    kaziStatus = 502;
    const res = await handoff({ user: VERIFIED, share_code: 'PsFVYwBiOA' });
    kaziStatus = 200;
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(KAZI_KEY);
  });
});
