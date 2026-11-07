// End-to-end check that paying accounts are let in, on the live server with real WorkOS and Stripe.
// Run it on the server, inside the image, so it uses production's keys (they never leave there):
//
//   ssh root@<server> 'cd /opt/cuttingfloor && docker compose exec -T cuttingfloor node scripts/smoke-paid.ts'
//
// Makes a throwaway account linked to a Stripe customer as checkout links it, and a script key
// for it on the server. Real subscriptions are paid with a 100%-off coupon, so the invoices are
// real, paid and $0: no card, no charge. Checks through /mcp and /account/usage that the free plan
// works, that Creator (monthly) and Pro (yearly) are honoured with their own limits, that a
// yearly plan's minutes count per month, that Stripe's webhook reaches the server, and that
// cancelling returns it to the free plan. Later days run the server's own access rules with a
// clock moved on. Deletes everything after.
import { AccessCheck } from '../apps/hosted/src/access.ts';

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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
let coupon = '';
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
  coupon = (
    await stripe('/v1/coupons', {
      percent_off: '100',
      duration: 'forever',
      name: 'smoke-paid',
      'metadata[app]': 'cuttingfloor',
      'metadata[smoke]': 'true',
    })
  ).id as string;
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
  const usage = async () => site(`/account/usage?user=${userId}`);
  const at = (days: number) =>
    new AccessCheck({ workosKey, stripeKey, accountUrl, now: () => Date.now() + days * DAY });
  const prices = await stripe(
    '/v1/prices?active=true&lookup_keys[]=cf_creator_month&lookup_keys[]=cf_pro_year',
  );
  const price = (lookup: string) =>
    (prices.data as { id: string; lookup_key: string }[]).find((p) => p.lookup_key === lookup)
      ?.id ?? '';
  const subscribe = async (lookup: string) => {
    const sub = await stripe('/v1/subscriptions', {
      customer,
      'items[0][price]': price(lookup),
      'discounts[0][coupon]': coupon,
      'metadata[app]': 'cuttingfloor',
      'metadata[smoke]': 'true',
    });
    // Stripe's webhook tells the server; give it a moment to arrive.
    await wait(8000);
    return sub;
  };

  step('on the free plan');
  expect((await works()) === 'works', 'a tool call works');
  const free = await usage();
  expect(free.plan === 'free', `the server counts it as the free plan (${free.plan})`);
  const unpaid = await at(4).resolve(userId);
  expect(unpaid.allowed && unpaid.plan === 'free', 'four days on, unpaid, it still works (free)');

  step('subscribed to Creator, monthly (a real, paid $0 invoice)');
  const creator = await subscribe('cf_creator_month');
  const invoice = await stripe(`/v1/invoices/${creator.latest_invoice}`);
  expect(
    creator.status === 'active' && invoice.status === 'paid',
    `Stripe has it active, its invoice paid (${creator.status}, ${invoice.status})`,
  );
  const events = await stripe(`/v1/events?type=customer.subscription.created&limit=20`);
  const ours = (events.data as { data: { object: { id: string } }; pending_webhooks: number }[])
    .filter((e) => e.data.object.id === creator.id)
    .at(0);
  expect(
    ours?.pending_webhooks === 0,
    `the webhook reached the server (${ours ? `${ours.pending_webhooks} pending` : 'no event'})`,
  );
  expect((await works()) === 'works', 'a tool call works');
  const monthly = await usage();
  expect(
    monthly.plan === 'creator' && monthly.included_minutes === 300,
    `the server counts Creator, 300 minutes (${monthly.plan}, ${monthly.included_minutes})`,
  );
  const paid = await at(4).resolve(userId);
  expect(paid.allowed && paid.plan === 'creator', 'four days on, it is Creator');
  const limits = await at(4).limits(userId);
  expect(
    limits.jobs === 1 && limits.shortSide === 1080 && !limits.refuseJobs,
    `with Creator's limits, nothing refused (${JSON.stringify({ ...limits, refuseJobs: !!limits.refuseJobs })})`,
  );
  // WorkOS won't unverify an email, so a second, unverified account on the same subscription.
  const pending = await workos('/user_management/users', {
    method: 'POST',
    body: {
      email: `unverified-${email}`,
      email_verified: false,
      metadata: { stripe_customer_id: customer },
    },
  });
  const unverified = await at(0)
    .resolve(pending.id as string)
    .finally(() => workos(`/user_management/users/${pending.id}`, { method: 'DELETE' }));
  expect(
    unverified.allowed,
    `a paying account whose email shows unverified still works (${unverified.allowed ? 'works' : unverified.reason})`,
  );
  await stripe(`/v1/subscriptions/${creator.id}`, undefined, 'DELETE');

  step('moved to Pro, yearly');
  const pro = await subscribe('cf_pro_year');
  expect(pro.status === 'active', `Stripe has it active (${pro.status})`);
  expect((await works()) === 'works', 'a tool call works');
  const yearly = await usage();
  const span = (p: unknown) => {
    const { start, end } = p as { start: string; end: string };
    return (Date.parse(end) - Date.parse(start)) / DAY;
  };
  expect(
    yearly.plan === 'pro' && yearly.included_minutes === 900,
    `the server counts Pro, 900 minutes (${yearly.plan}, ${yearly.included_minutes})`,
  );
  expect(
    span(yearly.period) >= 28 && span(yearly.period) <= 31,
    `the minutes renew monthly, not once a year (${span(yearly.period)} days)`,
  );
  const later = await at(45).resolve(userId);
  expect(
    later.allowed &&
      Date.parse(later.period.start) > Date.now() + 27 * DAY &&
      span(later.period) <= 31,
    `45 days on, it is the second month's minutes (${later.allowed ? later.period.start : 'refused'})`,
  );
  const proLimits = await at(4).limits(userId);
  expect(
    proLimits.jobs === 2 && proLimits.shortSide === 2160 && !proLimits.refuseJobs,
    `with Pro's limits (${JSON.stringify({ ...proLimits, refuseJobs: !!proLimits.refuseJobs })})`,
  );

  step('cancelled');
  await stripe(`/v1/subscriptions/${pro.id}`, undefined, 'DELETE');
  const ended = await at(4).resolve(userId);
  expect(ended.allowed && ended.plan === 'free', 'cancelled, it is back on the free plan');
  await wait(8000);
  expect((await usage()).plan === 'free', 'the server is back to the free plan at once (webhook)');
} finally {
  if (keyId) await site('/account/keys/revoke', { user: userId, key_id: keyId }).catch(() => {});
  if (customer) await stripe(`/v1/customers/${customer}`, undefined, 'DELETE').catch(() => {});
  if (coupon) await stripe(`/v1/coupons/${coupon}`, undefined, 'DELETE').catch(() => {});
  await workos(`/user_management/users/${userId}`, { method: 'DELETE' });
  step('deleted the throwaway account, its key, its Stripe customer and the coupon');
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
