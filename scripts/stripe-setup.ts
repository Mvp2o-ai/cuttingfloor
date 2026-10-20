// Creates (or finds) cuttingfloor's Stripe catalogue: the Creator and Pro plans, monthly and
// yearly, and a billing portal configuration of its own. Safe to run again: prices are found by
// lookup key, and everything carries metadata app=cuttingfloor so it never touches other products
// on the same account.
//
//   node scripts/stripe-setup.ts            (STRIPE_SECRET_KEY, else deploy/hetzner/cuttingfloor.env)
//
// Prints the ids the site needs.
import { readFile, writeFile } from 'node:fs/promises';

const key =
  process.env.STRIPE_SECRET_KEY ??
  (await readFile(new URL('../deploy/hetzner/cuttingfloor.env', import.meta.url), 'utf8').then(
    (env) => /^STRIPE_SECRET_KEY=(\S+)/m.exec(env)?.[1],
    () => undefined,
  ));
if (!key) throw new Error('Set STRIPE_SECRET_KEY');

const SITE = process.env.CUTTINGFLOOR_SITE_URL ?? 'https://cuttingfloor.ai';
const SERVER = process.env.CUTTINGFLOOR_SERVER_URL ?? 'https://api.cuttingfloor.ai';
// Software as a service, business use: eligible for Managed Payments.
const TAX_CODE = 'txcd_10103001';

const PLANS = [
  {
    id: 'creator',
    name: 'cuttingfloor Creator',
    description: '300 render minutes a month. Editing, solved.',
    month: 4900,
    year: 49000,
  },
  {
    id: 'pro',
    name: 'cuttingfloor Pro',
    description: '900 render minutes a month, two jobs at once, 4K. Editing, solved.',
    month: 9900,
    year: 99000,
  },
] as const;

async function stripe(path: string, body?: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: new URLSearchParams(body) } : {}),
  });
  const json = (await res.json()) as Record<string, unknown> & { error?: { message: string } };
  if (!res.ok) throw new Error(`Stripe ${path}: ${json.error?.message ?? res.status}`);
  return json;
}

const lookupKeys = PLANS.flatMap((p) => [`cf_${p.id}_month`, `cf_${p.id}_year`]);
const existing = await stripe(
  `/v1/prices?active=true&limit=20&${lookupKeys.map((k) => `lookup_keys[]=${k}`).join('&')}`,
);
const byKey = new Map(
  (existing.data as { id: string; lookup_key: string; product: string }[]).map((p) => [
    p.lookup_key,
    p,
  ]),
);

const prices: Record<string, string> = {};
const products: string[] = [];
for (const plan of PLANS) {
  let product =
    byKey.get(`cf_${plan.id}_month`)?.product ?? byKey.get(`cf_${plan.id}_year`)?.product;
  if (!product) {
    const created = await stripe('/v1/products', {
      name: plan.name,
      description: plan.description,
      tax_code: TAX_CODE,
      'metadata[app]': 'cuttingfloor',
      'metadata[plan]': plan.id,
    });
    product = created.id as string;
    process.stdout.write(`created product ${plan.name} ${product}\n`);
  }
  products.push(product);
  for (const interval of ['month', 'year'] as const) {
    const lookup = `cf_${plan.id}_${interval}`;
    let price = byKey.get(lookup)?.id;
    if (!price) {
      const created = await stripe('/v1/prices', {
        product,
        currency: 'usd',
        unit_amount: String(plan[interval]),
        'recurring[interval]': interval,
        lookup_key: lookup,
        tax_behavior: 'exclusive',
        'metadata[app]': 'cuttingfloor',
      });
      price = created.id as string;
      process.stdout.write(`created price ${lookup} ${price}\n`);
    }
    prices[lookup] = price;
  }
}

// A portal of our own: cancel, change card, switch between our plans. The account's default
// portal (used by other products) is left alone.
const portals = await stripe('/v1/billing_portal/configurations?limit=100');
let portal = (portals.data as { id: string; metadata?: Record<string, string> }[]).find(
  (c) => c.metadata?.app === 'cuttingfloor',
)?.id;
const portalBody: Record<string, string> = {
  'business_profile[headline]': 'cuttingfloor: editing, solved.',
  'business_profile[privacy_policy_url]': `${SITE}/privacy`,
  'business_profile[terms_of_service_url]': `${SITE}/terms`,
  default_return_url: `${SITE}/account`,
  'features[customer_update][enabled]': 'true',
  'features[customer_update][allowed_updates][]': 'email',
  'features[invoice_history][enabled]': 'true',
  'features[payment_method_update][enabled]': 'true',
  'features[subscription_cancel][enabled]': 'true',
  'features[subscription_cancel][mode]': 'at_period_end',
  'features[subscription_update][enabled]': 'true',
  'features[subscription_update][default_allowed_updates][]': 'price',
  'features[subscription_update][proration_behavior]': 'create_prorations',
  'metadata[app]': 'cuttingfloor',
};
products.forEach((product, i) => {
  const plan = PLANS[i];
  if (!plan) return;
  portalBody[`features[subscription_update][products][${i}][product]`] = product;
  portalBody[`features[subscription_update][products][${i}][prices][0]`] =
    prices[`cf_${plan.id}_month`] ?? '';
  portalBody[`features[subscription_update][products][${i}][prices][1]`] =
    prices[`cf_${plan.id}_year`] ?? '';
});
if (portal) await stripe(`/v1/billing_portal/configurations/${portal}`, portalBody);
else {
  portal = (await stripe('/v1/billing_portal/configurations', portalBody)).id as string;
  process.stdout.write(`created portal configuration ${portal}\n`);
}

// The webhook that tells the MCP server a subscription changed or a payment failed. Stripe gives
// its signing secret once, when it is made; it is written straight to the env file's
// STRIPE_WEBHOOK_SECRET (never printed), for up.sh to take to the server.
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];
const hooks = await stripe('/v1/webhook_endpoints?limit=100');
const hookUrl = `${SERVER}/stripe/webhook`;
const hook = (hooks.data as { id: string; url: string }[]).find((h) => h.url === hookUrl);
const hookBody: Record<string, string> = { 'metadata[app]': 'cuttingfloor' };
WEBHOOK_EVENTS.forEach((e, i) => {
  hookBody[`enabled_events[${i}]`] = e;
});
if (hook) await stripe(`/v1/webhook_endpoints/${hook.id}`, hookBody);
else {
  const made = await stripe('/v1/webhook_endpoints', { ...hookBody, url: hookUrl });
  const file = new URL('../deploy/hetzner/cuttingfloor.env', import.meta.url);
  const env = await readFile(file, 'utf8').catch(() => '');
  const line = `STRIPE_WEBHOOK_SECRET=${made.secret as string}`;
  await writeFile(
    file,
    /^STRIPE_WEBHOOK_SECRET=.*$/m.test(env)
      ? env.replace(/^STRIPE_WEBHOOK_SECRET=.*$/m, line)
      : `${env.replace(/\n*$/, '\n')}${line}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `created webhook ${made.id} for ${hookUrl}; its secret is in cuttingfloor.env\n`,
  );
}

process.stdout.write(`\n${JSON.stringify({ prices, portal, webhook: hookUrl }, null, 2)}\n`);
