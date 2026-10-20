import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// The routes the site and Stripe call. Only what needs no live account is checked here: who may
// call them. The account rules themselves run against the real WorkOS and Stripe in
// scripts/smoke-account.ts.

const SECRET = 'whsec_test_0123456789';
const ACCOUNT_KEY = 'account-key-0123456789abcdef';
let base: string;
let server: Server;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-billing-'));
  const runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 1,
    outputUrlTtlMs: 60_000,
    maxDownloadBytes: 1024,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
  });
  await runtime.start({ sweep: false });
  const options = { workosKey: 'sk_test_none', stripeKey: 'sk_test_none' };
  const access = new AccessCheck({ ...options, accountUrl: 'https://cuttingfloor.ai/account' });
  const lifecycle = new Lifecycle({
    runtime,
    access,
    ...options,
    accountUrl: 'https://cuttingfloor.ai/account',
    welcomeUrl: 'https://cuttingfloor.ai/welcome',
    serverUrl: 'https://api.cuttingfloor.ai',
    stripeWebhookSecret: SECRET,
    accountKey: ACCOUNT_KEY,
  });
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
    route: (req, res, url) => lifecycle.route(req, res, url),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('Stripe webhook', () => {
  const event = JSON.stringify({ id: 'evt_1', type: 'ping', data: { object: { id: 'x' } } });

  it('refuses a call Stripe did not sign, or signed too long ago', async () => {
    const post = (signature?: string) =>
      fetch(`${base}/stripe/webhook`, {
        method: 'POST',
        body: event,
        headers: signature ? { 'stripe-signature': signature } : {},
      });
    expect((await post()).status).toBe(400);
    expect((await post(sign(event, undefined, 'whsec_someone_else'))).status).toBe(400);
    expect((await post(sign(event, Math.floor(Date.now() / 1000) - 3600))).status).toBe(400);
  });

  it('takes a signed event, and ignores one that is about no customer', async () => {
    const res = await fetch(`${base}/stripe/webhook`, {
      method: 'POST',
      body: event,
      headers: { 'stripe-signature': sign(event) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: true });
  });
});

describe('account usage', () => {
  it('answers only the site, with its key, and only for a WorkOS user id', async () => {
    const get = (key?: string, user = 'user_01ABCDEFGHJKMNPQRSTVWXYZ0') =>
      fetch(`${base}/account/usage?user=${user}`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      });
    expect((await get()).status).toBe(401);
    expect((await get('maintenance-key-0123456789abcdef')).status).toBe(401);
    expect((await get(ACCOUNT_KEY, 'ops')).status).toBe(400);
  });
});
