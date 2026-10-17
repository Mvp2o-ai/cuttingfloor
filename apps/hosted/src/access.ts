import { CfError } from '@cuttingfloor/schema';

// Who may work on the hosted server, decided without a database: WorkOS holds the account
// (when it began, and a `plan` tag for comped accounts), Stripe holds the subscription. The two
// are linked by the user's `stripe_customer_id` metadata, which the site writes at checkout.

export type Plan = 'admin' | 'lifetime' | 'creator' | 'pro' | 'enterprise' | 'trial';

export type Access =
  | { allowed: true; plan: Plan; trial_ends?: string }
  | { allowed: false; trial_ended: string };

export interface AccessOptions {
  workosKey: string;
  stripeKey: string;
  /** Where people subscribe; named in the refusal. */
  accountUrl: string;
  trialDays?: number;
  now?: () => number;
}

const COMPED = new Set(['admin', 'lifetime']);
// Statuses that keep access: a failing card gets Stripe's retries before it lapses.
const PAYING = new Set(['active', 'trialing', 'past_due']);
const ALLOWED_TTL = 5 * 60_000;
const DENIED_TTL = 20_000;

export class AccessCheck {
  #o: Required<Omit<AccessOptions, 'now'>> & { now: () => number };
  #cache = new Map<string, { at: number; value: Promise<Access> }>();

  constructor(options: AccessOptions) {
    this.#o = { trialDays: 3, now: Date.now, ...options };
  }

  /** Refuses an owner whose trial ended without a plan, with where to subscribe. */
  async require(owner: string): Promise<void> {
    const access = await this.get(owner);
    if (access.allowed) return;
    throw new CfError('subscription_required', `The free trial ended on ${access.trial_ended}`, {
      detail: { trial_ended: access.trial_ended, subscribe: this.#o.accountUrl },
      hint: `Subscribe at ${this.#o.accountUrl} (sign in with the same account), then call the tool again. Work you made is kept for 7 days.`,
    });
  }

  /** The owner's access, cached briefly; a refusal is rechecked soon so a new subscription shows. */
  async get(owner: string): Promise<Access> {
    const hit = this.#cache.get(owner);
    if (hit) {
      const value = await hit.value;
      if (this.#o.now() - hit.at < (value.allowed ? ALLOWED_TTL : DENIED_TTL)) return value;
    }
    return this.#load(owner);
  }

  #load(owner: string): Promise<Access> {
    const value = this.resolve(owner).catch((error: Error) => {
      // An outage at WorkOS or Stripe must not lock paying people out.
      process.stderr.write(`access: ${owner}: ${error.message}; allowing\n`);
      return { allowed: true, plan: 'trial' } as Access;
    });
    this.#cache.set(owner, { at: this.#o.now(), value });
    return value;
  }

  /** Works out access from WorkOS and Stripe, uncached. */
  async resolve(owner: string): Promise<Access> {
    const user = await this.#workos(`/user_management/users/${encodeURIComponent(owner)}`);
    const metadata = (user.metadata ?? {}) as Record<string, string>;
    if (COMPED.has(metadata.plan ?? '')) return { allowed: true, plan: metadata.plan as Plan };

    const customer = metadata.stripe_customer_id;
    if (customer) {
      const subs = await this.#stripe(
        `/v1/subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=20`,
      );
      for (const sub of (subs.data ?? []) as StripeSubscription[]) {
        if (!PAYING.has(sub.status)) continue;
        const key = sub.items?.data?.[0]?.price?.lookup_key ?? '';
        const plan = (/^cf_(creator|pro|enterprise)_/.exec(key)?.[1] ?? 'pro') as Plan;
        return { allowed: true, plan };
      }
    }

    const ends = Date.parse(String(user.created_at)) + this.#o.trialDays * 86_400_000;
    const trial_ends = new Date(ends).toISOString();
    if (this.#o.now() < ends) return { allowed: true, plan: 'trial', trial_ends };
    return { allowed: false, trial_ended: trial_ends };
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

interface StripeSubscription {
  status: string;
  items?: { data?: { price?: { lookup_key?: string | null } }[] };
}
