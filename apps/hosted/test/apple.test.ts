import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JWSTransactionDecodedPayload } from '@apple/app-store-server-library';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { LOW_CREDITS } from '@cuttingfloor/plans';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessCheck } from '../src/access.ts';
import {
  AppleCredits,
  AppleRejected,
  type AppleVerifier,
  appleTokenFor,
  appleVerifier,
} from '../src/apple.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { FileLedger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// The Cutting Floor AI app's credits on /v1, with the key the app already calls /v1 with: the
// balance as it shows it, the App Store packs (cuttingfloor's packs as ai.cuttingfloor.app.<id>)
// and the appAccountToken; a purchase recorded once whether the app or Apple's notification
// comes first; a refund taking the pack back once. Apple's signature check is a stand-in here
// (payloads signed `apple`), except one forged payload put through the real check.

const OWNER = 'user_01APPLEBUYER00000000000001';
const OTHER = 'user_01APPLEOTHER00000000000001';
let base: string;
let server: Server;
let key: string;
let ledger: FileLedger;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jws = (payload: unknown, signature = 'apple') =>
  `${b64({ alg: 'ES256' })}.${b64(payload)}.${signature}`;
const decode = <T>(signed: string): T => {
  const [, payload, signature] = signed.split('.');
  if (signature !== 'apple') throw new AppleRejected('not signed by Apple');
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as T;
};
const verifier: AppleVerifier = {
  transaction: async (s) => decode<JWSTransactionDecodedPayload>(s),
  notification: async (s) => decode(s),
};
const tx = (id: string, owner = OWNER, extra: Record<string, unknown> = {}) =>
  jws({
    transactionId: id,
    originalTransactionId: id,
    productId: 'ai.cuttingfloor.app.cf_credits_10',
    appAccountToken: appleTokenFor(owner).toUpperCase(),
    environment: 'Sandbox',
    ...extra,
  });

const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'api.workos.com') {
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      return Promise.resolve(
        Response.json({
          id,
          email: `${id}@example.com`,
          email_verified: true,
          created_at: '2026-11-25T00:00:00.000Z',
          metadata: {},
        }),
      );
    }
    return realFetch(input, init);
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-apple-'));
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
  ledger = new FileLedger({ records: runtime.ws.records, low: LOW_CREDITS });
  const options = { workosKey: 'sk_test_none', stripeKey: 'sk_test_none' };
  const accountUrl = 'https://cuttingfloor.ai/account';
  const access = new AccessCheck({ ...options, ledger, accountUrl, ws: runtime.ws });
  const apple = new AppleCredits({ ledger, access, verifier });
  const lifecycle = new Lifecycle({ runtime, access, ledger, apple, ...options, accountUrl });
  const keys = new ScriptKeys(runtime.ws);
  key = (await keys.create(OWNER, 'phone')).key;
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    scriptKeys: keys,
    access: async (owner) => void (await access.require(owner)),
    credits: apple,
    route: (req, res, url) => lifecycle.route(req, res, url),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

const credits = (auth = key) =>
  fetch(`${base}/v1/credits`, { headers: { authorization: `Bearer ${auth}` } });
const buy = (signed: string) =>
  fetch(`${base}/v1/credits/apple`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ signed_transaction: signed }),
  });
const notify = (type: string, signed: string) =>
  fetch(`${base}/apple/notifications`, {
    method: 'POST',
    body: JSON.stringify({
      signedPayload: jws({
        notificationType: type,
        data: { environment: 'Sandbox', signedTransactionInfo: signed },
      }),
    }),
  });

describe('credits in the phone app', () => {
  it('shows the balance, the App Store packs and the account’s token, to the app’s own key', async () => {
    expect((await credits('cf_not_a_key')).status).toBe(401);
    const res = await credits();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      balance: 3,
      unmetered: false,
      low: true,
      out: false,
      apple_products: [
        { product_id: 'ai.cuttingfloor.app.cf_credits_5', credits: 25 },
        { product_id: 'ai.cuttingfloor.app.cf_credits_10', credits: 55 },
        { product_id: 'ai.cuttingfloor.app.cf_credits_25', credits: 150 },
        { product_id: 'ai.cuttingfloor.app.cf_credits_100', credits: 700 },
      ],
      apple_account_token: appleTokenFor(OWNER),
    });
  });

  it('records a purchase once, whether the app or Apple tells us first', async () => {
    const first = await buy(tx('2000000000000001'));
    expect(await first.json()).toEqual({ credits_added: 55, balance: 58 });
    expect(await (await buy(tx('2000000000000001'))).json()).toEqual({
      credits_added: 0,
      balance: 58,
    });
    expect((await notify('ONE_TIME_CHARGE', tx('2000000000000001'))).status).toBe(200);
    // Apple first this time, then the app.
    expect((await notify('ONE_TIME_CHARGE', tx('2000000000000002'))).status).toBe(200);
    expect(await (await buy(tx('2000000000000002'))).json()).toEqual({
      credits_added: 0,
      balance: 113,
    });
  });

  it('refuses a purchase made for another account, a revoked one, a product we don’t sell and a forgery', async () => {
    expect((await buy(tx('2000000000000003', OTHER))).status).toBe(403);
    expect((await buy(tx('2000000000000004', OWNER, { revocationDate: 1 }))).status).toBe(400);
    expect(
      (await buy(tx('2000000000000005', OWNER, { productId: 'com.other.coins' }))).status,
    ).toBe(400);
    expect((await buy(tx('2000000000000006').replace(/apple$/, 'forged'))).status).toBe(400);
    expect((await ledger.get(OWNER))?.balance).toBe(113);
    // The real check refuses a payload Apple did not sign.
    await expect(
      appleVerifier().transaction(
        jws(
          { environment: 'Sandbox', bundleId: 'ai.cuttingfloor.app', transactionId: '1' },
          'c2ln',
        ),
      ),
    ).rejects.toThrow(/signature check failed/);
  });

  it('describes both routes in the OpenAPI document, with the rest of /v1', async () => {
    const doc = (await (await fetch(`${base}/openapi.json`)).json()) as {
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    expect(doc.paths['/v1/credits']?.get?.operationId).toBe('credits_get');
    expect(doc.paths['/v1/credits/apple']?.post?.operationId).toBe('credits_apple');
  });

  it('takes a refunded pack back once', async () => {
    expect((await notify('REFUND', tx('2000000000000001'))).status).toBe(200);
    expect((await notify('REFUND', tx('2000000000000001'))).status).toBe(200);
    expect((await notify('REVOKE', tx('2000000000000009'))).status).toBe(200);
    expect((await notify('DID_RENEW', tx('2000000000000002'))).status).toBe(200);
    expect((await ledger.get(OWNER))?.balance).toBe(58);
    expect((await ledger.entries(OWNER)).map((e) => e.id).sort()).toEqual([
      'apple-refund:2000000000000001',
      'apple:2000000000000001',
      'apple:2000000000000002',
      'grant:activation',
    ]);
  });
});
