// End-to-end check of credits on the live server with real WorkOS and Stripe. Run it on the
// server, inside the image, so it uses production's keys (they never leave there):
//
//   ssh root@<server> 'cd /opt/cuttingfloor && docker compose exec -T cuttingfloor node scripts/smoke-paid.ts'
//
// Makes a throwaway account linked to a Stripe customer as checkout links it, and a script key for
// it on the server. Checks through /mcp and /account/usage that a new account has its
// free credits and the packs, that turning on automatic top-up shows at once, that a pack's
// Checkout opens as the site opens it (expired before anyone could pay), and the access rules
// with a clock moved on. Moves no money: a real purchase is checked by hand (plans/README.md).
// Deletes everything after.

import { AccessCheck } from '../apps/hosted/src/access.ts';
import { FREE_CREDITS, PACKS } from '../packages/plans/src/index.ts';
import type { AccountGetResult } from '../packages/schema/src/index.ts';

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const workosKey = need('WORKOS_API_KEY');
const stripeKey = need('STRIPE_SECRET_KEY');
const accountKey = need('CUTTINGFLOOR_ACCOUNT_KEY');
const server = (process.env.CUTTINGFLOOR_PUBLIC_URL ?? 'https://api.cuttingfloor.ai').replace(
  /\/$/,
  '',
);
const accountUrl = process.env.CUTTINGFLOOR_ACCOUNT_URL ?? 'https://cuttingfloor.ai/account';

const step = (label: string) => process.stdout.write(`• ${label}\n`);
const failures: string[] = [];
function expect(ok: boolean, label: string) {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures.push(label);
}
const DAY = 86_400_000;

async function workos(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`https://api.workos.com${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${workosKey}`, 'content-type': 'application/json' },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WorkOS ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
}

async function stripe(path: string, body?: Record<string, string>, method?: string) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      authorization: `Bearer ${stripeKey}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: new URLSearchParams(body) } : {}),
  });
  const json = (await res.json()) as Record<string, unknown> & { error?: { message: string } };
  if (!res.ok) throw new Error(`Stripe ${path}: ${json.error?.message ?? res.status}`);
  return json;
}

async function site(path: string, body?: unknown) {
  const res = await fetch(`${server}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${accountKey}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await res.json()) as Record<string, unknown>;
}

const email = `smoke-paid-${Date.now()}@cuttingfloor-smoke.dev`;
const user = await workos('/user_management/users', {
  method: 'POST',
  body: { email, email_verified: true, first_name: 'Smoke' },
});
const userId = user.id as string;
step(`a throwaway account (${userId})`);
let customer = '';
let keyId = '';

try {
  // As the site's checkout does (apps/site/app/lib/billing.ts customerFor).
  customer = (
    await stripe('/v1/customers', {
      email,
      name: 'Smoke',
      'metadata[app]': 'cuttingfloor',
      'metadata[workos_user_id]': userId,
      'metadata[smoke]': 'true',
    })
  ).id as string;
  await workos(`/user_management/users/${userId}`, {
    method: 'PUT',
    body: { metadata: { stripe_customer_id: customer } },
  });
  const made = await site('/account/keys', { user: userId, label: 'smoke-paid' });
  const key = String(made.key ?? '');
  keyId = String(made.key_id ?? '');
  expect(key.startsWith('cf_'), 'the server made a script key for the account');

  // Plain JSON-RPC, as any client sends it: the image carries no MCP client package.
  let session: string | undefined;
  const mcp = async (method: string, params: unknown, id?: number) => {
    const res = await fetch(`${server}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id ? { id } : {}) }),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    const text = await res.text();
    if (!id) return undefined;
    const body = text.trimStart().startsWith('{')
      ? text
      : (text
          .split('\n')
          .findLast((l) => l.startsWith('data:'))
          ?.slice(5) ?? '{}');
    return JSON.parse(body) as { result?: Record<string, unknown>; error?: unknown };
  };
  await mcp(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke-paid', version: '0' },
    },
    1,
  );
  await mcp('notifications/initialized', {});
  let calls = 1;
  const works = async () => {
    const res = await mcp('tools/call', { name: 'media.list', arguments: {} }, ++calls);
    if (res?.error) return `error: ${JSON.stringify(res.error)}`;
    return res?.result?.isError
      ? `refused: ${JSON.stringify(res.result.structuredContent ?? res.result.content)}`
      : 'works';
  };
  const account = async (fresh = false) =>
    (await site(`/account/usage?user=${userId}${fresh ? '&fresh=1' : ''}`)).account as
      | AccountGetResult
      | undefined;
  const at = (days: number) =>
    new AccessCheck({ workosKey, stripeKey, accountUrl, now: () => Date.now() + days * DAY });

  step('a new account');
  expect((await works()) === 'works', 'a tool call works');
  const page = await account();
  expect(
    page?.credits?.left === FREE_CREDITS && page.plan === 'free',
    'the account page reads the same credits',
  );
  expect(
    page?.packs?.length === PACKS.length && page.top_up?.card_saved === false,
    `it lists the ${PACKS.length} packs, no card saved yet`,
  );
  expect(
    page?.warnings?.some((w) => w.kind === 'low' && !w.emailed),
    'the low-credit email is armed, not sent',
  );
  const later = await at(90).resolve(userId);
  expect(
    later.allowed && later.plan === 'free',
    'ninety days on it still works: credits never expire',
  );
  const limits = await at(0).limits(userId);
  expect(
    limits.jobs === 1 && limits.shortSide === 1080 && !limits.refuseJobs,
    `free limits: one job, 1080p, nothing refused (${JSON.stringify({ ...limits, refuseJobs: !!limits.refuseJobs })})`,
  );

  step('automatic top-up');
  const pack = PACKS[1];
  if (!pack) throw new Error('no second pack');
  const user = await workos(`/user_management/users/${userId}`);
  await workos(`/user_management/users/${userId}`, {
    method: 'PUT',
    body: { metadata: { ...(user.metadata as object), refill_pack: pack.id } },
  });
  const on = await account(true);
  expect(
    on?.top_up?.automatic === true && on.top_up.pack?.credits === pack.credits,
    `turned on, the server shows it at once (${JSON.stringify(on?.top_up)})`,
  );

  step("a pack's Checkout, as the site opens it");
  for (const p of PACKS) {
    const prices = await stripe(`/v1/prices?active=true&lookup_keys[]=${p.id}`);
    const price = (prices.data as { id: string; unit_amount: number }[])[0];
    expect(
      price?.unit_amount === p.price * 100,
      `${p.id} is on sale at $${p.price} (${price ? price.unit_amount / 100 : 'missing'})`,
    );
  }
  const first = PACKS[0];
  const prices = await stripe(`/v1/prices?active=true&lookup_keys[]=${first?.id}`);
  const checkout = await stripe('/v1/checkout/sessions', {
    mode: 'payment',
    customer,
    client_reference_id: userId,
    'line_items[0][price]': (prices.data as { id: string }[])[0]?.id ?? '',
    'line_items[0][quantity]': '1',
    'payment_intent_data[metadata][app]': 'cuttingfloor',
    'payment_intent_data[metadata][credits]': String(first?.credits),
    'payment_intent_data[metadata][pack]': String(first?.id),
    'payment_intent_data[metadata][workos_user_id]': userId,
    'payment_intent_data[metadata][smoke]': 'true',
    'payment_intent_data[setup_future_usage]': 'off_session',
    allow_promotion_codes: 'true',
    success_url: `${accountUrl}?bought=${first?.credits}#credits`,
    cancel_url: `${accountUrl}#credits`,
  });
  expect(
    String(checkout.url).startsWith('https://checkout.stripe.com/') &&
      checkout.amount_total === (first?.price ?? 0) * 100,
    `Checkout opens for $${first?.price} (${checkout.amount_total})`,
  );
  await stripe(`/v1/checkout/sessions/${checkout.id}/expire`, {});
  const still = await account(true);
  expect(still?.credits?.bought === 0, 'an unpaid checkout adds no credits');

  step('an unverified email');
  const pending = await workos('/user_management/users', {
    method: 'POST',
    body: { email: `unverified-${email}`, email_verified: false },
  });
  const unverified = await at(0)
    .resolve(pending.id as string)
    .finally(() => workos(`/user_management/users/${pending.id}`, { method: 'DELETE' }));
  expect(!unverified.allowed, 'is refused until it is verified');
} finally {
  if (keyId) await site('/account/keys/revoke', { user: userId, key_id: keyId }).catch(() => {});
  if (customer) await stripe(`/v1/customers/${customer}`, undefined, 'DELETE').catch(() => {});
  await workos(`/user_management/users/${userId}`, { method: 'DELETE' });
  step('deleted the throwaway account, its key and its Stripe customer');
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
