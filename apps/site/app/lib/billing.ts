import 'server-only';
import {
  fromLookupKey,
  GRACE_DAYS,
  type Interval,
  lookupKey,
  PLANS,
  type PlanId,
  TRIAL_DAYS,
  taggedPlan,
} from '@cuttingfloor/plans';

// The account's plan, without a database: WorkOS holds the user (when they joined, a `plan` tag
// for given plans, and `stripe_customer_id`), Stripe holds the subscription. The MCP server
// decides access the same way from the same plans file (apps/hosted/src/access.ts), and counts
// the render minutes, which the account page reads from it.

const PAYING = new Set(['active', 'trialing', 'past_due']);

export type Status =
  | { kind: 'given'; plan: PlanId }
  | {
      kind: 'subscribed';
      plan: PlanId;
      interval: Interval;
      status: string;
      renews: string | null;
      cancels: boolean;
      /** A failed payment's last day of access. */
      graceEnds: string | null;
    }
  | { kind: 'trial'; ends: string }
  | { kind: 'expired'; ended: string }
  | { kind: 'lapsed'; ended: string };

export type Usage = {
  used_minutes: number;
  included_minutes: number | null;
  period: { start: string; end: string };
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function workos(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`https://api.workos.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${env('WORKOS_API_KEY')}`,
      'content-type': 'application/json',
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    cache: 'no-store',
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`WorkOS ${path}: ${res.status}`);
  return json;
}

export async function stripe(path: string, body?: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: new URLSearchParams(body) } : {}),
    cache: 'no-store',
  });
  const json = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe ${path}: ${json.error?.message ?? res.status}`);
  return json;
}

type Sub = {
  status: string;
  cancel_at_period_end: boolean;
  current_period_start?: number;
  items: {
    data: {
      current_period_start?: number;
      current_period_end?: number;
      price: { lookup_key: string | null };
    }[];
  };
};

export type Account = { status: Status; metadata: Record<string, string> };

export async function accountOf(userId: string): Promise<Account> {
  const user = await workos(`/user_management/users/${encodeURIComponent(userId)}`);
  const metadata = (user.metadata ?? {}) as Record<string, string>;
  return { status: await statusFrom(user, metadata), metadata };
}

export async function statusOf(userId: string): Promise<Status> {
  return (await accountOf(userId)).status;
}

async function statusFrom(
  user: Record<string, unknown>,
  metadata: Record<string, string>,
): Promise<Status> {
  const tagged = taggedPlan(metadata.plan);
  if (tagged) return { kind: 'given', plan: tagged };

  let lapsed: string | undefined;
  if (metadata.stripe_customer_id) {
    const subs = await stripe(
      `/v1/subscriptions?customer=${encodeURIComponent(metadata.stripe_customer_id)}&status=all&limit=20`,
    );
    const sub = (subs.data as Sub[]).find((s) => PAYING.has(s.status));
    if (sub) {
      const item = sub.items.data[0];
      const named = fromLookupKey(item?.price.lookup_key) ?? { plan: 'pro', interval: 'month' };
      const start = (item?.current_period_start ?? sub.current_period_start ?? 0) * 1000;
      const grace = start + GRACE_DAYS * 86_400_000;
      if (sub.status === 'past_due' && Date.now() >= grace) lapsed = new Date(grace).toISOString();
      else
        return {
          kind: 'subscribed',
          plan: named.plan,
          interval: named.interval,
          status: sub.status,
          renews: item?.current_period_end
            ? new Date(item.current_period_end * 1000).toISOString()
            : null,
          cancels: sub.cancel_at_period_end,
          graceEnds: sub.status === 'past_due' ? new Date(grace).toISOString() : null,
        };
    }
  }
  if (lapsed) return { kind: 'lapsed', ended: lapsed };

  const ends = new Date(Date.parse(String(user.created_at)) + TRIAL_DAYS * 86_400_000);
  return Date.now() < ends.getTime()
    ? { kind: 'trial', ends: ends.toISOString() }
    : { kind: 'expired', ended: ends.toISOString() };
}

/**
 * Render minutes used this period, from the MCP server that counts them. Undefined when it can't
 * say (not configured, or unreachable): the page then leaves the meter out rather than guess.
 */
export async function usageOf(userId: string): Promise<Usage | undefined> {
  const key = process.env.CUTTINGFLOOR_ACCOUNT_KEY;
  const server = process.env.CUTTINGFLOOR_SERVER_URL ?? 'https://api.cuttingfloor.ai';
  if (!key) return undefined;
  try {
    const res = await fetch(`${server}/account/usage?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Usage & { allowed: boolean };
    return body.allowed ? body : undefined;
  } catch {
    return undefined;
  }
}

/** The user's Stripe customer, made on first checkout and remembered on the WorkOS user. */
export async function customerFor(userId: string): Promise<string> {
  const user = await workos(`/user_management/users/${encodeURIComponent(userId)}`);
  const metadata = (user.metadata ?? {}) as Record<string, string>;
  if (metadata.stripe_customer_id) return metadata.stripe_customer_id;
  const customer = await stripe('/v1/customers', {
    email: String(user.email ?? ''),
    name: [user.first_name, user.last_name].filter(Boolean).join(' '),
    'metadata[app]': 'cuttingfloor',
    'metadata[workos_user_id]': userId,
  });
  const id = customer.id as string;
  await setMetadata(userId, { stripe_customer_id: id });
  return id;
}

/** Merges fields into the user's WorkOS metadata. */
export async function setMetadata(userId: string, patch: Record<string, string>): Promise<void> {
  const path = `/user_management/users/${encodeURIComponent(userId)}`;
  const user = await workos(path);
  const metadata = (user.metadata ?? {}) as Record<string, string>;
  await workos(path, { method: 'PUT', body: { metadata: { ...metadata, ...patch } } });
}

/** The Stripe price for a plan sold on the account page. */
export async function priceFor(key: string): Promise<string> {
  const named = fromLookupKey(key);
  if (!named || PLANS[named.plan].sold !== 'self') throw new Error('unknown plan');
  const lookup = lookupKey(named.plan, named.interval);
  const prices = await stripe(`/v1/prices?active=true&lookup_keys[]=${lookup}`);
  const price = (prices.data as { id: string }[])[0];
  if (!price) throw new Error(`no price ${lookup}`);
  return price.id;
}
