import {
  freeCreditsFor,
  type Pack,
  PLANS,
  type PlanId,
  packOf,
  taggedPlan,
} from '@cuttingfloor/plans';
import { CfError } from '@cuttingfloor/schema';
import { meteredSeconds, type OwnerLimits, type Runtime } from '@cuttingfloor/server';

// Who may work on the hosted server, and how many credits they have, decided without a database:
// WorkOS holds the account (when it began, whether its email is verified, a `plan` tag for given
// plans, the pack it tops up with), Stripe holds the credit packs it bought. They are linked by
// the user's `stripe_customer_id` metadata, which the site writes at checkout. Credits used come
// from the meter files under the data root. A balance is the free credits, plus the packs bought,
// less what was used since the account began; a given plan's credits renew each calendar month.
//
// It fails closed: when WorkOS or Stripe can't be reached the call is refused as retryable,
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
      /** Credits from packs bought, after refunds, and how many purchases made them. */
      bought: { credits: number; purchases: number };
      /** The pack bought on its own when the balance runs low; unset when that is off. */
      refill?: Pack;
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
  /** Purchases so far, so each top-up is claimed once. */
  purchases: number;
  /** Where credits used are counted from: the account's start, or this month's. */
  since: string;
}

export interface AccessOptions {
  workosKey: string;
  stripeKey: string;
  /** Where people buy credits and see their balance; named in refusals. */
  accountUrl: string;
  /** The data root's workspace, for credits used. Without it, credits are not counted. */
  ws?: Runtime['ws'];
  now?: () => number;
}

const ALLOWED_TTL = 5 * 60_000;
const DENIED_TTL = 20_000;
const USAGE_TTL = 15_000;

export class AccessCheck {
  #o: AccessOptions & { now: () => number };
  #cache = new Map<string, { at: number; value: Access }>();
  #usage = new Map<string, { at: number; seconds: number; since: string }>();

  constructor(options: AccessOptions) {
    this.#o = { now: Date.now, ...options };
  }

  /** Refuses an owner who may not work, saying why and what to do. */
  async require(owner: string): Promise<Access & { allowed: true }> {
    const access = await this.get(owner);
    if (access.allowed) return access;
    const account = this.#o.accountUrl;
    throw new CfError('email_unverified', `${access.email} is not verified yet`, {
      hint: `Open the verification email from cuttingfloor (or sign in at ${account} to get a new one), then call the tool again`,
      detail: { account },
    });
  }

  /** The owner's plan as limits on the work they start, with a refusal once no credits are left. */
  async limits(owner: string): Promise<OwnerLimits> {
    const access = await this.require(owner);
    const limits = PLANS[access.plan].limits;
    const out: OwnerLimits = {
      ...(limits.jobs !== null ? { jobs: limits.jobs } : {}),
      ...(limits.shortSide !== null ? { shortSide: limits.shortSide } : {}),
      ...(limits.judgmentsPerDay !== null ? { judgmentsPerDay: limits.judgmentsPerDay } : {}),
      ...(limits.storageGb !== null ? { storageBytes: limits.storageGb * 1e9 } : {}),
      ...(access.plan !== 'staff' && access.plan !== 'enterprise'
        ? { account: this.#o.accountUrl }
        : {}),
    };
    const balance = await this.balance(owner, access);
    if (balance.left !== null && balance.left <= 0) {
      const account = this.#o.accountUrl;
      const monthly = balance.renews !== null;
      out.refuseJobs = new CfError(
        'quota_exceeded',
        monthly
          ? `This month's ${balance.per_month} credits are used`
          : 'This account has no credits left',
        {
          hint: `${monthly ? `They renew on ${balance.renews?.slice(0, 10)}.` : 'Credits are bought in packs on the account page, and never expire.'} The user signs in at ${account} to see and top up their credits. A credit is one minute of a job running. Editing the timeline and previews still work; only new jobs (exports, imports, analysis, create.*) wait`,
          detail: {
            credits_left: balance.left,
            credits_used: balance.used,
            ...(monthly ? { renews: balance.renews } : {}),
            account,
          },
        },
      );
    }
    return out;
  }

  /** The owner's credits: left, used, and where they came from. */
  async balance(owner: string, known?: Access & { allowed: true }): Promise<Balance> {
    const access = known ?? (await this.require(owner));
    const credits = PLANS[access.plan].credits;
    const now = this.#o.now();
    const since = credits.kind === 'balance' ? access.created_at : month(now).start;
    const used = Math.round(((await this.#seconds(owner, since)) / 60) * 10) / 10;
    const base = { plan: access.plan, used, purchases: access.bought.purchases, since };
    if (credits.kind === 'none')
      return { ...base, left: null, free: 0, bought: 0, per_month: null, renews: null };
    if (credits.kind === 'monthly')
      return {
        ...base,
        left: round(credits.perMonth - used),
        free: 0,
        bought: 0,
        per_month: credits.perMonth,
        renews: month(now).end,
      };
    const free = freeCreditsFor(access.created_at);
    return {
      ...base,
      left: round(free + access.bought.credits - used),
      free,
      bought: access.bought.credits,
      per_month: null,
      renews: null,
    };
  }

  async #seconds(owner: string, since: string): Promise<number> {
    if (!this.#o.ws) return 0;
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
  }

  /** Counts a job that just ended against the cached usage, so a cap shows without a reread. */
  addSeconds(owner: string, seconds: number): void {
    const hit = this.#usage.get(owner);
    if (hit) hit.seconds += seconds;
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

  /** Works out access from WorkOS and Stripe, uncached. Throws when either can't answer. */
  async resolve(owner: string): Promise<Access> {
    const user = await this.#workos(`/user_management/users/${encodeURIComponent(owner)}`);
    const email = String(user.email ?? '');
    const metadata = (user.metadata ?? {}) as Record<string, string>;
    const created_at = new Date(Date.parse(String(user.created_at))).toISOString();
    const customer = metadata.stripe_customer_id || undefined;
    const tagged = taggedPlan(metadata.plan);
    const bought =
      customer && !tagged ? await this.#bought(customer) : { credits: 0, purchases: 0 };
    // Checked after purchases: an account that paid is never held back for its email.
    if (!tagged && !bought.purchases && user.email_verified === false)
      return { allowed: false, reason: 'email_unverified', email };
    const refill = packOf(metadata.refill_pack);
    return {
      allowed: true,
      plan: tagged ?? (bought.purchases ? 'credits' : 'free'),
      email,
      created_at,
      ...(customer ? { customer } : {}),
      bought,
      ...(refill && !tagged ? { refill } : {}),
    };
  }

  /** Credits from the customer's paid packs, less any refunded share. */
  async #bought(customer: string): Promise<{ credits: number; purchases: number }> {
    let credits = 0;
    let purchases = 0;
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
        purchases++;
        const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : undefined;
        const refunded = charge?.amount ? (charge.amount_refunded ?? 0) / charge.amount : 0;
        credits += pack * (1 - Math.min(1, refunded));
      }
      after = data.at(-1)?.id;
      if (!list.has_more || !after) break;
    }
    return { credits: round(credits), purchases };
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

interface StripePaymentIntent {
  id: string;
  status: string;
  metadata?: Record<string, string>;
  latest_charge?: string | { amount?: number; amount_refunded?: number } | null;
}
