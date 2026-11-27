import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@cuttingfloor/core';
import { LOW_CREDITS } from '@cuttingfloor/plans';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessCheck } from '../src/access.ts';
import { FileLedger } from '../src/ledger.ts';
import { importHandoff, LEDGER_LINKS, parseHandoff, reconcile } from '../src/opening.ts';

// The split from Kazi's ledger (scripts/ledger-opening.ts, scripts/ledger-reconcile.ts) on a
// `kazi-handoff/1` file: every account with a WorkOS user opens at exactly Kazi's balance (a
// negative one too), App Store payments under their own ids, never with our activation grant or
// the old carry-over on top; a dry run writes nothing; run 2 adds the rows with refs of their own
// that run 1 didn't have (payments, and releases Kazi took in between, which a release already
// spent here doesn't double) and reports any other change; the file is checked against its own totals; reconcile finds no difference until
// there is one. WorkOS is a stand-in.

const EXPORTED = '2026-12-01T10:00:00.000Z';
const A = 'user_01HANDEDOVERAAAAAAAAAAAAA1';
const B = 'user_01HANDEDOVERBBBBBBBBBBBBB2';
const RACED = 'user_01SIGNEDINFIRSTEEEEEEEEEE5';
const LINKED = 'user_01KAZIOPENEDDDDDDDDDDDDDD4';
// Signed up between run 1 and our deploy: one never used, one that spent in Kazi's ledger.
const WINDOW = 'user_01SIGNEDUPINWINDOWWWWWWWW6';
const SPENT = 'user_01SIGNEDUPANDSPENTTTTTTTT7';
// Open here with our grant but no opening, and in Kazi's ledger with Kazi's 25 or a bigger grant.
const NOROWS = 'user_01NOCUTTINGFLOORROWSSSSSS8';
const FORGIVEN = 'user_01FORGIVENESSGRANTTTTTTTT9';

type Row = { kind: string; source: string; credits: number; ref: string; at?: string };
type Account = {
  account_id: string;
  workos_user_id: string | null;
  email?: string;
  kazi_user_id?: string | null;
  unmetered: boolean;
  apple_account_token?: string | null;
  stripe_customer_id?: string | null;
  refill_pack?: string | null;
  balance: number;
  rows: Row[];
};

type Member = { kazi_user_id: string; email: string; reason: string };

/** A run of the export, with its totals worked out as one-mcp's script writes them. */
function handoff(run: number, accounts: Account[], kazi_unmetered: Member[] = []) {
  return {
    format: 'kazi-handoff/1',
    exported_at: EXPORTED,
    run,
    accounts,
    kazi_unmetered,
    totals: {
      accounts: accounts.length,
      balance_sum: Math.round(accounts.reduce((n, a) => n + a.balance, 0) * 1e6) / 1e6,
      rows: accounts.reduce((n, a) => n + a.rows.length, 0),
      kazi_unmetered: kazi_unmetered.length,
    },
  };
}

const a1: Account = {
  account_id: 'ca_1',
  workos_user_id: A,
  email: 'a@example.com',
  kazi_user_id: null,
  unmetered: false,
  apple_account_token: 'A1B2C3D4-0000-4000-8000-000000000000',
  stripe_customer_id: null,
  refill_pack: null,
  balance: 95,
  rows: [
    { kind: 'grant', source: 'kazi', credits: 25, ref: 'grant' },
    { kind: 'purchase', source: 'apple', credits: 55, ref: '2000000000000001' },
    { kind: 'usage', source: 'cuttingfloor', credits: -8, ref: 'j_1-release' },
    { kind: 'opening', source: 'cuttingfloor', credits: 23, ref: `opening:${A}` },
  ],
};
const b1: Account = {
  account_id: 'ca_2',
  workos_user_id: B,
  kazi_user_id: 'e3bc',
  unmetered: true,
  balance: -1.0234,
  rows: [{ kind: 'usage', source: 'cuttingfloor', credits: -1.0234, ref: 'j_2-release' }],
};
const kaziOnly: Account = {
  account_id: 'ca_3',
  workos_user_id: null,
  unmetered: false,
  balance: 4,
  rows: [],
};
// Kazi's staff and lifetime members: B (also unmetered on its account), D, and one with no
// WorkOS user.
const members: Member[] = [
  { kazi_user_id: 'k1', email: 'B@example.com', reason: 'lifetime' },
  { kazi_user_id: 'k2', email: 'd@example.com', reason: 'staff' },
  { kazi_user_id: 'k3', email: 'nobody@example.com', reason: 'lifetime' },
];
const run1 = handoff(1, [a1, b1, kaziOnly], members);

const puts: { id: string; metadata: Record<string, string> }[] = [];
const users: Record<
  string,
  { email: string; created_at: string; metadata: Record<string, string> }
> = {
  // Made before 2026-11-08 with 6 minutes used: the old carry-over would give it 91 more.
  [A]: { email: 'a@example.com', created_at: '2026-10-01T00:00:00Z', metadata: {} },
  [B]: {
    email: 'b@example.com',
    created_at: '2026-10-01T00:00:00Z',
    metadata: { plan_reason: 'made by Kazi' },
  },
  [RACED]: { email: 'e@example.com', created_at: '2026-11-25T00:00:00Z', metadata: {} },
  [LINKED]: { email: 'd@example.com', created_at: '2026-11-25T00:00:00Z', metadata: {} },
  [WINDOW]: { email: 'w@example.com', created_at: '2026-12-01T11:00:00Z', metadata: {} },
  [SPENT]: { email: 's@example.com', created_at: '2026-12-01T11:00:00Z', metadata: {} },
  [NOROWS]: { email: 'n@example.com', created_at: '2026-12-01T11:00:00Z', metadata: {} },
  [FORGIVEN]: { email: 'f@example.com', created_at: '2026-12-01T11:00:00Z', metadata: {} },
};

let ws: Workspace;
let ledger: FileLedger;
let access: AccessCheck;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'api.workos.com') {
      if (url.pathname === '/user_management/users') {
        const email = url.searchParams.get('email');
        return Response.json({
          data: Object.entries(users)
            .filter(([, u]) => u.email === email)
            .map(([id, u]) => ({ id, ...u })),
        });
      }
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      if (init?.method === 'PUT') {
        puts.push({ id, metadata: JSON.parse(String(init.body)).metadata });
        const user = users[id];
        if (user) user.metadata = JSON.parse(String(init.body)).metadata;
        return Response.json({});
      }
      const user = users[id];
      return user
        ? Response.json({ id, email_verified: true, ...user })
        : Response.json({}, { status: 404 });
    }
    if (url.hostname === 'api.stripe.com') return Response.json({ data: [] });
    return realFetch(input, init);
  });
  ws = new Workspace(await mkdtemp(join(tmpdir(), 'cf-opening-')));
  ledger = new FileLedger({ records: ws.records, low: LOW_CREDITS });
  access = new AccessCheck({
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    ledger,
    accountUrl: 'https://cuttingfloor.ai/account',
    ws,
  });
  await ws.records.collection(LEDGER_LINKS, { owner: A }).put('link', {
    account_id: 'ca_1',
    since: '2026-11-10T00:00:00Z',
    used_before: 6,
  });
  const ended = '2026-10-20T00:00:00.000Z';
  await ws.writeJson(ws.ownerDir(A, 'meter', '2026-10', 'job_old.json'), {
    job_id: 'job_old',
    tool: 'export.video',
    started_at: ended,
    ended_at: ended,
    seconds: 360,
  });
});

afterAll(() => vi.unstubAllGlobals());

const run = async (file: unknown, apply: boolean) => {
  const lines: string[] = [];
  const report = await importHandoff({
    handoff: parseHandoff(file),
    ledger,
    records: ws.records,
    workosKey: 'sk_test_none',
    apply,
    log: (line) => lines.push(line),
  });
  return { report, lines };
};

describe('the split from Kazi’s ledger', () => {
  it('reads kazi-handoff/1 and checks the file against its own totals', () => {
    expect(parseHandoff(run1).mismatches).toEqual([]);
    const off = { ...run1, totals: { accounts: 61, balance_sum: 0, rows: 3, kazi_unmetered: 15 } };
    expect(parseHandoff(off).mismatches).toEqual([
      'the file has 3 accounts, its totals say 61',
      'its balances sum to 97.9766, its totals say 0',
      'it has 5 rows, its totals say 3',
      'it lists 3 unmetered members, its totals say 15',
    ]);
    expect(() => parseHandoff({ ...run1, format: 'kazi-handoff/0' })).toThrow();
  });

  it('prints what it would do and writes nothing without --apply', async () => {
    const { report, lines } = await run(run1, false);
    expect(report).toEqual({ opened: 2, added: 0, lifetime: 2, skipped: 1, mismatches: [] });
    expect(lines.some((l) => l.startsWith(`would open ${A}`))).toBe(true);
    expect(lines).toContain('nobody@example.com: Kazi lifetime, no WorkOS user; left');
    expect(await ledger.owners()).toEqual([]);
    expect(puts).toEqual([]);
  });

  it('opens every account with a WorkOS user at exactly Kazi’s balance, a negative one too', async () => {
    const { report } = await run(run1, true);
    expect(report.mismatches).toEqual([]);
    expect(await ledger.get(A)).toMatchObject({
      balance: 95,
      // 95 less the App Store pack, plus the release: both entered by their refs.
      opening_total: 48,
      bought_total: 55,
      used_total: 8,
      used_before: 6,
      apple_account_token: 'a1b2c3d4-0000-4000-8000-000000000000',
    });
    expect((await ledger.entries(A)).map((e) => e.id).sort()).toEqual([
      'apple:2000000000000001',
      'j_1-release',
      'opening:ca_1',
    ]);
    expect(await ledger.get(B)).toMatchObject({
      balance: -1.0234,
      opening_total: 0,
      used_total: 1.0234,
    });
    expect(await ledger.owners()).toEqual(expect.not.arrayContaining(['ca_3']));
    // B once (unmetered on its account and listed), D by its email; neither had a plan.
    expect(puts).toEqual([
      {
        id: B,
        metadata: expect.objectContaining({ plan: 'lifetime', plan_reason: 'made by Kazi' }),
      },
      {
        id: LINKED,
        metadata: expect.objectContaining({
          plan: 'lifetime',
          plan_reason: 'Kazi lifetime member at the billing split',
        }),
      },
    ]);
  });

  it('never adds our activation grant on top of an imported balance', async () => {
    const balance = await access.balance(A);
    expect(balance.left).toBe(95);
    expect((await ledger.entries(A)).some((e) => e.id === 'grant:activation')).toBe(false);
  });

  it('never adds the old carry-over to an account the hand-off carries', async () => {
    // A was made before 2026-11-08 and used 6 minutes: opened by the server, it would carry 91.
    await access.balance(A);
    expect((await ledger.entries(A)).some((e) => e.id === 'opening:carry')).toBe(false);
    expect((await access.balance(A)).left).toBe(95);
  });

  it('adds nothing when run again, and reconciles with no difference', async () => {
    const { report } = await run(run1, true);
    expect(report).toMatchObject({ opened: 0, added: 0, lifetime: 0, mismatches: [] });
    expect(await reconcile({ handoff: parseHandoff(run1), ledger, records: ws.records })).toEqual({
      checked: 2,
      differences: [],
      notes: [],
    });
  });

  it('run 2 adds every new row with its own ref, releases too, and reports a balance that moved any other way', async () => {
    // After our deploy, A's clean copy of j_4 is spent here; Kazi's ledger, before the deploy, took
    // j_3 and j_4 (our old server reported both), and an App Store pack came in.
    await ledger.spend(A, { id: 'j_4-release', credits: 1, tool: 'export.release' });
    const a2 = {
      ...a1,
      balance: 147,
      rows: [
        ...a1.rows,
        { kind: 'purchase', source: 'apple', credits: 55, ref: '2000000000000002' },
        { kind: 'usage', source: 'cuttingfloor', credits: -2, ref: 'j_3-release' },
        { kind: 'usage', source: 'cuttingfloor', credits: -1, ref: 'j_4-release' },
      ],
    };
    // B is also a Kazi user: its Kazi use since run 1 moved its balance, and that is Kazi's.
    const b2 = { ...b1, balance: 2 };
    const { report, lines } = await run(handoff(2, [a2, b2, kaziOnly]), true);
    expect(report.added).toBe(2);
    expect(report.mismatches).toEqual([]);
    expect(lines).toContain(
      `${B}: Kazi's balance is 2, its opening and rows here come to -1.0234 (Kazi user: Kazi's own use, not checked)`,
    );
    // opening 48 + 55 - 8 (run 1) + 55 - 2 - 1 (run 2): j_4 once, not twice.
    expect(await ledger.get(A)).toMatchObject({ balance: 147, used_total: 11 });
    expect((await ledger.entries(A)).filter((e) => e.id === 'j_4-release')).toHaveLength(1);
    expect((await ledger.get(B))?.balance).toBe(-1.0234);
    const checked = await reconcile({
      handoff: parseHandoff(handoff(2, [a2, b2, kaziOnly])),
      ledger,
      records: ws.records,
    });
    expect(checked.differences).toEqual([]);
    expect(checked.notes).toEqual([
      { owner: B, what: 'Kazi’s balance is 2, its opening and rows here come to -1.0234' },
    ]);
    // Even for a Kazi user, a row by ref that isn't here is a difference.
    const b3 = {
      ...b2,
      rows: [
        ...b2.rows,
        { kind: 'usage', source: 'cuttingfloor', credits: -1, ref: 'j_9-release' },
      ],
    };
    const missing = await reconcile({ handoff: parseHandoff(handoff(2, [a2, b3])), ledger });
    expect(missing.differences).toEqual([{ owner: B, what: 'j_9-release is not carried' }]);
    // A release Kazi took that the balance doesn't show is a mismatch too.
    const off = {
      ...a2,
      rows: [
        ...a2.rows,
        { kind: 'usage', source: 'cuttingfloor', credits: -3, ref: 'j_5-release' },
      ],
    };
    const { report: again } = await run(handoff(2, [off]), false);
    expect(again.mismatches).toContain(
      `${A}: Kazi's balance is 147, its opening and rows here come to 144`,
    );
  });

  it('lets a sign-up between the runs be, and flags one that spent in Kazi’s ledger meanwhile', async () => {
    await access.balance(WINDOW);
    await access.balance(SPENT);
    const grant = { kind: 'grant', source: 'kazi', credits: 3, ref: 'grant' };
    const window: Account = {
      ...kaziOnly,
      account_id: 'ca_w',
      workos_user_id: WINDOW,
      balance: 3,
      rows: [grant],
    };
    const spent: Account = {
      ...kaziOnly,
      account_id: 'ca_s',
      workos_user_id: SPENT,
      balance: 2,
      rows: [grant, { kind: 'usage', source: 'cuttingfloor', credits: -1, ref: 'j_s-release' }],
    };
    const file = handoff(2, [window, spent]);
    const { report, lines } = await run(file, true);
    expect(lines).toContain(
      `${WINDOW}: signed up between the runs; open here with our grant, nothing carried`,
    );
    expect(report.mismatches).toContain(
      `${SPENT}: already open here without opening:ca_s (grant:activation); not carried`,
    );
    expect(report.mismatches.some((m) => m.startsWith(WINDOW))).toBe(false);
    const { differences, notes } = await reconcile({ handoff: parseHandoff(file), ledger });
    expect(notes).toEqual([
      { owner: WINDOW, what: 'signed up between the runs; open here with our grant' },
    ]);
    expect(differences).toEqual([{ owner: SPENT, what: 'has no opening:ca_s' }]);
  });

  it('never takes an account with no rows or a bigger grant for a sign-up between the runs', async () => {
    await access.balance(NOROWS);
    await access.balance(FORGIVEN);
    const norows: Account = {
      ...kaziOnly,
      account_id: 'ca_n',
      workos_user_id: NOROWS,
      balance: 25,
      rows: [],
    };
    const forgiven: Account = {
      ...kaziOnly,
      account_id: 'ca_f',
      workos_user_id: FORGIVEN,
      balance: 93.9,
      rows: [{ kind: 'grant', source: 'cuttingfloor', credits: 93.9, ref: 'admin:forgive' }],
    };
    const { report } = await run(handoff(2, [norows, forgiven]), true);
    expect(report.mismatches).toContain(
      `${NOROWS}: already open here without opening:ca_n (grant:activation); not carried`,
    );
    expect(report.mismatches).toContain(
      `${FORGIVEN}: already open here without opening:ca_f (grant:activation); not carried`,
    );
  });

  it('leaves an account a sign-in opened first, an unhanded link and stray App Store money for Ken', async () => {
    await access.balance(RACED);
    await ws.records
      .collection(LEDGER_LINKS, { owner: LINKED })
      .put('link', { account_id: 'ca_kazi', used_before: 0 });
    const raced: Account = {
      ...b1,
      account_id: 'ca_5',
      workos_user_id: RACED,
      unmetered: false,
      balance: 7,
      rows: [],
    };
    const stray: Account = { ...kaziOnly, account_id: 'ca_6', apple_account_token: 'tok' };
    const { report } = await run(handoff(1, [raced, stray]), true);
    // A is linked too, and this file (another export) leaves it out.
    expect(report.mismatches).toEqual([
      `${RACED}: already open here without opening:ca_5 (grant:activation); not carried`,
      'ca_6: no WorkOS user id, but 0 App Store rows and an App Store token',
      `${A}: linked to Kazi's ledger but not in the hand-off`,
      `${LINKED}: linked to Kazi's ledger but not in the hand-off`,
    ]);
    expect((await ledger.get(RACED))?.balance).toBe(3);
  });
});
