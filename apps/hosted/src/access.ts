import {
  fromLookupKey,
  GRACE_DAYS,
  PLANS,
  type PlanId,
  TRIAL_DAYS,
  taggedPlan,
} from '@cuttingfloor/plans';
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
      /** The span render minutes count over: the trial, the billing period, or the month. */
      period: { start: string; end: string };
      email: string;
      /** Set while a failed payment is in its grace days: when access stops. */
      grace_ends?: string;
    }
  | {
      allowed: false;
      reason: 'trial_ended' | 'payment_failed' | 'email_unverified';
      /** When the trial or the grace days ended. */
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
    if (access.reason === 'payment_failed')
      throw new CfError(
        'subscription_required',
        `The last payment failed and the ${GRACE_DAYS} days to fix it ended on ${day(access.ended)}`,
        {
          hint: `Update the card at ${account} (sign in with the same account), then call the tool again. Media and exports are kept 7 days, timelines 24 hours after last use`,
          detail: { reason: access.reason, ended: access.ended, account },
        },
      );
    throw new CfError('subscription_required', `The free trial ended on ${day(access.ended)}`, {
      hint: `Pick a plan at ${account} (sign in with the same account), then call the tool again. Media and exports are kept 7 days, timelines 24 hours after last use`,
      detail: { reason: access.reason, trial_ended: access.ended, subscribe: account },
    });
  }

  /** The owner's plan as limits on the work they start, with a refusal once the minutes are used. */
  async limits(owner: string): Promise<OwnerLimits> {
    const access = await this.require(owner);
    const limits = PLANS[access.plan].limits;
    const out: OwnerLimits = {
      ...(limits.jobs !== null ? { jobs: limits.jobs } : {}),
      ...(limits.shortSide !== null ? { shortSide: limits.shortSide } : {}),
      ...(limits.judgmentsPerDay !== null ? { judgmentsPerDay: limits.judgmentsPerDay } : {}),
    };
    const usage = await this.usage(owner, access);
    if (usage.included_minutes !== null && usage.used_minutes >= usage.included_minutes) {
      const account = this.#o.accountUrl;
      const upgrade = access.plan === 'trial' || access.plan === 'creator';
      out.refuseJobs = new CfError(
        'quota_exceeded',
        `This ${access.plan === 'trial' ? 'trial' : 'period'}'s ${usage.included_minutes} render minutes are used`,
        {
          hint: `${upgrade ? `Move to a bigger plan at ${account} for more minutes now, or wait` : `Wait`} until ${day(usage.period.end)}, when they renew. Editing the timeline and previews still work; only new jobs (exports, imports, analysis, create.*) wait`,
          detail: {
            used_minutes: usage.used_minutes,
            included_minutes: usage.included_minutes,
            renews: usage.period.end,
            account,
          },
        },
      );
    }
    return out;
  }

  /** Render minutes used this period against the plan's. */
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
    if (user.email_verified === false) return { allowed: false, reason: 'email_unverified', email };

    const customer = metadata.stripe_customer_id;
    let lapsed: string | undefined;
    if (customer) {
      const subs = await this.#stripe(
        `/v1/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=20`,
      );
      for (const sub of (subs.data ?? []) as StripeSubscription[]) {
        if (!PAYING.has(sub.status)) continue;
        const item = sub.items?.data?.[0];
        const plan = fromLookupKey(item?.price?.lookup_key)?.plan ?? 'pro';
        const start = (item?.current_period_start ?? sub.current_period_start ?? now / 1000) * 1000;
        const end = (item?.current_period_end ?? sub.current_period_end ?? now / 1000) * 1000;
        const period = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
        if (sub.status !== 'past_due') return { allowed: true, plan, period, email };
        // A failed renewal keeps working while Stripe retries the card, for GRACE_DAYS.
        const grace = start + GRACE_DAYS * 86_400_000;
        if (now < grace)
          return { allowed: true, plan, period, email, grace_ends: new Date(grace).toISOString() };
        lapsed = new Date(grace).toISOString();
      }
    }
    if (lapsed) return { allowed: false, reason: 'payment_failed', ended: lapsed, email };

    const began = Date.parse(String(user.created_at));
    const ends = new Date(began + TRIAL_DAYS * 86_400_000).toISOString();
    if (now < Date.parse(ends))
      return {
        allowed: true,
        plan: 'trial',
        period: { start: new Date(began).toISOString(), end: ends },
        email,
      };
    return { allowed: false, reason: 'trial_ended', ended: ends, email };
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
      price?: { lookup_key?: string | null };
    }[];
  };
}
