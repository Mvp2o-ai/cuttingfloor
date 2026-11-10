import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import type { CfError } from '@cuttingfloor/schema';
import { type MeterEntry, Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessCheck, linkPath } from '../src/access.ts';
import type { Mailer } from '../src/email.ts';
import { createHttpServer } from '../src/http.ts';
import { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// Credits in Kazi's ledger: an account is linked once with the balance it had here, every job
// that ends after is spent there once, and the ledger's crossings and top-ups become our email.
// WorkOS, Stripe and the ledger are stand-ins here, answering as their APIs do (the ledger as its
// published fixtures, contract v3); the real ledger runs in scripts/smoke-ledger.ts.

const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const LEDGER_KEY = 'ledger-key-0123456789abcdef';
const OLD = 'user_01OLDACCOUNT00000000000001';
const LIFETIME = 'user_01LIFETIME0000000000000001';
const TAKEN = 'user_01TAKENEMAIL00000000000001';
const DOWN = 'user_01LEDGERDOWN00000000000001';
let base: string;
let server: Server;
let runtime: Runtime;
let access: AccessCheck;
let lifecycle: Lifecycle;
const mail: { to: string; subject: string }[] = [];

// The stand-in WorkOS: users by id.
const users = new Map<
  string,
  { email: string; created_at: string; metadata: Record<string, string> }
>([
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
  [TAKEN, { email: 'taken@example.com', created_at: '2026-11-09T00:00:00.000Z', metadata: {} }],
  [DOWN, { email: 'down@example.com', created_at: '2026-11-09T00:00:00.000Z', metadata: {} }],
]);

// The stand-in Stripe: the old account's payments. A cuttingfloor pack, one refunded by half, and
// a Kazi payment that is not ours.
const charge = (amount: number, amount_refunded = 0) => ({ amount, amount_refunded });
const payments = [
  {
    id: 'pi_a',
    status: 'succeeded',
    metadata: { app: 'cuttingfloor', credits: '25' },
    latest_charge: charge(500),
  },
  {
    id: 'pi_b',
    status: 'succeeded',
    metadata: { app: 'cuttingfloor', credits: '55' },
    latest_charge: charge(1000, 500),
  },
  {
    id: 'pi_c',
    status: 'succeeded',
    metadata: { app: 'kazi', credits: '25' },
    latest_charge: charge(500),
  },
  {
    id: 'pi_d',
    status: 'requires_payment_method',
    metadata: { app: 'cuttingfloor', credits: '25' },
  },
];

// The stand-in ledger, as contract v3 and its fixtures describe it.
interface Account {
  account_id: string;
  email: string;
  workos_user_id: string;
  stripe_customer_id?: string;
  rows: { kind: string; credits: number; ref: string }[];
  refill: { pack: string } | null;
}
const accounts = new Map<string, Account>();
const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
let ledgerDown = false;
let cardFails = false;
const PACK_CREDITS: Record<string, [number, number]> = { cf_credits_10: [55, 10] };

const sum = (a: Account, kind?: string) =>
  a.rows.filter((r) => !kind || r.kind === kind).reduce((n, r) => n + r.credits, 0);
const body = (a: Account) => ({
  account_id: a.account_id,
  balance: sum(a),
  granted_total: sum(a, 'grant'),
  opening_total: sum(a, 'opening'),
  bought_total: sum(a, 'purchase'),
  used_total: -sum(a, 'usage'),
  unmetered: false,
  refill: a.refill,
});

async function ledger(url: URL, init?: RequestInit): Promise<Response> {
  const reply = (b: unknown, status = 200) => Response.json(b, { status });
  if (ledgerDown) return reply({ error: 'internal error' }, 500);
  if (init?.headers && new Headers(init.headers).get('authorization') !== `Bearer ${LEDGER_KEY}`)
    return reply({ error: 'unauthorized' }, 401);
  const req = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  calls.push({ method: init?.method ?? 'GET', path: url.pathname, ...(req ? { body: req } : {}) });
  const find = (id: unknown) => accounts.get(String(id));
  if (url.pathname === '/api/credits/account') {
    const b = req as {
      email: string;
      workos_user_id: string;
      stripe_customer_id?: string;
      opening?: { credits: number; purchases: { payment_intent: string; credits: number }[] };
    };
    let a = [...accounts.values()].find((x) => x.workos_user_id === b.workos_user_id);
    if (!a) {
      const byEmail = [...accounts.values()].find((x) => x.email === b.email);
      if (byEmail)
        return reply({ error: `${b.email} is linked to another cuttingfloor account` }, 409);
      a = {
        account_id: `ca_${accounts.size + 1}`,
        email: b.email,
        workos_user_id: b.workos_user_id,
        rows: [{ kind: 'grant', credits: 25, ref: 'grant' }],
        refill: null,
      };
      accounts.set(a.account_id, a);
    }
    if (b.stripe_customer_id) a.stripe_customer_id = b.stripe_customer_id;
    const refs = new Set(a.rows.map((r) => r.ref));
    if (b.opening && !refs.has(`opening:${b.workos_user_id}`)) {
      if (b.opening.credits)
        a.rows.push({
          kind: 'opening',
          credits: b.opening.credits,
          ref: `opening:${b.workos_user_id}`,
        });
      for (const p of b.opening.purchases)
        if (!refs.has(p.payment_intent))
          a.rows.push({ kind: 'purchase', credits: p.credits, ref: p.payment_intent });
    }
    return reply(body(a));
  }
  if (url.pathname === '/api/credits/balance') {
    const a = find(url.searchParams.get('account_id'));
    return a ? reply(body(a)) : reply({ error: 'credit account not found' }, 404);
  }
  if (url.pathname === '/api/credits/refill') {
    const a = find(req?.account_id);
    if (!a) return reply({ error: 'credit account not found' }, 404);
    a.refill = req?.pack ? { pack: String(req.pack) } : null;
    return reply(body(a));
  }
  if (url.pathname === '/api/credits/usage') {
    const a = find(req?.account_id);
    if (!a) return reply({ error: 'credit account not found' }, 404);
    const ref = String(req?.job_id);
    if (a.rows.some((r) => r.ref === ref))
      return reply({ balance: sum(a), duplicate: true, crossed: null, top_up: null });
    const before = sum(a);
    a.rows.push({ kind: 'usage', credits: -Number(req?.credits), ref });
    const after = sum(a);
    const crossed = before > 0 && after <= 0 ? 'out' : before >= 5 && after < 5 ? 'low' : null;
    let top_up: Record<string, unknown> | null = null;
    if (crossed && a.refill) {
      const [credits, price] = PACK_CREDITS[a.refill.pack] ?? [0, 0];
      if (cardFails)
        top_up = { ok: false, pack: a.refill.pack, credits, price, message: 'no card is saved' };
      else {
        a.rows.push({ kind: 'purchase', credits, ref: `top-up:${ref}` });
        top_up = {
          ok: true,
          pack: a.refill.pack,
          credits,
          price,
          card: { brand: 'visa', last4: '4242' },
          balance: sum(a),
        };
      }
    }
    return reply({ balance: sum(a), duplicate: false, crossed, top_up });
  }
  return reply({ error: 'not found' }, 404);
}

function workos(url: URL): Response {
  const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  const user = users.get(id);
  return user
    ? Response.json({ id, email_verified: true, ...user })
    : Response.json({}, { status: 404 });
}

function stripe(url: URL): Response {
  if (url.pathname === '/v1/payment_intents')
    return Response.json({ data: payments, has_more: false });
  if (url.pathname === '/v1/payment_methods') return Response.json({ data: [] });
  return Response.json({}, { status: 404 });
}

const realFetch = globalThis.fetch;

/** Writes a meter entry as the runtime does when a job ends. */
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
  await ws.writeJson(ws.ownerDir(owner, 'meter', ended_at.slice(0, 7), `${job_id}.json`), entry);
}

const usage = () => calls.filter((c) => c.path === '/api/credits/usage');
const account = async (user: string) =>
  (await (
    await fetch(`${base}/account/usage?user=${user}&fresh=1`, {
      headers: { authorization: `Bearer ${ACCOUNT_KEY}` },
    })
  ).json()) as { account: { credits: Record<string, number>; top_up: { automatic: boolean } } };

beforeAll(async () => {
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'ledger.test') return ledger(url, init);
    if (url.hostname === 'api.workos.com') return workos(url);
    if (url.hostname === 'api.stripe.com') return stripe(url);
    return realFetch(input, init);
  });
  const dir = await mkdtemp(join(tmpdir(), 'cf-ledger-'));
  runtime = new Runtime({
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
  const ledgerClient = new Ledger('https://ledger.test', LEDGER_KEY);
  const accountUrl = 'https://cuttingfloor.ai/account';
  access = new AccessCheck({ ...options, ledger: ledgerClient, accountUrl, ws: runtime.ws });
  lifecycle = new Lifecycle({
    runtime,
    access,
    ledger: ledgerClient,
    ...options,
    accountUrl,
    accountKey: ACCOUNT_KEY,
    mailer: {
      send: async (m: { to: string; subject: string }) => void mail.push(m),
    } as unknown as Mailer,
  });
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
    route: (req, res, url) => lifecycle.route(req, res, url),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Six minutes of jobs before the ledger.
  await ran(OLD, 'job_before', 360, new Date(Date.now() - 86_400_000));
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

describe('credits in the ledger', () => {
  it('links an account once, carrying its balance and each pack it bought', async () => {
    const got = await account(OLD);
    const links = calls.filter((c) => c.path === '/api/credits/account');
    expect(links).toHaveLength(1);
    // 100 free (made before 2026-11-08), less 6 used, less the ledger's own grant of 25.
    expect(links[0]?.body).toEqual({
      email: 'old@example.com',
      workos_user_id: OLD,
      stripe_customer_id: 'cus_old',
      opening: {
        credits: 69,
        purchases: [
          { payment_intent: 'pi_a', credits: 25 },
          { payment_intent: 'pi_b', credits: 27.5 },
        ],
      },
    });
    // The page shows it as before: free + bought - used = left.
    expect(got.account.credits).toMatchObject({ left: 146.5, free: 100, bought: 52.5, used: 6 });
    const link = await runtime.ws.readJson<{ account_id: string; used_before: number }>(
      linkPath(runtime.ws, OLD),
    );
    expect(link).toMatchObject({ account_id: 'ca_1', used_before: 6 });
    // Read again, it is not linked again.
    await account(OLD);
    expect(calls.filter((c) => c.path === '/api/credits/account')).toHaveLength(1);
  });

  it('spends a job that ends after the link once, and never one from before', async () => {
    await ran(OLD, 'job_after', 120, new Date());
    await lifecycle.sweep();
    await lifecycle.sweep();
    expect(usage().map((c) => c.body)).toEqual([
      expect.objectContaining({
        account_id: 'ca_1',
        job_id: 'job_after',
        credits: 2,
        tool: 'export.video',
      }),
    ]);
    expect((await account(OLD)).account.credits).toMatchObject({ left: 144.5, used: 8 });
    // A lost marker sends it again; the ledger takes it once and nobody is emailed.
    await runtime.ws.remove(runtime.ws.ownerDir(OLD, 'ledger-spent', 'job_after.json'));
    await lifecycle.sweep();
    expect(usage()).toHaveLength(2);
    expect(accounts.get('ca_1')?.rows.filter((r) => r.ref === 'job_after')).toHaveLength(1);
    expect(mail).toEqual([]);
  });

  it('emails once when a spend takes the balance low', async () => {
    await ran(OLD, 'job_long', 140 * 60, new Date());
    await lifecycle.sweep();
    expect(mail).toEqual([
      expect.objectContaining({ to: 'old@example.com', subject: 'You have 4.5 credits left' }),
    ]);
  });

  it('sets automatic top-up in the ledger, and emails what it bought at the crossing', async () => {
    const res = await fetch(`${base}/account/top-up`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ACCOUNT_KEY}` },
      body: JSON.stringify({ user: OLD, pack: 'cf_credits_10' }),
    });
    expect(res.status).toBe(200);
    expect(accounts.get('ca_1')?.refill).toEqual({ pack: 'cf_credits_10' });
    expect((await account(OLD)).account.top_up.automatic).toBe(true);
    mail.length = 0;
    await ran(OLD, 'job_out', 300, new Date());
    await lifecycle.sweep();
    expect(mail.map((m) => m.subject)).toEqual(['Topped up: 55 credits']);
    expect((await account(OLD)).account.credits.left).toBe(54.5);
  });

  it('says when the top-up failed, then that credits are out, and refuses new jobs at zero', async () => {
    cardFails = true;
    mail.length = 0;
    await ran(OLD, 'job_broke', 60 * 60, new Date());
    await lifecycle.sweep();
    expect(mail.map((m) => m.subject)).toEqual([
      'We couldn’t top up your credits',
      'Your credits are used up',
    ]);
    const limits = await access.limits(OLD);
    expect(limits.refuseJobs?.code).toBe('quota_exceeded');
  });

  it('tells the ledger about a Stripe customer made after the link, without a second opening', async () => {
    const user = users.get(OLD);
    if (user) user.metadata.stripe_customer_id = 'cus_new';
    await account(OLD);
    const last = calls.filter((c) => c.path === '/api/credits/account').at(-1);
    expect(last?.body).toEqual({
      email: 'old@example.com',
      workos_user_id: OLD,
      stripe_customer_id: 'cus_new',
    });
    expect(accounts.get('ca_1')?.stripe_customer_id).toBe('cus_new');
  });

  it('leaves a given plan out of the ledger', async () => {
    const before = calls.length;
    await ran(LIFETIME, 'job_life', 600, new Date());
    expect((await account(LIFETIME)).account.credits).toMatchObject({ per_month: 900 });
    await lifecycle.sweep();
    expect(calls.length).toBe(before);
  });

  it('refuses when the email has credits with another account, and when the ledger is down', async () => {
    accounts.set('ca_other', {
      account_id: 'ca_other',
      email: 'taken@example.com',
      workos_user_id: 'user_01SOMEONEELSE0000000000001',
      rows: [],
      refill: null,
    });
    const taken = (await access.get(TAKEN).catch((e) => e)) as CfError;
    expect(taken.hint).toContain('another cuttingfloor account');
    ledgerDown = true;
    const down = (await access.get(DOWN).catch((e) => e)) as CfError;
    expect(down.code).toBe('service_unavailable');
    expect(down.detail).toMatchObject({ retry: true });
    ledgerDown = false;
  });
});
