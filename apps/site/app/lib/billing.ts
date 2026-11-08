import 'server-only';
import { type Pack, packOf } from '@cuttingfloor/plans';
import type { AccountGetResult } from '@cuttingfloor/schema';

// The account's credits, without a database: WorkOS holds the user (a `plan` tag for given plans,
// `stripe_customer_id`, and `refill_pack` for automatic top-up), Stripe holds the packs bought.
// The MCP server works out the balance from both and the meter (apps/hosted/src/access.ts); this
// page reads it from there, as account.get gives it, so the two never disagree.

export type Account = AccountGetResult;

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

export async function stripe(
  path: string,
  body?: Record<string, string>,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${env('STRIPE_SECRET_KEY')}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...headers,
    },
    ...(body ? { body: new URLSearchParams(body) } : {}),
    cache: 'no-store',
  });
  const json = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe ${path}: ${json.error?.message ?? res.status}`);
  return json;
}

/**
 * The account's plan and credits, from the MCP server that counts them. Undefined when it can't
 * say (not configured, unreachable, or the email isn't verified yet): the page then leaves the
 * credits out rather than guess. `fresh` rereads it after a change made here.
 */
export async function accountOf(userId: string, fresh = false): Promise<Account | undefined> {
  const key = process.env.CUTTINGFLOOR_ACCOUNT_KEY;
  const server = process.env.CUTTINGFLOOR_SERVER_URL ?? 'https://api.cuttingfloor.ai';
  if (!key) return undefined;
  try {
    const res = await fetch(
      `${server}/account/usage?user=${encodeURIComponent(userId)}${fresh ? '&fresh=1' : ''}`,
      {
        headers: { authorization: `Bearer ${key}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { allowed: boolean; account?: Account };
    return body.allowed ? body.account : undefined;
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

/** Merges fields into the user's WorkOS metadata; an empty value removes the field. */
export async function setMetadata(userId: string, patch: Record<string, string>): Promise<void> {
  const path = `/user_management/users/${encodeURIComponent(userId)}`;
  const user = await workos(path);
  const metadata = { ...((user.metadata ?? {}) as Record<string, string>), ...patch };
  for (const [k, v] of Object.entries(metadata)) if (v === '') delete metadata[k];
  await workos(path, { method: 'PUT', body: { metadata } });
}

/** The pack a form names, or an error for one that isn't ours. */
export function packFor(id: string): Pack {
  const pack = packOf(id);
  if (!pack) throw new Error('unknown pack');
  return pack;
}

/** The Stripe price for a pack, by its lookup key. */
export async function priceFor(pack: Pack): Promise<string> {
  const prices = await stripe(`/v1/prices?active=true&lookup_keys[]=${pack.id}`);
  const price = (prices.data as { id: string }[])[0];
  if (!price) throw new Error(`no price ${pack.id}`);
  return price.id;
}

/** What a payment for a pack carries: the access check counts payments with these. */
export function packMetadata(pack: Pack, userId: string, prefix: string): Record<string, string> {
  return {
    [`${prefix}[app]`]: 'cuttingfloor',
    [`${prefix}[credits]`]: String(pack.credits),
    [`${prefix}[pack]`]: pack.id,
    [`${prefix}[workos_user_id]`]: userId,
  };
}

/** The customer's most recently saved card, if any. */
export async function savedCard(
  customer: string,
): Promise<{ id: string; brand: string; last4: string } | undefined> {
  const list = await stripe(
    `/v1/payment_methods?customer=${encodeURIComponent(customer)}&type=card&limit=1`,
  );
  const pm = (list.data as { id: string; card?: { brand?: string; last4?: string } }[])[0];
  return pm
    ? { id: pm.id, brand: pm.card?.brand ?? 'card', last4: pm.card?.last4 ?? '' }
    : undefined;
}

/**
 * One click: charges a pack to the saved card with the person here. True when it went through;
 * false when the card needs them (a bank check, a decline), and Checkout takes over.
 */
export async function buyOnSavedCard(userId: string, customer: string, pack: Pack, nonce: string) {
  const card = await savedCard(customer);
  if (!card) return false;
  try {
    const pi = await stripe(
      '/v1/payment_intents',
      {
        amount: String(Math.round(pack.price * 100)),
        currency: 'usd',
        customer,
        payment_method: card.id,
        confirm: 'true',
        off_session: 'true',
        description: `cuttingfloor: ${pack.credits} credits`,
        ...packMetadata(pack, userId, 'metadata'),
        'metadata[reason]': 'one click',
      },
      { 'idempotency-key': `${userId}:buy:${nonce}` },
    );
    return pi.status === 'succeeded';
  } catch {
    return false;
  }
}
