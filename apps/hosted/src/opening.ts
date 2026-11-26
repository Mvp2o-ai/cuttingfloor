import { defineCollection, type Records } from '@cuttingfloor/core';
import { FREE_CREDITS, packOf, taggedPlan } from '@cuttingfloor/plans';
import * as z from 'zod/v4';
import { appleEntryId, appleRefundId } from './apple.ts';
import { type CreditEntry, type Ledger, type NewEntry, totals } from './ledger.ts';
import { customerPayments, paymentEntries } from './stripe-credits.ts';

// The split from Kazi's shared ledger, run once at the cutover by scripts/ledger-opening.ts and
// checked by scripts/ledger-reconcile.ts. Neither is a mode of the server.
//
// Kazi hands over every account cuttingfloor opened in its ledger, as it stood at `taken_at`: the
// balance, the refill pack, whether Kazi called it unmetered, and its rows. Each becomes an
// account here with:
// - its payments and refunds (Stripe payment intents and refunds, App Store transactions) and its
//   releases, under their own ids, so the same payment or release arriving again is a duplicate;
// - `opening:<Kazi account id>`: the rest of the balance, so the account holds exactly what Kazi
//   said;
// - what it used here before the shared ledger (its old link's `used_before`), for the page.
// Payments in Stripe after `taken_at` that Kazi never saw are added too. `unmetered` becomes a
// WorkOS `plan: lifetime` tag (an account that has a plan tag already keeps it). Accounts linked to
// Kazi's ledger that Kazi did not hand over (accounts Kazi opened) start with the activation grant
// and nothing carried. Everything is idempotent: run it again and it adds only what is missing.
// Without --apply it writes nothing and prints what it would do.

/**
 * The hand-off as Kazi will send it. PROVISIONAL: one-mcp owns the format and it is not agreed
 * yet; only `parseHandoff` knows its shape, so a different one changes that function alone.
 */
const HandoffRow = z.object({
  kind: z.string(),
  /** Signed: what the row added to the balance. */
  credits: z.number(),
  /** The payment intent, refund, App Store transaction, or `<job>-release`. */
  ref: z.string().optional(),
  /** `stripe`, `apple`, `cuttingfloor`… */
  source: z.string().optional(),
  at: z.string().optional(),
});
const HandoffAccount = z.object({
  account_id: z.string().min(1),
  workos_user_id: z.string().nullable().optional(),
  email: z.string().optional(),
  balance: z.number(),
  refill_pack: z.string().nullable().optional(),
  unmetered: z.boolean().optional(),
  apple_account_token: z.string().nullable().optional(),
  rows: z.array(HandoffRow).optional(),
});
const HandoffFile = z.object({
  format: z.string().optional(),
  taken_at: z.string(),
  accounts: z.array(HandoffAccount),
});

/** One account as the import works with it, whatever shape the hand-off came in. */
export interface HandedAccount {
  kazi_id: string;
  owner: string | null;
  email: string | null;
  balance: number;
  refill: string | null;
  unmetered: boolean;
  apple_account_token: string | null;
  /** The rows that become entries of their own here, ids already ours. */
  entries: NewEntry[];
  /** Rows folded into the opening entry (grants, Kazi's own spends, adjustments). */
  folded: number;
}

export interface Handoff {
  taken_at: string;
  accounts: HandedAccount[];
}

/** Reads Kazi's hand-off file (see HandoffFile) into what the import needs. */
export function parseHandoff(json: unknown): Handoff {
  const file = HandoffFile.parse(json);
  const taken = new Date(file.taken_at);
  if (Number.isNaN(taken.getTime())) throw new Error('taken_at is not a time');
  return {
    taken_at: taken.toISOString(),
    accounts: file.accounts.map((a) => {
      const entries: NewEntry[] = [];
      let folded = 0;
      for (const row of a.rows ?? []) {
        const entry = rowEntry({ ...row, at: row.at ?? taken.toISOString() });
        if (entry) entries.push(entry);
        else folded++;
      }
      return {
        kazi_id: a.account_id,
        owner: a.workos_user_id ?? null,
        email: a.email ?? null,
        balance: a.balance,
        refill: a.refill_pack ?? null,
        unmetered: a.unmetered ?? false,
        apple_account_token: a.apple_account_token?.toLowerCase() ?? null,
        entries,
        folded,
      };
    }),
  };
}

/** A row that is a payment, refund or release becomes its own entry; anything else is folded. */
function rowEntry(row: z.infer<typeof HandoffRow>): NewEntry | undefined {
  const ref = row.ref ?? '';
  const at = row.at ? { at: new Date(row.at).toISOString() } : {};
  const kind = row.kind;
  if ((kind === 'purchase' || kind === 'refund') && (row.source === 'apple' || /^\d+$/.test(ref))) {
    const tx = ref.replace(/^refund:/, '');
    return {
      id: kind === 'purchase' ? appleEntryId(tx) : appleRefundId(tx),
      kind,
      credits: row.credits,
      reason: 'App Store, carried from Kazi',
      ...at,
    };
  }
  if (kind === 'purchase' && ref.startsWith('pi_'))
    return { id: ref, kind, credits: row.credits, payment_intent: ref, ...at };
  if (kind === 'refund' && ref.startsWith('re_'))
    return { id: ref, kind, credits: row.credits, ...at };
  if ((kind === 'usage' || kind === 'release' || kind === 'spend') && ref.endsWith('-release'))
    return {
      id: ref,
      kind: 'spend',
      credits: -Math.abs(row.credits),
      tool: 'export.release',
      ...at,
    };
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
  /** The record store the server uses: the old links to Kazi's ledger are read from it. */
  records: Records;
  workosKey: string;
  stripeKey: string;
  /** Writes; without it only prints. */
  apply: boolean;
  log: (line: string) => void;
}

/** What the import did (or would do). */
export interface ImportReport {
  opened: number;
  topped: number;
  lifetime: number;
  started: number;
  problems: string[];
}

export async function importHandoff(o: ImportOptions): Promise<ImportReport> {
  const report: ImportReport = { opened: 0, topped: 0, lifetime: 0, started: 0, problems: [] };
  const problem = (line: string) => {
    report.problems.push(line);
    o.log(`! ${line}`);
  };
  const verb = o.apply ? '' : 'would ';
  const handed = new Set<string>();
  for (const a of o.handoff.accounts) {
    if (!a.owner || !/^user_[0-9A-Z]{26}$/.test(a.owner)) {
      problem(`${a.kazi_id}: no WorkOS user id; not carried`);
      continue;
    }
    handed.add(a.owner);
    const owner = a.owner;
    const user = await workosUser(o.workosKey, owner);
    if (!user) {
      problem(`${a.kazi_id} ${owner}: no such WorkOS user; not carried`);
      continue;
    }
    const link = await o.records
      .collection(LEDGER_LINKS, { owner })
      .get('link')
      .catch(() => undefined);
    const customer = user.metadata?.stripe_customer_id || undefined;
    // Payments Kazi never saw: made after it took the hand-off.
    const later: NewEntry[] = [];
    if (customer)
      for (const pi of await customerPayments(o.stripeKey, customer))
        for (const e of await paymentEntries(o.stripeKey, pi)) {
          const handedOver = a.entries.some((h) => h.id === e.id);
          if (handedOver) continue;
          if ((e.at ?? '') > o.handoff.taken_at) later.push(e);
          else
            problem(`${owner}: Stripe ${e.id} (${e.credits}) is before the hand-off but not in it`);
        }
    const opening = Math.round((a.balance - sum(a.entries)) * 1e6) / 1e6;
    const entries: NewEntry[] = [
      {
        id: `opening:${a.kazi_id}`,
        kind: 'opening',
        credits: opening,
        at: o.handoff.taken_at,
        reason: `balance in Kazi's ledger at the split (${a.balance}), less what is entered beside it`,
      },
      ...a.entries,
    ];
    const refill = a.refill && packOf(a.refill) ? { pack: a.refill } : null;
    if (a.refill && !refill) problem(`${owner}: refill pack ${a.refill} is not ours; left off`);
    const known = await o.ledger.get(owner);
    if (!known) {
      o.log(
        `${verb}open ${owner} (${a.email ?? user.email}): balance ${a.balance} = opening ${opening} + ${a.entries.length} entries${refill ? `, refill ${refill.pack}` : ''}${link?.used_before ? `, used before ${link.used_before}` : ''}${later.length ? `, ${later.length} later payments` : ''}`,
      );
      if (o.apply)
        await o.ledger.open(owner, async () => ({
          used_before: link?.used_before ?? 0,
          refill,
          ...(customer ? { stripe_customer_id: customer } : {}),
          ...(a.apple_account_token ? { apple_account_token: a.apple_account_token } : {}),
          entries,
        }));
      report.opened++;
    }
    // Run again, or opened since: only what is missing goes in.
    const have = new Set(known ? (await o.ledger.entries(owner)).map((e) => e.id) : []);
    for (const e of [...(known ? entries : []), ...later]) {
      if (have.has(e.id)) {
        if (e.id.startsWith('opening:')) {
          const stored = (await o.ledger.entries(owner)).find((x) => x.id === e.id);
          if (stored && Math.abs(stored.credits - e.credits) > 1e-6)
            problem(`${owner}: ${e.id} is ${stored.credits} here, the hand-off says ${e.credits}`);
        }
        continue;
      }
      if (e.kind === 'spend') {
        problem(`${owner}: release ${e.id} is missing and can only go in when the account opens`);
        continue;
      }
      o.log(`${verb}add ${owner} ${e.kind} ${e.id} ${e.credits}`);
      if (o.apply) await o.ledger.credit(owner, e);
      report.topped++;
    }
    if (a.unmetered) {
      const tag = user.metadata?.plan;
      if (taggedPlan(tag)) o.log(`${owner}: unmetered in Kazi, already plan ${tag}; left as it is`);
      else {
        o.log(`${verb}tag ${owner} plan lifetime (unmetered in Kazi)`);
        if (o.apply) await tagLifetime(o.workosKey, owner, user.metadata ?? {});
        report.lifetime++;
      }
    }
  }
  // Accounts linked to Kazi's ledger that Kazi did not hand over: Kazi opened them, so they start
  // as a new account does here, with nothing carried.
  for (const owner of await o.records.owners()) {
    if (!/^user_[0-9A-Z]{26}$/.test(owner) || handed.has(owner)) continue;
    const link = await o.records
      .collection(LEDGER_LINKS, { owner })
      .get('link')
      .catch(() => undefined);
    if (!link?.account_id || (await o.ledger.get(owner))) continue;
    o.log(
      `${verb}start ${owner} (Kazi's ${link.account_id}, not handed over) with ${FREE_CREDITS}`,
    );
    if (o.apply)
      await o.ledger.open(owner, async () => ({
        used_before: link.used_before ?? 0,
        entries: [{ id: 'grant:activation', kind: 'grant', credits: FREE_CREDITS }],
      }));
    report.started++;
  }
  o.log(
    `${o.apply ? 'done' : 'dry run'}: ${report.opened} opened, ${report.topped} entries added, ${report.lifetime} tagged lifetime, ${report.started} started fresh, ${report.problems.length} problems`,
  );
  return report;
}

/** One difference between our ledger and the hand-off, or within our ledger. */
export interface Difference {
  owner: string;
  what: string;
}

/**
 * Compares our ledger with the hand-off: each handed account's balance as it stood at `taken_at`
 * (its entries up to then) against Kazi's, accounts missing either way, and every account's
 * stored balance and totals against its entries summed again.
 */
export async function reconcile(o: {
  handoff: Handoff;
  ledger: Ledger;
}): Promise<{ checked: number; differences: Difference[] }> {
  const differences: Difference[] = [];
  const handed = new Map<string, HandedAccount>();
  for (const a of o.handoff.accounts) if (a.owner) handed.set(a.owner, a);
  const ours = new Set(await o.ledger.owners());
  for (const [owner, a] of handed) {
    if (!ours.has(owner)) {
      differences.push({ owner, what: `in the hand-off (${a.balance}) but not in our ledger` });
      continue;
    }
    const entries = await o.ledger.entries(owner);
    const then = totals(entries.filter((e) => e.at <= o.handoff.taken_at)).balance;
    if (Math.abs(then - a.balance) > 1e-6)
      differences.push({
        owner,
        what: `balance at the split is ${then} here, ${a.balance} in Kazi’s ledger`,
      });
  }
  for (const owner of ours) {
    const account = await o.ledger.get(owner);
    const entries = await o.ledger.entries(owner);
    const summed = totals(entries);
    for (const field of Object.keys(summed) as (keyof typeof summed)[])
      if (account && Math.abs(account[field] - summed[field]) > 1e-6)
        differences.push({
          owner,
          what: `${field} is ${account[field]}, its entries sum to ${summed[field]}`,
        });
  }
  return { checked: ours.size, differences };
}

const sum = (entries: readonly Pick<CreditEntry, 'credits'>[] | NewEntry[]) =>
  entries.reduce((n, e) => n + e.credits, 0);

interface WorkosUser {
  id: string;
  email: string;
  metadata?: Record<string, string>;
}

async function workosUser(key: string, id: string): Promise<WorkosUser | undefined> {
  const res = await fetch(
    `https://api.workos.com/user_management/users/${encodeURIComponent(id)}`,
    {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    },
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
