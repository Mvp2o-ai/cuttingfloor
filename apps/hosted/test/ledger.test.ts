import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoRecords } from '@cuttingfloor/core';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { LOW_CREDITS } from '@cuttingfloor/plans';
import { type MeterEntry, Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessCheck } from '../src/access.ts';
import type { Mailer } from '../src/email.ts';
import { createHttpServer } from '../src/http.ts';
import { FileLedger, type Ledger, MongoLedger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';
import { MONGO_TEST_TIMEOUT_MS, mongoReachable, TEST_MONGODB_URI, testDatabase } from './mongo.ts';

// Credits in cuttingfloor's own ledger, through the routes the site, Stripe and the release page
// call: an account opens once (the activation grant, and an old account's carried balance and
// packs), making spends nothing, a clean copy is spent once and never past zero, a crossing is
// emailed or tops up on the saved card (once, and a failure is not retried), and Stripe's events
// and checkout's return credit packs and take back refunds once. WorkOS and Stripe are stand-ins
// answering as their APIs do. The whole suite runs on the filesystem ledger and on MongoDB
// (scripts/test-mongo.sh).

const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const SECRET = 'whsec_test_0123456789';
const NEW = 'user_01NEWACCOUNT00000000000001';
const OLD = 'user_01OLDACCOUNT00000000000001';
const LIFETIME = 'user_01LIFETIME0000000000000001';
const MARK = '\n[cuttingfloor watermark]';

// The stand-in WorkOS: users by id.
const users = new Map<
  string,
  { email: string; created_at: string; metadata: Record<string, string> }
>([
  [NEW, { email: 'new@example.com', created_at: '2026-11-25T00:00:00.000Z', metadata: {} }],
  [
    OLD,
    {
      email: 'old@example.com',
      created_at: '2026-10-01T00:00:00.000Z',
      metadata: { stripe_customer_id: 'cus_old' },
    },
  ],
  [
    LIFETIME,
    {
      email: 'life@example.com',
      created_at: '2026-10-01T00:00:00.000Z',
      metadata: { plan: 'lifetime' },
    },
  ],
]);

interface Pi {
  id: string;
  status: string;
  created: number;
  amount_received: number;
  customer: string;
  metadata: Record<string, string>;
}

/** The stand-in Stripe's state, fresh for each store's run. */
function stripeState() {
  const pi = (
    id: string,
    customer: string,
    credits: number,
    cents: number,
    owner: string,
    app = 'cuttingfloor',
  ): Pi => ({
    id,
    status: 'succeeded',
    created: 1_762_000_000,
    amount_received: cents,
    customer,
    metadata: { app, credits: String(credits), pack: 'cf_credits_x', workos_user_id: owner },
  });
  return {
    payments: [
      pi('pi_a', 'cus_old', 25, 500, OLD),
      pi('pi_b', 'cus_old', 55, 1000, OLD),
      // Kazi's, on the shared Stripe account: never ours.
      pi('pi_kazi', 'cus_old', 25, 500, OLD, 'kazi'),
      { ...pi('pi_failed', 'cus_old', 25, 0, OLD), status: 'requires_payment_method' },
    ] as Pi[],
    refunds: [
      {
        id: 're_b',
        payment_intent: 'pi_b',
        amount: 500,
        status: 'succeeded',
        created: 1_762_000_100,
      },
    ],
    charges: [] as Record<string, string>[],
    cardFails: false,
  };
}

let stripe = stripeState();

function stripeApi(url: URL, init?: RequestInit): Response {
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  const path = url.pathname;
  if (path === '/v1/payment_intents' && init?.method === 'POST') {
    const form = Object.fromEntries(new URLSearchParams(String(init.body)));
    stripe.charges.push(form);
    if (stripe.cardFails) return json({ error: { message: 'Your card was declined.' } }, 402);
    const key = new Headers(init.headers).get('idempotency-key') ?? '';
    const id = `pi_top_${key.replace(/[^a-z0-9]/gi, '').slice(-12)}`;
    if (!stripe.payments.some((p) => p.id === id))
      stripe.payments.push({
        id,
        status: 'succeeded',
        created: Math.floor(Date.now() / 1000),
        amount_received: Number(form.amount),
        customer: String(form.customer),
        metadata: {
          app: String(form['metadata[app]']),
          credits: String(form['metadata[credits]']),
          pack: String(form['metadata[pack]']),
          workos_user_id: String(form['metadata[workos_user_id]']),
        },
      });
    return json({ id, status: 'succeeded' });
  }
  if (path === '/v1/payment_intents')
    return json({
      data: stripe.payments.filter((p) => p.customer === url.searchParams.get('customer')),
      has_more: false,
    });
  if (path.startsWith('/v1/payment_intents/')) {
    const found = stripe.payments.find((p) => p.id === path.split('/').pop());
    return found ? json(found) : json({ error: { message: 'No such payment_intent' } }, 404);
  }
  if (path === '/v1/refunds')
    return json({
      data: stripe.refunds.filter(
        (r) => r.payment_intent === url.searchParams.get('payment_intent'),
      ),
    });
  if (path === '/v1/payment_methods')
    return json({ data: [{ id: 'pm_1', card: { brand: 'visa', last4: '4242' } }] });
  if (path === '/v1/checkout/sessions/cs_test_1')
    return json({ id: 'cs_test_1', payment_intent: 'pi_checkout' });
  return json({ error: { message: 'not found' } }, 404);
}

function workosApi(url: URL): Response {
  const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  const user = users.get(id);
  return user
    ? Response.json({ id, email_verified: true, ...user })
    : Response.json({}, { status: 404 });
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'api.workos.com') return workosApi(url);
    if (url.hostname === 'api.stripe.com') return stripeApi(url, init);
    return realFetch(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());

const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

const stores: [
  string,
  (runtime: Runtime) => Promise<{ ledger: Ledger; close: () => Promise<void> }>,
  boolean,
][] = [
  [
    'filesystem',
    async (runtime) => ({
      ledger: new FileLedger({ records: runtime.ws.records, low: LOW_CREDITS }),
      close: async () => undefined,
    }),
    true,
  ],
  [
    'MongoDB',
    async () => {
      const records = new MongoRecords({ uri: TEST_MONGODB_URI, db: testDatabase() });
      return {
        ledger: new MongoLedger({ db: () => records.database(), low: LOW_CREDITS }),
        close: async () => {
          await (await records.database()).dropDatabase();
          await records.close();
        },
      };
    },
    await mongoReachable(),
  ],
];

for (const [name, makeLedger, up] of stores) {
  describe.skipIf(!up)(`credits on the ${name} ledger`, { timeout: MONGO_TEST_TIMEOUT_MS }, () => {
    let base: string;
    let server: Server;
    let runtime: Runtime;
    let ledger: Ledger;
    let lifecycle: Lifecycle;
    let close: () => Promise<void>;
    const mail: { to: string; subject: string }[] = [];

    beforeAll(async () => {
      stripe = stripeState();
      const dir = await mkdtemp(join(tmpdir(), 'cf-ledger-'));
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
      ({ ledger, close } = await makeLedger(runtime));
      const options = { workosKey: 'sk_test_none', stripeKey: 'sk_test_none' };
      const accountUrl = 'https://cuttingfloor.ai/account';
      const access = new AccessCheck({ ...options, ledger, accountUrl, ws: runtime.ws });
      lifecycle = new Lifecycle({
        runtime,
        access,
        ledger,
        ...options,
        accountUrl,
        accountKey: ACCOUNT_KEY,
        stripeWebhookSecret: SECRET,
        mailer: {
          send: async (m: { to: string; subject: string }) => void mail.push(m),
        } as unknown as Mailer,
      });
      // The gate as main.ts wires it, with a stand-in for burning the mark.
      runtime.useGate(
        {
          exempt: (owner) => access.exempt(owner),
          balance: async (owner) => (await access.balance(owner)).left,
          spend: (owner, ref, credits, tool) => lifecycle.spendRelease(owner, ref, credits, tool),
          mark: async (input, output) =>
            writeFile(output, `${await readFile(input, 'utf8')}${MARK}`),
        },
        { from: '2000-01-01T00:00:00Z' },
      );
      server = createHttpServer({
        runtime,
        credentials: new LocalCredentialStore({}, false),
        apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
        route: (req, res, url) => lifecycle.route(req, res, url),
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      (runtime.config as { publicUrl: string }).publicUrl = base;
      // Six minutes of jobs before any ledger.
      await ran(OLD, 'job_before', 360, new Date(Date.now() - 86_400_000));
    });

    afterAll(async () => {
      server.close();
      await close();
    });

    async function ran(owner: string, job_id: string, seconds: number, ended: Date) {
      const ws = runtime.ws;
      const ended_at = ended.toISOString();
      const entry: MeterEntry = {
        job_id,
        tool: 'export.video',
        started_at: ended_at,
        ended_at,
        seconds,
      };
      await ws.writeJson(
        ws.ownerDir(owner, 'meter', ended_at.slice(0, 7), `${job_id}.json`),
        entry,
      );
    }

    /** A finished video export of `seconds`, as export.video leaves one. */
    async function exported(owner: string, seconds: number): Promise<string> {
      const store = runtime.jobs.store;
      const job = await store.create({ owner, tool: 'export.video' });
      await runtime.outputs.write(owner, job.id, 'cut.mp4', 'clean cut', 'export');
      const signed = await runtime.signOutput(owner, job.id, 'cut.mp4');
      await store.update(job, {
        status: 'completed',
        progress: 1,
        result: {
          content: [],
          structuredContent: { url: signed.url, mime_type: 'video/mp4', duration_seconds: seconds },
        } as never,
      });
      return job.id;
    }

    const account = async (user: string) =>
      (await (
        await fetch(`${base}/account/usage?user=${user}&fresh=1`, {
          headers: { authorization: `Bearer ${ACCOUNT_KEY}` },
        })
      ).json()) as {
        account: {
          plan: string;
          credits: Record<string, number | null>;
          top_up: { automatic: boolean } | null;
        };
      };
    const release = async (user: string, file: string) => {
      const res = await fetch(`${base}/account/release`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ACCOUNT_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ user, file }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const webhook = (event: unknown, signature?: string) => {
      const body = JSON.stringify(event);
      return fetch(`${base}/stripe/webhook`, {
        method: 'POST',
        body,
        headers: { 'stripe-signature': signature ?? sign(body) },
      });
    };
    const balance = async (user: string) => (await ledger.get(user))?.balance;

    it('opens a new account with the activation grant, once', async () => {
      const got = await account(NEW);
      expect(got.account.credits).toMatchObject({ left: 3, free: 3, bought: 0, used: 0 });
      await account(NEW);
      expect((await ledger.entries(NEW)).map((e) => e.id)).toEqual(['grant:activation']);
    });

    it('opens an old account with what it had here: free credits less use, and each pack less refunds', async () => {
      const got = await account(OLD);
      // 3 granted, 100 free less 6 used less the 3 carried as the grant, 25 + 55 bought, half of 55 refunded.
      expect(got.account.credits).toMatchObject({ left: 146.5, free: 100, bought: 52.5, used: 6 });
      expect(got.account.plan).toBe('credits');
      const ids = (await ledger.entries(OLD)).map((e) => e.id).sort();
      expect(ids).toEqual(['grant:activation', 'opening:carry', 'pi_a', 'pi_b', 're_b']);
    });

    it('spends nothing for jobs, and a clean copy once, however often or at once it is asked for', async () => {
      await ran(OLD, 'job_after', 120, new Date());
      await lifecycle.sweep();
      expect(await balance(OLD)).toBe(146.5);
      const file = await exported(OLD, 120);
      const both = await Promise.all([release(OLD, file), release(OLD, file)]);
      expect(both.map((r) => r.status)).toEqual([200, 200]);
      const again = await release(OLD, file);
      expect(again.status).toBe(200);
      expect(await balance(OLD)).toBe(144.5);
      expect((await ledger.entries(OLD)).filter((e) => e.kind === 'spend')).toHaveLength(1);
      expect((await account(OLD)).account.credits).toMatchObject({ left: 144.5, used: 8 });
      expect(mail).toEqual([]);
    });

    it('refuses a clean copy the balance can’t cover, and spends nothing', async () => {
      const file = await exported(NEW, 600);
      const refused = await release(NEW, file);
      expect(refused.status).toBe(402);
      expect(refused.body).toMatchObject({ price: 7.5, credits_left: 3 });
      expect(await balance(NEW)).toBe(3);
    });

    it('emails once when a release takes the balance low', async () => {
      // 140 credits: 5 full minutes, then 270 at half.
      const file = await exported(OLD, 275 * 60);
      expect((await release(OLD, file)).status).toBe(200);
      expect(await balance(OLD)).toBe(4.5);
      await vi.waitFor(() =>
        expect(mail).toEqual([
          expect.objectContaining({ to: 'old@example.com', subject: 'You have 4.5 credits left' }),
        ]),
      );
    });

    it('keeps automatic top-up, and buys the pack once at the crossing', async () => {
      const res = await fetch(`${base}/account/top-up`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ACCOUNT_KEY}` },
        body: JSON.stringify({ user: OLD, pack: 'cf_credits_10' }),
      });
      expect(res.status).toBe(200);
      expect((await ledger.get(OLD))?.refill).toEqual({ pack: 'cf_credits_10' });
      expect((await account(OLD)).account.top_up?.automatic).toBe(true);
      mail.length = 0;
      const file = await exported(OLD, 4.5 * 60);
      expect((await release(OLD, file)).status).toBe(200);
      await vi.waitFor(() => expect(mail.map((m) => m.subject)).toEqual(['Topped up: 55 credits']));
      expect(stripe.charges).toHaveLength(1);
      expect(stripe.charges[0]).toMatchObject({
        amount: '1000',
        customer: 'cus_old',
        off_session: 'true',
        'metadata[app]': 'cuttingfloor',
        'metadata[workos_user_id]': OLD,
      });
      expect(await balance(OLD)).toBe(55);
      // Stripe's own event for that charge changes nothing more.
      const charged = stripe.payments.at(-1);
      await webhook({
        id: 'evt_top',
        type: 'payment_intent.succeeded',
        data: { object: { object: 'payment_intent', id: charged?.id } },
      });
      expect(await balance(OLD)).toBe(55);
    });

    it('says when the top-up failed, then that credits are out, and never charges again for it', async () => {
      stripe.cardFails = true;
      mail.length = 0;
      const file = await exported(OLD, 55 * 60); // 5 + 25: 30 credits
      expect((await release(OLD, file)).status).toBe(200);
      const rest = await exported(OLD, ((await balance(OLD)) ?? 0) * 60 * 2 - 5 * 60); // the rest, to zero
      expect((await release(OLD, rest)).status).toBe(200);
      expect(await balance(OLD)).toBe(0);
      await vi.waitFor(() =>
        expect(mail.map((m) => m.subject)).toEqual([
          'We couldn’t top up your credits',
          'Your credits are used up',
        ]),
      );
      const charges = stripe.charges.length;
      await lifecycle.sweep();
      expect(stripe.charges.length).toBe(charges);
      stripe.cardFails = false;
    });

    it('credits a pack from Stripe’s event once, and takes back a refund', async () => {
      const bad = await webhook(
        { id: 'evt_x', type: 'payment_intent.succeeded', data: { object: {} } },
        't=1,v1=00',
      );
      expect(bad.status).toBe(400);
      stripe.payments.push({
        id: 'pi_new',
        status: 'succeeded',
        created: Math.floor(Date.now() / 1000),
        amount_received: 500,
        customer: 'cus_new',
        metadata: { app: 'cuttingfloor', credits: '25', pack: 'cf_credits_5', workos_user_id: NEW },
      });
      const event = {
        id: 'evt_1',
        type: 'payment_intent.succeeded',
        data: { object: { object: 'payment_intent', id: 'pi_new' } },
      };
      const res = await webhook(event);
      expect(await res.json()).toMatchObject({ received: true, credited: 25, balance: 28 });
      await webhook(event);
      expect(await balance(NEW)).toBe(28);
      expect((await account(NEW)).account).toMatchObject({
        plan: 'credits',
        credits: { bought: 25, left: 28 },
      });
      // Kazi's payment on the shared account is not ours.
      const kazi = await webhook({
        id: 'evt_k',
        type: 'payment_intent.succeeded',
        data: { object: { object: 'payment_intent', id: 'pi_kazi' } },
      });
      expect(await kazi.json()).toEqual({ ignored: true });
      stripe.refunds.push({
        id: 're_new',
        payment_intent: 'pi_new',
        amount: 500,
        status: 'succeeded',
        created: Math.floor(Date.now() / 1000),
      });
      const refund = {
        id: 'evt_2',
        type: 'charge.refunded',
        data: { object: { object: 'charge', payment_intent: 'pi_new' } },
      };
      await webhook(refund);
      await webhook(refund);
      expect(await balance(NEW)).toBe(3);
      expect((await ledger.entries(NEW)).map((e) => e.id).sort()).toEqual([
        'grant:activation',
        'pi_new',
        're_new',
      ]);
    });

    it('credits a checkout as it returns to the account page, only for its own account', async () => {
      stripe.payments.push({
        id: 'pi_checkout',
        status: 'succeeded',
        created: Math.floor(Date.now() / 1000),
        amount_received: 1000,
        customer: 'cus_new',
        metadata: {
          app: 'cuttingfloor',
          credits: '55',
          pack: 'cf_credits_10',
          workos_user_id: NEW,
        },
      });
      const post = (body: unknown) =>
        fetch(`${base}/account/payments`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ACCOUNT_KEY}` },
          body: JSON.stringify(body),
        });
      expect((await post({ user: OLD, checkout_session: 'cs_test_1' })).status).toBe(404);
      expect(await (await post({ user: NEW, checkout_session: 'cs_test_1' })).json()).toEqual({
        credited: 55,
        balance: 58,
      });
      expect(await (await post({ user: NEW, payment_intent: 'pi_checkout' })).json()).toEqual({
        credited: 0,
        balance: 58,
      });
      const event = {
        id: 'evt_3',
        type: 'payment_intent.succeeded',
        data: { object: { object: 'payment_intent', id: 'pi_checkout' } },
      };
      await webhook(event);
      expect(await balance(NEW)).toBe(58);
    });

    it('leaves a given plan out of the ledger', async () => {
      expect((await account(LIFETIME)).account.credits).toMatchObject({ per_month: 900 });
      expect(await ledger.get(LIFETIME)).toBeUndefined();
    });

    it('sends the email a spend called for when a server stopped before sending it', async () => {
      await runtime.ws.writeJson(
        runtime.ws.ownerDir(NEW, 'ledger-spent', 'j_untold-release.json'),
        {
          at: new Date().toISOString(),
          told: false,
          crossed: 'low',
        },
      );
      mail.length = 0;
      await lifecycle.sweep();
      expect(mail).toEqual([
        expect.objectContaining({
          to: 'new@example.com',
          subject: expect.stringMatching(/credits left/),
        }),
      ]);
      expect(
        await runtime.ws.readJson(
          runtime.ws.ownerDir(NEW, 'ledger-spent', 'j_untold-release.json'),
        ),
      ).toMatchObject({ told: true });
    });
  });
}
