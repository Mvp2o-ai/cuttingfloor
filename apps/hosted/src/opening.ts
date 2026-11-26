import { defineCollection, type Records } from '@cuttingfloor/core';
import { packOf, taggedPlan } from '@cuttingfloor/plans';
import * as z from 'zod/v4';
import { appleEntryId, appleRefundId } from './apple.ts';
import { type Ledger, type NewEntry, totals } from './ledger.ts';

// The split from Kazi's shared ledger, run by scripts/ledger-opening.ts and checked by
// scripts/ledger-reconcile.ts. Neither is a mode of the server.
//
// Kazi exports every account with a WorkOS user id (`kazi-handoff/1`, one-mcp's one-off script,
// agreed as contract v1). Its `balance` is the number: each account opens here holding exactly that,
// negative or not, as `opening:<Kazi account id>`, written once (entries are append-only). Its rows
// are for audit and to avoid counting twice: a payment row with an id of its own (a Stripe payment
// intent or refund, an App Store transaction) is entered under that id and carved out of the
// opening, so the account still holds exactly `balance` and the same payment arriving again here is
// a duplicate. Every other row (grants, Kazi's openings, releases) is only counted.
//
// An account the import opens never gets the activation grant or the carry-over from before any
// ledger: those come only when the server opens an account itself, and an open account is never
// opened again. An account already open here before the import (a sign-in raced it) is not
// touched; it is reported.
//
// A later export (run 2, after Kazi stops handling cuttingfloor) adds only payment rows it hasn't
// seen. Kazi's balance for an account may move only by those rows; any other change between runs
// is a mismatch. So is a file whose accounts, balance sum, row count or member count differ from
// its `totals`. Mismatches are printed and exit 1: they go to Ken. Every Kazi member listed in
// `kazi_unmetered` (staff or lifetime, linked to us or not) gets a WorkOS `plan: lifetime` tag on
// the user with that email, unless it has a plan tag already; a member with no WorkOS user is
// printed and left. Without --apply nothing is written.

const HandoffRow = z.object({
  kind: z.string(),
  source: z.string().optional(),
  /** Signed: what the row added to Kazi's balance. */
  credits: z.number(),
  ref: z.string().nullable().optional(),
  at: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
});
const HandoffAccount = z.object({
  account_id: z.string().min(1),
  workos_user_id: z.string().nullable(),
  email: z.string().nullable().optional(),
  kazi_user_id: z.string().nullable().optional(),
  unmetered: z.boolean(),
  apple_account_token: z.string().nullable().optional(),
  stripe_customer_id: z.string().nullable().optional(),
  refill_pack: z.string().nullable().optional(),
  balance: z.number(),
  rows: z.array(HandoffRow),
});
const HandoffFile = z.object({
  format: z.literal('kazi-handoff/1'),
  exported_at: z.string(),
  run: z.number().int().positive(),
  accounts: z.array(HandoffAccount),
  /** Kazi's staff and lifetime members, to tag lifetime here. */
  kazi_unmetered: z
    .array(
      z.object({
        kazi_user_id: z.string().nullable().optional(),
        email: z.string(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  totals: z.object({
    accounts: z.number(),
    balance_sum: z.number(),
    rows: z.number(),
    kazi_unmetered: z.number().optional(),
  }),
});

/** One account as the import works with it. */
export interface HandedAccount {
  kazi_id: string;
  owner: string | null;
  email: string | null;
  balance: number;
  refill: string | null;
  unmetered: boolean;
  apple_account_token: string | null;
  stripe_customer_id: string | null;
  /** Payment rows with ids of their own, entered under them. */
  payments: NewEntry[];
  /** Rows only counted: grants, Kazi's openings, releases. */
  counted: number;
}

export interface Handoff {
  exported_at: string;
  run: number;
  accounts: HandedAccount[];
  /** Kazi's staff and lifetime members, by email. */
  unmetered: { email: string; reason: string }[];
  /** Where the file disagrees with its own `totals`. */
  mismatches: string[];
}

/** Reads a `kazi-handoff/1` file; the only place that knows its shape. */
export function parseHandoff(json: unknown): Handoff {
  const file = HandoffFile.parse(json);
  const exported = new Date(file.exported_at);
  if (Number.isNaN(exported.getTime())) throw new Error('exported_at is not a time');
  const at = exported.toISOString();
  const mismatches: string[] = [];
  const rows = file.accounts.reduce((n, a) => n + a.rows.length, 0);
  const sum = round(file.accounts.reduce((n, a) => n + a.balance, 0));
  if (file.accounts.length !== file.totals.accounts)
    mismatches.push(
      `the file has ${file.accounts.length} accounts, its totals say ${file.totals.accounts}`,
    );
  if (Math.abs(sum - file.totals.balance_sum) > 1e-6)
    mismatches.push(`its balances sum to ${sum}, its totals say ${file.totals.balance_sum}`);
  if (rows !== file.totals.rows)
    mismatches.push(`it has ${rows} rows, its totals say ${file.totals.rows}`);
  const members = file.kazi_unmetered ?? [];
  if (file.totals.kazi_unmetered !== undefined && members.length !== file.totals.kazi_unmetered)
    mismatches.push(
      `it lists ${members.length} unmetered members, its totals say ${file.totals.kazi_unmetered}`,
    );
  return {
    exported_at: at,
    run: file.run,
    mismatches,
    unmetered: members.map((m) => ({
      email: m.email.trim().toLowerCase(),
      reason: m.reason ?? 'unmetered',
    })),
    accounts: file.accounts.map((a) => {
      const payments: NewEntry[] = [];
      let counted = 0;
      for (const row of a.rows) {
        const entry = paymentEntry(row, at);
        if (entry) payments.push(entry);
        else counted++;
      }
      return {
        kazi_id: a.account_id,
        owner: a.workos_user_id,
        email: a.email ?? null,
        balance: a.balance,
        refill: a.refill_pack ?? null,
        unmetered: a.unmetered,
        apple_account_token: a.apple_account_token?.toLowerCase() ?? null,
        stripe_customer_id: a.stripe_customer_id ?? null,
        payments,
        counted,
      };
    }),
  };
}

/** A payment or refund row with an id of its own, as our entry; undefined for any other row. */
function paymentEntry(row: z.infer<typeof HandoffRow>, exported: string): NewEntry | undefined {
  const ref = row.ref ?? '';
  const at = new Date(row.at ?? exported).toISOString();
  if (row.kind !== 'purchase' && row.kind !== 'refund') return undefined;
  if (row.source === 'apple') {
    const tx = ref.replace(/^refund:/, '');
    if (!/^\d+$/.test(tx)) return undefined;
    return {
      id: row.kind === 'purchase' ? appleEntryId(tx) : appleRefundId(tx),
      kind: row.kind,
      credits: row.credits,
      reason: 'App Store, carried from Kazi',
      at,
    };
  }
  if (row.kind === 'purchase' && /^pi_\w+$/.test(ref))
    return { id: ref, kind: 'purchase', credits: row.credits, payment_intent: ref, at };
  if (row.kind === 'refund' && /^re_\w+$/.test(ref))
    return { id: ref, kind: 'refund', credits: row.credits, at };
  return undefined;
}

/** An owner's link to Kazi's ledger, from before the split (`owners/{owner}/ledger/link.json`). */
export const LEDGER_LINKS = defineCollection<{
  account_id?: string;
  since?: string;
  used_before?: number;
}>({
  name: 'ledger_links',
  scope: 'owner',
  fs: { dir: 'ledger' },
});

export interface ImportOptions {
  handoff: Handoff;
  ledger: Ledger;
  /** The server's record store: the old links to Kazi's ledger are read from it. */
  records: Records;
  workosKey: string;
  /** Writes; without it only prints. */
  apply: boolean;
  log: (line: string) => void;
}

export interface ImportReport {
  opened: number;
  added: number;
  lifetime: number;
  /** Accounts without a WorkOS user id: Kazi's alone. */
  skipped: number;
  mismatches: string[];
}

export async function importHandoff(o: ImportOptions): Promise<ImportReport> {
  const report: ImportReport = { opened: 0, added: 0, lifetime: 0, skipped: 0, mismatches: [] };
  const mismatch = (line: string) => {
    report.mismatches.push(line);
    o.log(`MISMATCH ${line}`);
  };
  const verb = o.apply ? '' : 'would ';
  o.log(
    `kazi-handoff/1 run ${o.handoff.run}, exported ${o.handoff.exported_at}: ${o.handoff.accounts.length} accounts, balances sum to ${round(o.handoff.accounts.reduce((n, a) => n + a.balance, 0))}, ${o.handoff.unmetered.length} unmetered members`,
  );
  for (const line of o.handoff.mismatches) mismatch(line);
  const handed = new Set<string>();
  const tagged = new Set<string>();
  /** Tags the user lifetime, once, unless a plan tag is there already. */
  const lifetime = async (user: WorkosUser, why: string) => {
    if (tagged.has(user.id)) return;
    tagged.add(user.id);
    const tag = user.metadata?.plan;
    if (taggedPlan(tag)) {
      o.log(`${user.id} (${user.email}): ${why}, already plan ${tag}; left as it is`);
      return;
    }
    o.log(`${verb}tag ${user.id} (${user.email}) plan lifetime (${why})`);
    if (o.apply) await tagLifetime(o.workosKey, user.id, user.metadata ?? {});
    report.lifetime++;
  };
  for (const a of o.handoff.accounts) {
    if (!a.owner) {
      // App Store packs are cuttingfloor's money whoever opened the account.
      const apple = a.payments.filter((e) => e.id.startsWith('apple'));
      if (apple.length || a.apple_account_token)
        mismatch(
          `${a.kazi_id}: no WorkOS user id, but ${apple.length} App Store rows${a.apple_account_token ? ' and an App Store token' : ''}`,
        );
      else o.log(`skip ${a.kazi_id}: no WorkOS user id (Kazi's alone)`);
      report.skipped++;
      continue;
    }
    if (!/^user_[0-9A-Z]{26}$/.test(a.owner)) {
      mismatch(`${a.kazi_id}: ${a.owner} is not a WorkOS user id`);
      continue;
    }
    const owner = a.owner;
    handed.add(owner);
    const user = await workosUser(o.workosKey, owner);
    if (!user) {
      mismatch(`${a.kazi_id} ${owner}: no such WorkOS user`);
      continue;
    }
    const openingId = `opening:${a.kazi_id}`;
    const known = await o.ledger.get(owner);
    const have = known ? await o.ledger.entries(owner) : [];
    if (!known) {
      const link = await o.records
        .collection(LEDGER_LINKS, { owner })
        .get('link')
        .catch(() => undefined);
      const refill = a.refill && packOf(a.refill) ? { pack: a.refill } : null;
      if (a.refill && !refill) mismatch(`${owner}: refill pack ${a.refill} is not ours`);
      // The payments carved out, so the account holds exactly Kazi's balance.
      const opening = round(a.balance - a.payments.reduce((n, e) => n + e.credits, 0));
      o.log(
        `${verb}open ${owner} (${a.email ?? user.email}) at ${a.balance}: ${openingId} ${opening}${a.payments.length ? ` + ${a.payments.length} payments` : ''}, ${a.counted} rows counted${refill ? `, refill ${refill.pack}` : ''}${a.apple_account_token ? ', App Store token kept' : ''}`,
      );
      if (o.apply)
        await o.ledger.open(owner, async () => ({
          used_before: link?.used_before ?? 0,
          refill,
          ...(a.stripe_customer_id ? { stripe_customer_id: a.stripe_customer_id } : {}),
          ...(a.apple_account_token ? { apple_account_token: a.apple_account_token } : {}),
          entries: [
            {
              id: openingId,
              kind: 'opening',
              credits: opening,
              at: o.handoff.exported_at,
              reason: `balance in Kazi's ledger at the split (${a.balance}), less payments entered beside it`,
            },
            ...a.payments,
          ],
        }));
      report.opened++;
    } else if (!have.some((e) => e.id === openingId)) {
      // Opened here first (a sign-in got in before the import): its grant would stack on Kazi's
      // balance, so it is left for Ken.
      mismatch(
        `${owner}: already open here without ${openingId} (${have.map((e) => e.id).join(', ')}); not carried`,
      );
      continue;
    } else {
      // A later run: only payments it hasn't seen, and Kazi's balance may have moved only by them.
      const ids = new Set(have.map((e) => e.id));
      const fresh = a.payments.filter((e) => !ids.has(e.id));
      for (const e of fresh) {
        o.log(`${verb}add ${owner} ${e.kind} ${e.id} ${e.credits}`);
        if (o.apply) await o.ledger.credit(owner, e);
        report.added++;
      }
      const carried = carriedBalance(have, openingId, a) + sum(fresh);
      if (Math.abs(carried - a.balance) > 1e-6)
        mismatch(
          `${owner}: Kazi's balance is ${a.balance}, its opening and payments here come to ${round(carried)}`,
        );
    }
    if (a.unmetered) await lifetime(user, 'unmetered in Kazi');
  }
  for (const member of o.handoff.unmetered) {
    const found = await workosUsersByEmail(o.workosKey, member.email);
    if (!found.length) o.log(`${member.email}: Kazi ${member.reason}, no WorkOS user; left`);
    for (const user of found) await lifetime(user, `Kazi ${member.reason}`);
  }
  for (const owner of await linkedNotHanded(o.records, handed))
    mismatch(`${owner}: linked to Kazi's ledger but not in the hand-off`);
  o.log(
    `${o.apply ? 'done' : 'dry run'}: ${report.opened} opened, ${report.added} payments added, ${report.lifetime} tagged lifetime, ${report.skipped} skipped (no WorkOS user), ${report.mismatches.length} mismatches`,
  );
  return report;
}

/** What the hand-off's own entries come to here: the opening and the payments it carried. */
function carriedBalance(
  entries: readonly { id: string; credits: number }[],
  openingId: string,
  a: HandedAccount,
): number {
  const ids = new Set([openingId, ...a.payments.map((e) => e.id)]);
  return sum(entries.filter((e) => ids.has(e.id)));
}

async function linkedNotHanded(records: Records, handed: Set<string>): Promise<string[]> {
  const out: string[] = [];
  for (const owner of await records.owners()) {
    if (!/^user_[0-9A-Z]{26}$/.test(owner) || handed.has(owner)) continue;
    const link = await records
      .collection(LEDGER_LINKS, { owner })
      .get('link')
      .catch(() => undefined);
    if (link?.account_id) out.push(owner);
  }
  return out;
}

/** One difference between our ledger and the hand-off, or within our ledger. */
export interface Difference {
  owner: string;
  what: string;
}

/**
 * Compares our ledger with a hand-off: the file against its own totals; each account's opening
 * and carried payments against Kazi's balance; accounts missing either way; and every account's
 * stored balance and totals against its entries summed again.
 */
export async function reconcile(o: {
  handoff: Handoff;
  ledger: Ledger;
  records?: Records;
}): Promise<{ checked: number; differences: Difference[] }> {
  const differences: Difference[] = o.handoff.mismatches.map((what) => ({ owner: 'file', what }));
  const handed = new Map<string, HandedAccount>();
  for (const a of o.handoff.accounts) if (a.owner) handed.set(a.owner, a);
  const ours = new Set(await o.ledger.owners());
  for (const [owner, a] of handed) {
    if (!ours.has(owner)) {
      differences.push({ owner, what: `in the hand-off (${a.balance}) but not in our ledger` });
      continue;
    }
    const entries = await o.ledger.entries(owner);
    const openingId = `opening:${a.kazi_id}`;
    if (!entries.some((e) => e.id === openingId)) {
      differences.push({ owner, what: `has no ${openingId}` });
      continue;
    }
    if (entries.some((e) => e.id === 'grant:activation' || e.id === 'opening:carry'))
      differences.push({ owner, what: 'carries Kazi’s balance and a grant or carry-over of ours' });
    const carried = round(carriedBalance(entries, openingId, a));
    if (Math.abs(carried - a.balance) > 1e-6)
      differences.push({
        owner,
        what: `Kazi’s balance is ${a.balance}, its opening and payments here come to ${carried}`,
      });
  }
  if (o.records)
    for (const owner of await linkedNotHanded(o.records, new Set(handed.keys())))
      differences.push({ owner, what: 'linked to Kazi’s ledger but not in the hand-off' });
  for (const owner of ours) {
    const account = await o.ledger.get(owner);
    const summed = totals(await o.ledger.entries(owner));
    for (const field of Object.keys(summed) as (keyof typeof summed)[])
      if (account && Math.abs(account[field] - summed[field]) > 1e-6)
        differences.push({
          owner,
          what: `${field} is ${account[field]}, its entries sum to ${summed[field]}`,
        });
  }
  return { checked: ours.size, differences };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const sum = (entries: readonly { credits: number }[]) => entries.reduce((n, e) => n + e.credits, 0);

interface WorkosUser {
  id: string;
  email: string;
  metadata?: Record<string, string>;
}

async function workosUsersByEmail(key: string, email: string): Promise<WorkosUser[]> {
  const res = await fetch(
    `https://api.workos.com/user_management/users?${new URLSearchParams({ email })}`,
    { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`WorkOS users by email: ${res.status}`);
  const list = (await res.json()) as { data?: WorkosUser[] };
  return (list.data ?? []).filter((u) => u.email.toLowerCase() === email);
}

async function workosUser(key: string, id: string): Promise<WorkosUser | undefined> {
  const res = await fetch(
    `https://api.workos.com/user_management/users/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) },
  );
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`WorkOS user ${id}: ${res.status}`);
  return (await res.json()) as WorkosUser;
}

/**
 * Gives lifetime as other given plans are given: `plan`, when, and why (a partner's
 * `made by …` reason stays, as it decides who welcomes the account).
 */
async function tagLifetime(key: string, id: string, metadata: Record<string, string>) {
  const reason = metadata.plan_reason?.startsWith('made by ')
    ? metadata.plan_reason
    : 'Kazi lifetime member at the billing split';
  const res = await fetch(
    `https://api.workos.com/user_management/users/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: {
          ...metadata,
          plan: 'lifetime',
          plan_since: new Date().toISOString(),
          plan_reason: reason,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`WorkOS tag ${id}: ${res.status}`);
}
