import { FREE_CREDITS, freeCreditsFor, PLANS, type PlanId, taggedPlan } from '@cuttingfloor/plans';
import { CfError } from '@cuttingfloor/schema';
import { meteredSeconds, type OwnerLimits, type Runtime } from '@cuttingfloor/server';
import type { CreditAccount, Ledger, NewEntry, Opening } from './ledger.ts';
import { isUser } from './rights.ts';
import { customerPayments, paymentEntries } from './stripe-credits.ts';

/**
 * Jobs one account runs at once on a server, whatever its plan; more wait their turn before they
 * queue for the server's slots. Not a plan feature: it keeps one account's burst from filling the
 * queues everyone shares (the server's own slots cap the load).
 */
const OWNER_JOBS = 4;

/** Plans given rather than bought: their files never have the watermark. */
const GIVEN = new Set<PlanId>(['staff', 'lifetime', 'enterprise']);

// Who may work on the hosted server, and how many credits they have: WorkOS holds the account
// (when it began, whether its email is verified, a `plan` tag for given plans, its Stripe
// customer), and cuttingfloor's own credit ledger (ledger.ts) holds the balance. An account's
// ledger account is opened the first time it is checked, with the activation grant and, for an
// account from before any ledger, the balance it had here (its free credits less what it used,
// and each pack it bought). A given plan (staff, lifetime, enterprise) never touches the ledger:
// its credits renew each calendar month and are counted from the meter files under the data
// root. Only the `plan` tag gives one.
//
// It fails closed: when WorkOS or the ledger can't be reached the call is refused as retryable,
// never let through. Paying people meet at most a short retry; nobody gets a free pass. What
// WorkOS says is kept 5 minutes; the balance is read again after 2 seconds, so a spend or a
// payment on one server shows on every server at once.

export type Access =
  | {
      allowed: true;
      plan: PlanId;
      email: string;
      /** When the account began: a balance counts credits used from here. */
      created_at: string;
      /** The account's Stripe customer, once it has been to checkout. */
      customer?: string;
    }
  | { allowed: false; reason: 'email_unverified'; email: string };

/** An account's credits: left, used, and where they came from. */
export interface Balance {
  plan: PlanId;
  /** Credits left; null when the plan has no cap. */
  left: number | null;
  /** Credits used: since the account began (a balance), or this month (a given plan). */
  used: number;
  /** Free credits the account started with (a balance; 0 otherwise). */
  free: number;
  /** Credits bought in packs, after refunds (a balance; 0 otherwise). */
  bought: number;
  /** A given plan's credits each month; null for a balance or no cap. */
  per_month: number | null;
  /** When a given plan's credits renew; null for a balance, which never renews or expires. */
  renews: string | null;
  /** Where credits used are counted from: the account's start, or this month's. */
  since: string;
  /** The pack bought on its own when the balance runs low (a balance; else null). */
  refill: string | null;
}

export interface AccessOptions {
  workosKey: string;
  stripeKey: string;
  /** The credit ledger, where every account without a given plan keeps its balance. */
  ledger: Ledger;
  /** Where people buy credits and see their balance; named in refusals. */
  accountUrl: string;
  /** The data root's workspace: credits used on a given plan, and before the ledger. */
  ws: Runtime['ws'];
  now?: () => number;
}

const ALLOWED_TTL = 5 * 60_000;
const DENIED_TTL = 20_000;
const USAGE_TTL = 15_000;
/** A balance read this recently is answered again without a read. */
const ACCOUNT_TTL = 2_000;

export class AccessCheck {
  #o: AccessOptions & { now: () => number };
  #cache = new Map<string, { at: number; value: Access }>();
  #usage = new Map<string, { at: number; seconds: number; since: string }>();
  #accounts = new Map<string, { at: number; account: CreditAccount }>();

  constructor(options: AccessOptions) {
    this.#o = { now: Date.now, ...options };
  }

  /** Refuses an owner who may not work, saying why and what to do. */
  async require(owner: string): Promise<Access & { allowed: true }> {
    const access = await this.get(owner);
    if (access.allowed) return access;
    throw new CfError('email_unverified', `${access.email} is not verified yet`, {
      hint: 'Open the verification email from cuttingfloor (check spam too), then call the tool again',
    });
  }

  /**
   * The owner's plan as limits on the work they start: jobs at once, largest export, storage.
   * Credits never stop work (making is free); they remove watermarks (the download gate).
   */
  async limits(owner: string, _options: { buy?: boolean } = {}): Promise<OwnerLimits> {
    const access = await this.require(owner);
    const limits = PLANS[access.plan].limits;
    return {
      jobs: OWNER_JOBS,
      ...(limits.shortSide !== null ? { shortSide: limits.shortSide } : {}),
      ...(limits.storageGb !== null ? { storageBytes: limits.storageGb * 1e9 } : {}),
      ...(access.plan !== 'staff' && access.plan !== 'enterprise'
        ? { account: new URL('/pricing', this.#o.accountUrl).href }
        : {}),
    };
  }

  /** Whether the owner is on a given plan (staff, lifetime, enterprise), whose files are never watermarked. */
  async exempt(owner: string): Promise<boolean> {
    // Not a person's account (a maintenance key's owner): nothing to sell it.
    if (!isUser(owner)) return true;
    const access = await this.get(owner);
    return access.allowed && GIVEN.has(access.plan);
  }

  /** The owner's credits: left, used, and where they came from. */
  async balance(owner: string, known?: Access & { allowed: true }): Promise<Balance> {
    const access = known ?? (await this.require(owner));
    if (PLANS[access.plan].credits.kind === 'balance') {
      const account = await this.#account(owner, access);
      // What was used before the ledger shows too, and the free credits are what make the sum
      // come out: free + bought - used = left.
      return {
        plan: access.plan,
        left: round(account.balance),
        used: round(account.used_total + account.used_before),
        free: round(account.granted_total + account.opening_total + account.used_before),
        bought: round(account.bought_total),
        per_month: null,
        renews: null,
        since: access.created_at,
        refill: account.refill?.pack ?? null,
      };
    }
    const credits = PLANS[access.plan].credits;
    const now = this.#o.now();
    const since = credits.kind === 'monthly' ? month(now).start : access.created_at;
    const used = round((await this.#seconds(owner, since)) / 60);
    const base = { plan: access.plan, used, since, free: 0, bought: 0, refill: null };
    if (credits.kind === 'monthly')
      return {
        ...base,
        left: round(credits.perMonth - used),
        per_month: credits.perMonth,
        renews: month(now).end,
      };
    return { ...base, left: null, per_month: null, renews: null };
  }

  /** Sets the pack bought on its own when the balance runs low, or null for off. */
  async setRefill(owner: string, pack: string | null): Promise<void> {
    const access = await this.require(owner);
    if (PLANS[access.plan].credits.kind !== 'balance')
      throw new Error('a given plan has no top-up');
    await this.#account(owner, access);
    const account = await this.#o.ledger.update(owner, { refill: pack ? { pack } : null });
    if (account) this.#accounts.set(owner, { at: this.#o.now(), account });
  }

  /**
   * The owner's ledger account, read again after ACCOUNT_TTL; opened the first time, and told
   * about a Stripe customer made since.
   */
  async #account(
    owner: string,
    access: { created_at: string; customer?: string },
  ): Promise<CreditAccount> {
    const hit = this.#accounts.get(owner);
    if (hit && this.#o.now() - hit.at < ACCOUNT_TTL) return hit.account;
    let account = await this.#o.ledger.open(owner, () =>
      this.#opening(owner, access.created_at, access.customer),
    );
    if (access.customer && account.stripe_customer_id !== access.customer)
      account =
        (await this.#o.ledger.update(owner, { stripe_customer_id: access.customer })) ?? account;
    this.#accounts.set(owner, { at: this.#o.now(), account });
    return account;
  }

  /**
   * What a new ledger account opens with: the activation grant, and for an account from before
   * any ledger the rest of the free credits it started with, less what it used (`opening:carry`),
   * and each pack it bought with any refund.
   */
  async #opening(owner: string, created_at: string, customer?: string): Promise<Opening> {
    const used_before = round3(
      (await meteredSeconds(this.#o.ws, owner, new Date(created_at), new Date(this.#o.now()))) / 60,
    );
    const carry = round3(freeCreditsFor(created_at) - used_before - FREE_CREDITS);
    const entries: NewEntry[] = [
      { id: 'grant:activation', kind: 'grant', credits: FREE_CREDITS },
      ...(carry
        ? [
            {
              id: 'opening:carry',
              kind: 'opening' as const,
              credits: carry,
              reason: 'free credits from before the ledger, less what was used',
            },
          ]
        : []),
    ];
    if (customer)
      for (const pi of await customerPayments(this.#o.stripeKey, customer))
        entries.push(...(await paymentEntries(this.#o.stripeKey, pi)));
    return { used_before, entries, ...(customer ? { stripe_customer_id: customer } : {}) };
  }

  /** The owner's ledger account if it was ever opened, without opening it (the admin API). */
  opened(owner: string): Promise<CreditAccount | undefined> {
    return this.#o.ledger.get(owner);
  }

  /**
   * The owner's ledger account, opened if need be whatever its plan or email: a payment lands on
   * it even for an account on a given plan, or one not verified yet.
   */
  async creditAccount(owner: string): Promise<CreditAccount> {
    const known = await this.#o.ledger.get(owner);
    if (known) return known;
    const user = await this.#workos(`/user_management/users/${encodeURIComponent(owner)}`);
    const metadata = (user.metadata ?? {}) as Record<string, string>;
    const created_at = new Date(Date.parse(String(user.created_at))).toISOString();
    const customer = metadata.stripe_customer_id || undefined;
    return this.#account(owner, { created_at, ...(customer ? { customer } : {}) });
  }

  async #seconds(owner: string, since: string): Promise<number> {
    const hit = this.#usage.get(owner);
    if (hit && hit.since === since && this.#o.now() - hit.at < USAGE_TTL) return hit.seconds;
    const seconds = await meteredSeconds(this.#o.ws, owner, new Date(since));
    this.#usage.set(owner, { at: this.#o.now(), seconds, since });
    return seconds;
  }

  /** Forgets what is cached for an owner (credits bought, a setting changed). */
  forget(owner: string): void {
    this.#cache.delete(owner);
    this.#usage.delete(owner);
    this.#accounts.delete(owner);
  }

  /** Counts a job that just ended against the cached usage, so a cap shows without a reread. */
  addSeconds(owner: string, seconds: number): void {
    const hit = this.#usage.get(owner);
    if (hit) hit.seconds += seconds;
  }

  /** The balance after a spend, so it shows without a reread. */
  spent(owner: string, balance: number): void {
    const hit = this.#accounts.get(owner);
    if (hit) hit.account = { ...hit.account, balance };
  }

  /** The owner's access, cached briefly; a refusal is rechecked soon so a change shows. */
  async get(owner: string): Promise<Access> {
    const hit = this.#cache.get(owner);
    if (hit && this.#o.now() - hit.at < (hit.value.allowed ? ALLOWED_TTL : DENIED_TTL))
      return hit.value;
    let value: Access;
    try {
      value = await this.resolve(owner);
    } catch (error) {
      process.stderr.write(`access: ${owner}: ${(error as Error).message}\n`);
      // Someone already let in keeps working through a short outage; nobody new gets in.
      if (hit?.value.allowed && this.#o.now() - hit.at < 30 * 60_000) return hit.value;
      throw new CfError('service_unavailable', 'Your account could not be checked just now', {
        hint: 'Call the tool again in a minute',
        detail: { retry: true, retry_after_seconds: 60 },
      });
    }
    this.#cache.set(owner, { at: this.#o.now(), value });
    return value;
  }

  /** Works out access from WorkOS and the ledger, uncached. Throws when either can't answer. */
  async resolve(owner: string): Promise<Access> {
    const user = await this.#workos(`/user_management/users/${encodeURIComponent(owner)}`);
    const email = String(user.email ?? '');
    const metadata = (user.metadata ?? {}) as Record<string, string>;
    const created_at = new Date(Date.parse(String(user.created_at))).toISOString();
    const customer = metadata.stripe_customer_id || undefined;
    const tagged = taggedPlan(metadata.plan);
    const base = { allowed: true as const, email, created_at, ...(customer ? { customer } : {}) };
    if (tagged) return { ...base, plan: tagged };
    if (user.email_verified === false) return { allowed: false, reason: 'email_unverified', email };
    const account = await this.#account(owner, base);
    return { ...base, plan: account.bought_total > 0 ? 'credits' : 'free' };
  }

  /** The customer's cuttingfloor payments that went through, newest first, with any refund. */
  async payments(customer: string): Promise<Payment[]> {
    return (await customerPayments(this.#o.stripeKey, customer, { expandCharge: true })).map(
      (pi) => {
        const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : undefined;
        return {
          at: new Date((pi.created ?? 0) * 1000).toISOString(),
          credits: Number(pi.metadata?.credits) || 0,
          amount: (pi.amount_received ?? 0) / 100,
          refunded: (charge?.amount_refunded ?? 0) / 100,
          currency: pi.currency ?? 'usd',
        };
      },
    );
  }

  async #workos(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`https://api.workos.com${path}`, {
      headers: { authorization: `Bearer ${this.#o.workosKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`WorkOS ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

/** The calendar month (UTC) `now` falls in: the period a given plan's credits count over. */
function month(now: number): { start: string; end: string } {
  const d = new Date(now);
  return {
    start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(),
  };
}

// Hundredths: removing a watermark is priced in quarter credits.
const round = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A payment, in the currency's main unit (dollars, not cents). */
export interface Payment {
  at: string;
  credits: number;
  amount: number;
  refunded: number;
  currency: string;
}
