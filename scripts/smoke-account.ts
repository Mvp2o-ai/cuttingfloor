// End-to-end check of accounts and billing against the real WorkOS and Stripe (live mode).
//
//   CHROME_PATH=<chrome> node scripts/smoke-account.ts https://cuttingfloor-site.vercel.app
//
// A preview (develop) sits behind Vercel's team login: set VERCEL_BYPASS to the project's
// automation bypass secret (Settings → Deployment Protection; VERCEL_BYPASS in the env file).
//
// Keys come from deploy/hetzner/cuttingfloor.env. Makes a throwaway WorkOS user, signs in on the
// site through AuthKit, checks the account page shows the trial, opens Stripe Checkout for Pro
// (stopping before payment), then checks the MCP server's access rules: trial, trial over,
// subscribed (a $0 trialing subscription with no card), and lifetime. Deletes everything after.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { AccessCheck } from '../apps/hosted/src/access.ts';

const site = (process.argv[2] ?? 'https://cuttingfloor-site.vercel.app').replace(/\/$/, '');
const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('Set CHROME_PATH to a Chrome or Chromium binary');
const env = await readFile(new URL('../deploy/hetzner/cuttingfloor.env', import.meta.url), 'utf8');
const read = (name: string) => new RegExp(`^${name}=(\\S+)`, 'm').exec(env)?.[1] ?? '';
const workosKey = read('WORKOS_API_KEY');
const stripeKey = read('STRIPE_SECRET_KEY');
const bypass = process.env.VERCEL_BYPASS ?? read('VERCEL_BYPASS');

const step = (label: string) => process.stdout.write(`• ${label}\n`);
const failures: string[] = [];
function expect(ok: boolean, label: string) {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures.push(label);
}

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

const email = `smoke-${Date.now()}@cuttingfloor-smoke.dev`;
const password = `Cf-${randomBytes(18).toString('base64url')}`;
const user = await workos('/user_management/users', {
  method: 'POST',
  body: { email, password, email_verified: true, first_name: 'Smoke' },
});
const userId = user.id as string;
step(`a throwaway user (${userId})`);
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });

try {
  step('signs in on the site and sees the trial');
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  if (bypass)
    await page.goto(`${site}/?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`);
  await page.goto(`${site}/account`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[type=email], input[name=email]', { timeout: 30_000 });
  await page.type('input[type=email], input[name=email]', email);
  await page.keyboard.press('Enter');
  await page.waitForSelector('input[type=password]', { visible: true, timeout: 30_000 });
  await page.type('input[type=password]', password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60_000 }),
    page.keyboard.press('Enter'),
  ]);
  for (let i = 0; i < 30 && !page.url().startsWith(`${site}/account`); i++)
    await new Promise((r) => setTimeout(r, 1000));
  const text = await page.evaluate(() => document.body.innerText);
  expect(page.url().startsWith(`${site}/account`), `back on the account page (${page.url()})`);
  expect(text.includes('On the trial.'), 'the page says the trial is on');
  expect(text.includes(email), 'the page names the user');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  step('Pro opens Stripe Checkout (stopping before payment)');
  const [pro] = await page.$$('xpath/.//button[contains(., "$99 / month")]');
  if (!pro) throw new Error('no Pro button');
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), pro.click()]);
  await page.waitForFunction(() => document.body.innerText.includes('Pro'), { timeout: 30_000 });
  const checkout = await page.evaluate(() => document.body.innerText);
  expect(page.url().startsWith('https://checkout.stripe.com/'), `on Stripe Checkout`);
  expect(/cuttingfloor Pro/.test(checkout), 'it sells cuttingfloor Pro');
  expect(/\$99(\.00)?/.test(checkout), 'at $99');
  const linked = (await workos(`/user_management/users/${userId}`)).metadata as Record<
    string,
    string
  >;
  const customer = linked?.stripe_customer_id ?? '';
  expect(customer.startsWith('cus_'), `the user is linked to a Stripe customer (${customer})`);

  step("the server's access rules, on the real accounts");
  const at = (offsetDays: number) =>
    new AccessCheck({
      workosKey,
      stripeKey,
      accountUrl: `${site}/account`,
      now: () => Date.now() + offsetDays * 86_400_000,
    });
  expect((await at(0).resolve(userId)).allowed, 'a new account works (trial)');
  const later = await at(4).resolve(userId);
  expect(!later.allowed, 'four days later it is refused');
  const refusal = await at(4)
    .require(userId)
    .then(
      () => null,
      (e: { code?: string; hint?: string }) => e,
    );
  expect(
    refusal?.code === 'subscription_required' && String(refusal.hint).includes('/account'),
    'the refusal says where to subscribe',
  );

  const prices = await stripe('/v1/prices?active=true&lookup_keys[]=cf_pro_month');
  const price = (prices.data as { id: string }[])[0]?.id ?? '';
  const sub = await stripe('/v1/subscriptions', {
    customer,
    'items[0][price]': price,
    trial_period_days: '1',
    'trial_settings[end_behavior][missing_payment_method]': 'cancel',
    'metadata[app]': 'cuttingfloor',
    'metadata[smoke]': 'true',
  });
  expect(sub.status === 'trialing', `a $0 subscription with no card (${sub.status})`);
  const subscribed = await at(4).resolve(userId);
  expect(
    subscribed.allowed && subscribed.plan === 'pro',
    `subscribed works past the trial (${JSON.stringify(subscribed)})`,
  );
  await stripe(`/v1/subscriptions/${sub.id}`, undefined, 'DELETE');

  await workos(`/user_management/users/${userId}`, {
    method: 'PUT',
    body: { metadata: { ...linked, plan: 'lifetime' } },
  });
  const lifetime = await at(4).resolve(userId);
  expect(lifetime.allowed && lifetime.plan === 'lifetime', 'lifetime works past the trial');

  await stripe(`/v1/customers/${customer}`, undefined, 'DELETE');
} finally {
  await browser.close();
  await workos(`/user_management/users/${userId}`, { method: 'DELETE' });
  step('deleted the throwaway user and their Stripe customer');
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
