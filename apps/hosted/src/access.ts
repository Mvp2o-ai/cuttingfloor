import { fromLookupKey, GRACE_DAYS, PLANS, type PlanId, taggedPlan } from '@cuttingfloor/plans';
import { CfError } from '@cuttingfloor/schema';
import { meteredSeconds, type OwnerLimits, type Runtime } from '@cuttingfloor/server';

// Who may work on the hosted server, decided without a database: WorkOS holds the account (when
// it began, whether its email is verified, a `plan` tag for given plans), Stripe holds the
// subscription. They are linked by the user's `stripe_customer_id` metadata, which the site
// writes at checkout. Render time comes from the meter files under the data root.
//
// It fails closed: when WorkOS or Stripe can't be reached the call is refused as retryable,
// never let through. Paying people meet at most a short retry; nobody gets a free pass.

export type Access =
  | {
      allowed: true;
      plan: PlanId;
      /** The span credits count over: a free account's whole life, the billing period, or the month. */
      period: { start: string; end: string };
      email: string;
      /** Set while a failed payment is in its grace days: when access stops. */
      grace_ends?: string;
    }
  | {
      allowed: false;
      reason: 'payment_failed' | 'email_unverified';
      /** When the grace days ended. */
      ended?: string;
      email: string;
    };

export interface Usage {
  plan: PlanId;
  period: { start: string; end: string };
  used_minutes: number;
  included_minutes: number | null;
}

export interface AccessOptions {
  workosKey: string;
  stripeKey: string;
  /** Where people subscribe and manage billing; named in refusals. */
  accountUrl: string;
  /** The data root's workspace, for render time used. Without it, minutes are not capped. */
  ws?: Runtime['ws'];
  now?: () => number;
}

// Statuses that keep access; past_due only for its grace days.
const PAYING = new Set(['active', 'trialing', 'past_due']);
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
    if (access.reason === 'email_unverified')
      throw new CfError('email_unverified', `${access.email} is not verified yet`, {
        hint: `Open the verification email from cuttingfloor (or sign in at ${account} to get a new one), then call the tool again`,
        detail: { account },
      });
    throw new CfError(
      'subscription_required',
      `The last payment failed and the ${GRACE_DAYS} days to fix it ended on ${day(access.ended)}`,
      {
        hint: `Update the card at ${account} (sign in with the same account), then call the tool again. Media and exports are kept 7 days, timelines 24 hours after last use`,
        detail: { reason: access.reason, ended: access.ended, account },
      },
    );
  }

  /** The owner's plan as limits on the work they start, with a refusal once the credits are used. */
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
    const usage = await this.usage(owner, access);
    if (usage.included_minutes !== null && usage.used_minutes >= usage.included_minutes) {
      const account = this.#o.accountUrl;
      const free = access.plan === 'free';
      // The plans page only describes them: ChatGPT's plugin rules allow pointing to plans, not
      // to where they are bought.
      const plans = new URL('/pricing', account);
      out.refuseJobs = new CfError(
        'quota_exceeded',
        free
          ? `This account's ${usage.included_minutes} free credits are used`
          : `This period's ${usage.included_minutes} credits are used`,
        {
          hint: `${free ? 'Free credits do not renew; the plans' : `They renew on ${day(usage.period.end)}; the plans`} are described at ${plans}. A credit is one minute of a job running. Editing the timeline and previews still work; only new jobs (exports, imports, analysis, create.*) wait`,
          detail: {
            used_minutes: usage.used_minutes,
            included_minutes: usage.included_minutes,
            ...(free ? {} : { renews: usage.period.end }),
            account,
          },
        },
      );
    }
    return out;
  }

  /** Credits (render minutes) used this period against the plan's. */
  async usage(owner: string, known?: Access & { allowed: true }): Promise<Usage> {
    const access = known ?? (await this.require(owner));
    const included = PLANS[access.plan].limits.renderMinutes;
    let seconds = 0;
    if (this.#o.ws) {
      const hit = this.#usage.get(owner);
      if (hit && hit.since === access.period.start && this.#o.now() - hit.at < USAGE_TTL)
        seconds = hit.seconds;
      else {
        seconds = await meteredSeconds(this.#o.ws, owner, new Date(access.period.start));
        this.#usage.set(owner, { at: this.#o.now(), seconds, since: access.period.start });
      }
    }
    return {
      plan: access.plan,
      period: access.period,
      used_minutes: Math.round((seconds / 60) * 10) / 10,
      included_minutes: included,
    };
  }

  /** Forgets what is cached for an owner (a subscription changed). */
  forget(owner: string): void {
    this.#cache.delete(owner);
    this.#usage.delete(owner);
  }

  /** Counts a job that just ended against the cached usage, so a cap shows without a reread. */
  addSeconds(owner: string, seconds: number): void {
    const hit = this.#usage.get(owner);
    if (hit) hit.seconds += seconds;
  }

  /** The owner's access, cached briefly; a refusal is rechecked soon so a new subscription shows. */
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
    const now = this.#o.now();
    const user = await this.#workos(`/user_management/users/${encodeURIComponent(owner)}`);
    const email = String(user.email ?? '');
    const metadata = (user.metadata ?? {}) as Record<string, string>;
    const tagged = taggedPlan(metadata.plan);
    if (tagged) return { allowed: true, plan: tagged, period: month(now), email };

    const customer = metadata.stripe_customer_id;
    let lapsed: string | undefined;
    if (customer) {
      const subs = await this.#stripe(
        `/v1/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=20`,
      );
      for (const sub of (subs.data ?? []) as StripeSubscription[]) {
        if (!PAYING.has(sub.status)) continue;
        const item = sub.items?.data?.[0];
        const named = fromLookupKey(item?.price?.lookup_key);
        const plan = named?.plan ?? 'pro';
        const start = (item?.current_period_start ?? sub.current_period_start ?? now / 1000) * 1000;
        const end = (item?.current_period_end ?? sub.current_period_end ?? now / 1000) * 1000;
        // Minutes are a month's however the plan is billed: a yearly one counts each month of its year.
        const period =
          (named?.interval ?? item?.price?.recurring?.interval) === 'year'
            ? monthOfYear(start, end, now)
            : { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
        if (sub.status !== 'past_due') return { allowed: true, plan, period, email };
        // A failed renewal keeps working while Stripe retries the card, for GRACE_DAYS.
        const grace = start + GRACE_DAYS * 86_400_000;
        if (now < grace)
          return { allowed: true, plan, period, email, grace_ends: new Date(grace).toISOString() };
        lapsed = new Date(grace).toISOString();
      }
    }
    if (lapsed) return { allowed: false, reason: 'payment_failed', ended: lapsed, email };
    // Checked after the subscription: a paying account is never held back for its email.
    if (user.email_verified === false) return { allowed: false, reason: 'email_unverified', email };

    // Free credits count from sign-up and never renew. The meter keeps 13 months, so the period
    // ends then: credits used before it are no longer counted.
    const began = Date.parse(String(user.created_at));
    return {
      allowed: true,
      plan: 'free',
      period: {
        start: new Date(began).toISOString(),
        end: new Date(addMonths(began, 13)).toISOString(),
      },
      email,
    };
  }

  async #workos(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`https://api.workos.com${path}`, {
      headers: { authorization: `Bearer ${this.#o.workosKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`WorkOS ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async #stripe(path: string): Promise<{ data?: unknown[] }> {
    const res = await fetch(`https://api.stripe.com${path}`, {
      headers: { authorization: `Bearer ${this.#o.stripeKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Stripe ${res.status}`);
    return (await res.json()) as { data?: unknown[] };
  }
}

/** The calendar month (UTC) `now` falls in: the period for plans that aren't billed by Stripe. */
function month(now: number): { start: string; end: string } {
  const d = new Date(now);
  return {
    start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(),
  };
}

/** The month of a yearly billing period that `now` falls in, on the period's own day of the month. */
function monthOfYear(start: number, end: number, now: number): { start: string; end: string } {
  let k = 0;
  while (k < 11 && now >= addMonths(start, k + 1)) k++;
  return {
    start: new Date(addMonths(start, k)).toISOString(),
    end: new Date(Math.min(addMonths(start, k + 1), end)).toISOString(),
  };
}

/** `t` moved on `k` calendar months (UTC), kept to the last day of a shorter month. */
function addMonths(t: number, k: number): number {
  const d = new Date(t);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k + 1, 0)).getUTCDate();
  const moved = new Date(d);
  moved.setUTCDate(1);
  moved.setUTCMonth(d.getUTCMonth() + k);
  moved.setUTCDate(Math.min(d.getUTCDate(), last));
  return moved.getTime();
}

function day(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : 'an earlier date';
}

interface StripeSubscription {
  status: string;
  current_period_start?: number;
  current_period_end?: number;
  items?: {
    data?: {
      current_period_start?: number;
      current_period_end?: number;
      price?: { lookup_key?: string | null; recurring?: { interval?: string } | null };
    }[];
  };
}
