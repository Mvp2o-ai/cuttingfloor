import 'server-only';

// The account's plan, without a database: WorkOS holds the user (when they joined, a `plan` tag
// for comped accounts, and `stripe_customer_id`), Stripe holds the subscription. The MCP server
// decides access the same way (apps/hosted/src/access.ts).

export const TRIAL_DAYS = 3;
const COMPED = new Set(['admin', 'lifetime']);
const PAYING = new Set(['active', 'trialing', 'past_due']);

export type Status =
  | { kind: 'comped'; plan: 'admin' | 'lifetime' }
  | {
      kind: 'subscribed';
      plan: string;
      interval: string;
      status: string;
      renews: string | null;
      cancels: boolean;
    }
  | { kind: 'trial'; ends: string }
  | { kind: 'expired'; ended: string };

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
  items: { data: { current_period_end?: number; price: { lookup_key: string | null } }[] };
};

export async function statusOf(userId: string): Promise<Status> {
  const user = await workos(`/user_management/users/${encodeURIComponent(userId)}`);
  const metadata = (user.metadata ?? {}) as Record<string, string>;
  if (COMPED.has(metadata.plan ?? ''))
    return { kind: 'comped', plan: metadata.plan as 'admin' | 'lifetime' };

  if (metadata.stripe_customer_id) {
    const subs = await stripe(
      `/v1/subscriptions?customer=${encodeURIComponent(metadata.stripe_customer_id)}&status=all&limit=20`,
    );
    const sub = (subs.data as Sub[]).find((s) => PAYING.has(s.status));
    if (sub) {
      const item = sub.items.data[0];
      const [, plan = 'pro', interval = 'month'] =
        /^cf_([a-z]+)_([a-z]+)$/.exec(item?.price.lookup_key ?? '') ?? [];
      return {
        kind: 'subscribed',
        plan,
        interval,
        status: sub.status,
        renews: item?.current_period_end
          ? new Date(item.current_period_end * 1000).toISOString()
          : null,
        cancels: sub.cancel_at_period_end,
      };
    }
  }

  const ends = new Date(Date.parse(String(user.created_at)) + TRIAL_DAYS * 86_400_000);
  return Date.now() < ends.getTime()
    ? { kind: 'trial', ends: ends.toISOString() }
    : { kind: 'expired', ended: ends.toISOString() };
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
  await workos(`/user_management/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: { metadata: { ...metadata, stripe_customer_id: id } },
  });
  return id;
}

/** A price by lookup key (cf_creator_month, cf_pro_year, …). */
export async function priceFor(lookupKey: string): Promise<string> {
  if (!/^cf_(creator|pro)_(month|year)$/.test(lookupKey)) throw new Error('unknown plan');
  const prices = await stripe(`/v1/prices?active=true&lookup_keys[]=${lookupKey}`);
  const price = (prices.data as { id: string }[])[0];
  if (!price) throw new Error(`no price ${lookupKey}`);
  return price.id;
}
