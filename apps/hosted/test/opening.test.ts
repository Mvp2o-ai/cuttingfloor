import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@cuttingfloor/core';
import { LOW_CREDITS } from '@cuttingfloor/plans';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileLedger } from '../src/ledger.ts';
import { importHandoff, LEDGER_LINKS, parseHandoff, reconcile } from '../src/opening.ts';

// The split from Kazi's ledger (scripts/ledger-opening.ts, scripts/ledger-reconcile.ts): each
// account Kazi hands over opens with exactly Kazi's balance, its payments and releases under
// their own ids, and Stripe payments Kazi never saw; unmetered becomes lifetime; an account Kazi
// opened starts fresh; a dry run writes nothing, a second run adds nothing; reconcile finds no
// difference until there is one. WorkOS and Stripe are stand-ins.

const TAKEN = '2026-12-01T10:00:00.000Z';
const A = 'user_01HANDEDOVERAAAAAAAAAAAAA1';
const B = 'user_01HANDEDOVERBBBBBBBBBBBBB2';
const D = 'user_01KAZIOPENEDDDDDDDDDDDDDD4';
const at = (offsetSeconds: number) => Date.parse(TAKEN) / 1000 + offsetSeconds;

const file = {
  format: 'kazi-handoff/0 (provisional)',
  taken_at: TAKEN,
  accounts: [
    {
      account_id: 'ca_1',
      workos_user_id: A,
      email: 'a@example.com',
      balance: 95,
      refill_pack: 'cf_credits_10',
      unmetered: false,
      rows: [
        { kind: 'grant', credits: 3, ref: 'grant' },
        { kind: 'opening', credits: 20, ref: `opening:${A}` },
        {
          kind: 'purchase',
          credits: 25,
          ref: 'pi_a',
          source: 'stripe',
          at: '2026-11-30T10:00:00Z',
        },
        { kind: 'purchase', credits: 55, ref: '2000000000000001', source: 'apple' },
        { kind: 'usage', credits: -8, ref: 'j_1-release', at: '2026-12-01T09:00:00Z' },
      ],
    },
    { account_id: 'ca_2', workos_user_id: B, balance: 0, unmetered: true, rows: [] },
    { account_id: 'ca_3', workos_user_id: null, balance: 4 },
  ],
};

const puts: { id: string; metadata: Record<string, string> }[] = [];
const users: Record<string, { email: string; metadata: Record<string, string> }> = {
  [A]: { email: 'a@example.com', metadata: { stripe_customer_id: 'cus_a' } },
  [B]: { email: 'b@example.com', metadata: { plan_reason: 'made by Kazi' } },
  [D]: { email: 'd@example.com', metadata: {} },
};
const payments = [
  { id: 'pi_a', created: at(-86_400), amount_received: 500 },
  { id: 'pi_late', created: at(3600), amount_received: 1000, credits: '55' },
].map((p) => ({
  id: p.id,
  status: 'succeeded',
  created: p.created,
  amount_received: p.amount_received,
  customer: 'cus_a',
  metadata: { app: 'cuttingfloor', credits: p.credits ?? '25', workos_user_id: A },
}));

let ws: Workspace;
let ledger: FileLedger;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'api.workos.com') {
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      if (init?.method === 'PUT') {
        puts.push({ id, metadata: JSON.parse(String(init.body)).metadata });
        return Response.json({});
      }
      const user = users[id];
      return user ? Response.json({ id, ...user }) : Response.json({}, { status: 404 });
    }
    if (url.hostname === 'api.stripe.com') {
      if (url.pathname === '/v1/payment_intents') return Response.json({ data: payments });
      if (url.pathname === '/v1/refunds') return Response.json({ data: [] });
    }
    return realFetch(input, init);
  });
  ws = new Workspace(await mkdtemp(join(tmpdir(), 'cf-opening-')));
  ledger = new FileLedger({ records: ws.records, low: LOW_CREDITS });
  await ws.records.collection(LEDGER_LINKS, { owner: A }).put('link', {
    account_id: 'ca_1',
    since: '2026-11-10T00:00:00Z',
    used_before: 5,
  });
  await ws.records.collection(LEDGER_LINKS, { owner: D }).put('link', {
    account_id: 'ca_kazi',
    since: '2026-11-12T00:00:00Z',
    used_before: 1,
  });
});

afterAll(() => vi.unstubAllGlobals());

const run = (apply: boolean, handoff = parseHandoff(file)) => {
  const lines: string[] = [];
  return importHandoff({
    handoff,
    ledger,
    records: ws.records,
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    apply,
    log: (line) => lines.push(line),
  }).then((report) => ({ report, lines }));
};

describe('the split from Kazi’s ledger', () => {
  it('prints what it would do and writes nothing without --apply', async () => {
    const { report, lines } = await run(false);
    expect(report).toMatchObject({ opened: 2, lifetime: 1, started: 1 });
    expect(report.problems).toEqual(['ca_3: no WorkOS user id; not carried']);
    expect(lines.some((l) => l.startsWith(`would open ${A}`))).toBe(true);
    expect(await ledger.owners()).toEqual([]);
    expect(puts).toEqual([]);
  });

  it('opens each handed account with exactly Kazi’s balance, then what Stripe had since', async () => {
    await run(true);
    const a = await ledger.get(A);
    // 95 at the split, and a pack of 55 bought after it.
    expect(a).toMatchObject({
      balance: 150,
      opening_total: 23,
      bought_total: 135,
      used_total: 8,
      used_before: 5,
      refill: { pack: 'cf_credits_10' },
      stripe_customer_id: 'cus_a',
    });
    expect((await ledger.entries(A)).map((e) => e.id).sort()).toEqual([
      'apple:2000000000000001',
      'j_1-release',
      'opening:ca_1',
      'pi_a',
      'pi_late',
    ]);
    expect(await ledger.get(B)).toMatchObject({ balance: 0 });
    // Kazi opened D: it starts as any new account does.
    expect(await ledger.get(D)).toMatchObject({ balance: 3, granted_total: 3, used_before: 1 });
    expect(puts).toEqual([
      {
        id: B,
        metadata: expect.objectContaining({ plan: 'lifetime', plan_reason: 'made by Kazi' }),
      },
    ]);
  });

  it('adds nothing when run again', async () => {
    const { report } = await run(true);
    expect(report).toMatchObject({ opened: 0, topped: 0, started: 0 });
    expect((await ledger.get(A))?.balance).toBe(150);
  });

  it('reconciles with no difference, and names one when there is', async () => {
    expect(await reconcile({ handoff: parseHandoff(file), ledger })).toEqual({
      checked: 3,
      differences: [],
    });
    const changed: { taken_at: string; accounts: Record<string, unknown>[] } =
      structuredClone(file);
    if (changed.accounts[0]) changed.accounts[0].balance = 94;
    changed.accounts.push({
      account_id: 'ca_9',
      workos_user_id: 'user_01MISSINGXXXXXXXXXXXXXXXX9',
      balance: 1,
    });
    const { differences } = await reconcile({ handoff: parseHandoff(changed), ledger });
    expect(differences).toEqual([
      { owner: A, what: 'balance at the split is 95 here, 94 in Kazi’s ledger' },
      {
        owner: 'user_01MISSINGXXXXXXXXXXXXXXXX9',
        what: 'in the hand-off (1) but not in our ledger',
      },
    ]);
  });
});
