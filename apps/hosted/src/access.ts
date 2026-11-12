import {
  FREE_CREDITS,
  freeCreditsFor,
  PLANS,
  type PlanId,
  SUPPORT_EMAIL,
  taggedPlan,
} from '@cuttingfloor/plans';
import { CfError } from '@cuttingfloor/schema';
import { meteredSeconds, type OwnerLimits, type Runtime } from '@cuttingfloor/server';
import { type Ledger, type LedgerAccount, LedgerConflict, LedgerMissing } from './ledger.ts';

/**
 * Jobs one account runs at once on a server, whatever its plan; more wait their turn before they
 * queue for the server's slots. Not a plan feature: it keeps one account's burst from filling the
 * queues everyone shares (the server's own slots cap the load).
 */
const OWNER_JOBS = 4;

// Who may work on the hosted server, and how many credits they have, decided without a database:
// WorkOS holds the account (when it began, whether its email is verified, a `plan` tag for given
// plans, its Stripe customer), and Kazi's credit ledger holds the balance, shared by both products:
// credits bought on either site spend on either. An account is linked to the ledger the first time
// it is checked, carrying over the balance it had here (its free credits less what it used, and
// each pack it bought) and keeping when it was linked (`owners/{owner}/ledger/link.json`); every
// job that ends after that is reported to the ledger (lifecycle.ts). A given plan (staff, lifetime,
// enterprise) never touches the ledger: its credits renew each calendar month and are counted
// from the meter files under the data root. A Kazi member the ledger calls unmetered (Kazi's
// lifetime or staff) has lifetime here, read from the ledger on each check.
//
// It fails closed: when WorkOS or the ledger can't be reached the call is refused as retryable,
// never let through. Paying people meet at most a short retry; nobody gets a free pass.

export type Access =
  | {
      allowed: true;
      plan: PlanId;
      email: string;
      /** When the account began: a balance counts credits used from here. */
      created_at: string;
      /** The account's Stripe customer, once it has been to checkout. */
      customer?: string;
      /** The ledger account, for every account without a given plan. */
      ledger?: Link;
    }
  | { allowed: false; reason: 'email_unverified'; email: string };

/** An account's link to the ledger, kept with its data. */
export interface Link {
  account_id: string;
  /** When it was linked: jobs that ended from here on are reported to the ledger. */
  since: string;
  /** Credits it used here before it was linked, so what it has used shows in full. */
  used_before: number;
  /** The Stripe customer the ledger was last told about. */
  customer?: string;
}

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
  /** The pack the ledger buys on its own when the balance runs low (a balance; else null). */
  refill: string | null;
}

export interface AccessOptions {
  workosKey: string;
  stripeKey: string;
  /** Kazi's credit ledger, where every account without a given plan keeps its balance. */
  ledger: Ledger;
  /** Where people buy credits and see their balance; named in refusals. */
  accountUrl: string;
  /** The data root's workspace: ledger links, and credits used on a given plan. */
  ws: Runtime['ws'];
  now?: () => number;
}

const ALLOWED_TTL = 5 * 60_000;
const DENIED_TTL = 20_000;
const USAGE_TTL = 15_000;

/** Where an owner's ledger link is kept. */
export const linkPath = (ws: Runtime['ws'], owner: string) =>
  ws.ownerDir(owner, 'ledger', 'link.json');

export class AccessCheck {
  #o: AccessOptions & { now: () => number };
  #cache = new Map<string, { at: number; value: Access }>();
  #usage = new Map<string, { at: number; seconds: number; since: string }>();
  #accounts = new Map<string, { at: number; account: LedgerAccount }>();

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

  /** The owner's plan as limits on the work they start, with a refusal once no credits are left. */
  async limits(owner: string): Promise<OwnerLimits> {
    const access = await this.require(owner);
    const limits = PLANS[access.plan].limits;
    const out: OwnerLimits = {
      jobs: OWNER_JOBS,
      ...(limits.shortSide !== null ? { shortSide: limits.shortSide } : {}),
      ...(limits.judgmentsPerDay !== null ? { judgmentsPerDay: limits.judgmentsPerDay } : {}),
      ...(limits.storageGb !== null ? { storageBytes: limits.storageGb * 1e9 } : {}),
      ...(access.plan !== 'staff' && access.plan !== 'enterprise'
        ? { account: new URL('/pricing', this.#o.accountUrl).href }
        : {}),
    };
    const balance = await this.balance(owner, access);
    if (balance.left !== null && balance.left <= 0) {
      // Information only (ChatGPT's plugin rules): say what stopped and link the pricing page,
      // never the account page where credits are bought.
      const plans = new URL('/pricing', this.#o.accountUrl).href;
      const monthly = balance.renews !== null;
      out.refuseJobs = new CfError(
        'quota_exceeded',
        monthly
          ? `This month's ${balance.per_month} credits are used`
          : 'This account has no credits left',
        {
          hint: `${monthly ? `They renew on ${balance.renews?.slice(0, 10)}. ` : ''}New jobs (exports, imports, analysis, create.*) won't start until there are credits again; editing the timeline and previews still work. Ask again after. A credit is one minute of a job running. How credits work: ${plans}`,
          detail: {
            credits_left: balance.left,
            credits_used: balance.used,
            ...(monthly ? { renews: balance.renews } : {}),
            plans,
          },
        },
      );
    }
    return out;
  }

  /** The owner's credits: left, used, and where they came from. */
  async balance(owner: string, known?: Access & { allowed: true }): Promise<Balance> {
    const access = known ?? (await this.require(owner));
    if (access.ledger) {
      const link = access.ledger;
      const account = await this.#account(owner, link);
      // The ledger counts from the link; what was used here before it shows too, and the free
      // credits are what make the sum come out: free + bought - used = left.
      const used = round(account.used_total + link.used_before);
      return {
        plan: access.plan,
        left: round(account.balance),
        used,
        free: round(account.granted_total + account.opening_total + link.used_before),
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

  /** Sets the pack the ledger buys on its own when the balance runs low, or null for off. */
  async setRefill(owner: string, pack: string | null): Promise<void> {
    const access = await this.require(owner);
    if (!access.ledger) throw new Error('a given plan has no top-up');
    const account = await this.#o.ledger.refill(access.ledger.account_id, pack);
    this.#accounts.set(owner, { at: this.#o.now(), account });
  }

  /** The ledger account, read again after a short while (spending on Kazi moves it too). */
  async #account(owner: string, link: Link): Promise<LedgerAccount> {
    const hit = this.#accounts.get(owner);
    if (hit && hit.account.account_id === link.account_id && this.#o.now() - hit.at < USAGE_TTL)
      return hit.account;
    let account: LedgerAccount;
    try {
      account = await this.#o.ledger.balance(link.account_id);
    } catch (error) {
      if (!(error instanceof LedgerMissing)) throw error;
      // The ledger lost it (removed by hand): link again, from now.
      await this.#o.ws.remove(linkPath(this.#o.ws, owner)).catch(() => undefined);
      this.#cache.delete(owner);
      const access = await this.require(owner);
      if (!access.ledger) throw error;
      return this.#account(owner, access.ledger);
    }
    this.#accounts.set(owner, { at: this.#o.now(), account });
    return account;
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

  /** The ledger's balance after a job was spent, so a cap shows without a reread. */
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
      if (error instanceof LedgerConflict)
        throw new CfError('service_unavailable', 'This account’s credits could not be found', {
          hint: `Its email already has credits with another cuttingfloor account. Write to ${SUPPORT_EMAIL} to join them`,
          detail: { retry: false },
        });
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
    // Only a verified email joins a ledger account (the ledger matches people by it).
    if (user.email_verified === false) return { allowed: false, reason: 'email_unverified', email };
    const link = await this.#link(owner, email, created_at, customer);
    const account = link.account ?? (await this.#account(owner, link.link));
    if (link.account) this.#accounts.set(owner, { at: this.#o.now(), account: link.account });
    // A Kazi member with lifetime (or staff) has cuttingfloor's lifetime: its credits renew each
    // month here and never touch the ledger. It follows the ledger's flag, so it never drifts.
    if (account.unmetered) return { ...base, plan: 'lifetime' };
    return {
      ...base,
      plan: account.bought_total > 0 ? 'credits' : 'free',
      ledger: link.link,
    };
  }

  /**
   * The owner's ledger link, made the first time with the balance it had here (and told the
   * ledger about a Stripe customer made since). Answers the ledger account when it called it.
   *
   * The moment it counts from is claimed first, in the link file, and the carry-over is worked
   * out from that file, so a retry after a crash, or another server linking at the same time,
   * sends the same carry-over and reports jobs from the same moment: none is in both, or neither.
   */
  async #link(
    owner: string,
    email: string,
    created_at: string,
    customer: string | undefined,
  ): Promise<{ link: Link; account?: LedgerAccount }> {
    const ws = this.#o.ws;
    const file = linkPath(ws, owner);
    let known = await ws.readJson<Partial<Link> & Pick<Link, 'since' | 'used_before'>>(file);
    if (known?.account_id) {
      const link = known as Link;
      if (!customer || link.customer === customer) return { link };
      const account = await this.#o.ledger.account({
        email,
        workos_user_id: owner,
        stripe_customer_id: customer,
      });
      await ws.writeJson(file, { ...link, customer });
      return { link: { ...link, customer }, account };
    }
    if (!known) {
      const since = new Date(this.#o.now());
      const claim = {
        since: since.toISOString(),
        used_before: round3((await meteredSeconds(ws, owner, new Date(created_at), since)) / 60),
      };
      // Another server may have claimed it at the same moment; the first claim stands.
      await ws.writeJson(file, claim, { exclusive: true });
      known = (await ws.readJson<typeof claim>(file)) ?? claim;
    }
    const { since, used_before } = known;
    // The ledger grants its own free credits once per person, so the carry-over leaves them out.
    const opening = {
      credits: round3(freeCreditsFor(created_at) - used_before - FREE_CREDITS),
      purchases: customer ? await this.#purchases(customer) : [],
    };
    const account = await this.#o.ledger.account({
      email,
      workos_user_id: owner,
      ...(customer ? { stripe_customer_id: customer } : {}),
      opening,
    });
    const link: Link = {
      account_id: account.account_id,
      since,
      used_before,
      ...(customer ? { customer } : {}),
    };
    await ws.writeJson(file, link);
    return { link, account };
  }

  /** The customer's paid packs, each less any refunded share. */
  async #purchases(customer: string): Promise<{ payment_intent: string; credits: number }[]> {
    const out: { payment_intent: string; credits: number }[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const list = (await this.#stripe(
        `/v1/payment_intents?customer=${encodeURIComponent(customer)}&limit=100&expand[]=data.latest_charge${after ? `&starting_after=${after}` : ''}`,
      )) as { data?: StripePaymentIntent[]; has_more?: boolean };
      const data = list.data ?? [];
      for (const pi of data) {
        const pack = Number(pi.metadata?.credits);
        if (pi.status !== 'succeeded' || pi.metadata?.app !== 'cuttingfloor' || !(pack > 0))
          continue;
        const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : undefined;
        const refunded = charge?.amount ? (charge.amount_refunded ?? 0) / charge.amount : 0;
        const credits = round3(pack * (1 - Math.min(1, refunded)));
        if (credits > 0) out.push({ payment_intent: pi.id, credits });
      }
      after = data.at(-1)?.id;
      if (!list.has_more || !after) break;
    }
    return out;
  }

  async #workos(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`https://api.workos.com${path}`, {
      headers: { authorization: `Bearer ${this.#o.workosKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`WorkOS ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async #stripe(path: string): Promise<unknown> {
    const res = await fetch(`https://api.stripe.com${path}`, {
      headers: { authorization: `Bearer ${this.#o.stripeKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Stripe ${res.status}`);
    return res.json();
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

const round = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

interface StripePaymentIntent {
  id: string;
  status: string;
  metadata?: Record<string, string>;
  latest_charge?: string | { amount?: number; amount_refunded?: number } | null;
}
