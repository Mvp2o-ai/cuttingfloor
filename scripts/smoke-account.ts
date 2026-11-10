// End-to-end check of accounts and billing against the real WorkOS and Stripe (live mode).
//
//   CHROME_PATH=<chrome> node scripts/smoke-account.ts https://cuttingfloor-site.vercel.app
//
// A preview (develop) sits behind Vercel's team login: set VERCEL_BYPASS to the project's
// automation bypass secret (Settings → Deployment Protection; VERCEL_BYPASS in the env file).
//
// Keys come from deploy/hetzner/cuttingfloor.env. Makes a throwaway WorkOS user, signs in on the
// site through AuthKit, checks the account page shows the free credits, drops a file on its drop
// zone, opens Stripe Checkout for the smallest pack (stopping before payment), then checks the MCP
// server's access rules: free (no time limit), unverified, and lifetime. Deletes everything after.

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { AccessCheck } from '../apps/hosted/src/access.ts';
import { Ledger } from '../apps/hosted/src/ledger.ts';
import { Workspace } from '../packages/core/src/index.ts';
import { FREE_CREDITS, PACKS } from '../packages/plans/src/index.ts';

const site = (process.argv[2] ?? 'https://cuttingfloor-site.vercel.app').replace(/\/$/, '');
const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('Set CHROME_PATH to a Chrome or Chromium binary');
const env = await readFile(new URL('../deploy/hetzner/cuttingfloor.env', import.meta.url), 'utf8');
const read = (name: string) => new RegExp(`^${name}=(\\S+)`, 'm').exec(env)?.[1] ?? '';
const workosKey = read('WORKOS_API_KEY');
const ledger = new Ledger(read('KAZI_CREDITS_URL'), read('KAZI_CREDITS_KEY'));
const ws = new Workspace(await mkdtemp(join(tmpdir(), 'cf-smoke-account-')));
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
  step('signs in on the site and sees the free credits');
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  if (bypass)
    await page.goto(
      `${site}/?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`,
    );
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
  expect(
    text.includes(`${FREE_CREDITS} credits left.`),
    `the page says ${FREE_CREDITS} credits left`,
  );
  expect(text.includes('Upload your files'), 'the uploads come right after the credits');
  expect(text.includes(email), 'the page names the user');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  step('drops a file on the account page and it reaches the server');
  const dropped = join(await mkdtemp(join(tmpdir(), 'cf-smoke-drop-')), 'smoke-drop.mp4');
  await writeFile(dropped, randomBytes(64 * 1024));
  const picker = await page.waitForSelector('.drop input[type=file]', { timeout: 10_000 });
  expect(Boolean(picker), 'the account page has the drop zone');
  if (picker) {
    await (picker as unknown as { uploadFile(path: string): Promise<void> }).uploadFile(dropped);
    const sent = await page
      .waitForFunction(() => document.body.innerText.includes('Sent. Ask your agent'), {
        timeout: 60_000,
      })
      .then(
        () => true,
        () => false,
      );
    expect(sent, 'the file is sent');
    const listed = await page.evaluate(() =>
      [...document.querySelectorAll('.file-list li')].some(
        (li) => li.textContent?.includes('smoke-drop.mp4') && li.textContent.includes('kept until'),
      ),
    );
    expect(listed, 'it waits for the agent, with when it expires');
  }

  step('the welcome page walks through connecting');
  await page.goto(`${site}/welcome`, { waitUntil: 'networkidle2' });
  const welcome = await page.evaluate(() => document.body.innerText);
  expect(welcome.includes('Connect your agent.'), 'the welcome page shows');
  expect(welcome.includes('Waiting for your agent'), 'it waits for the first call');
  await page.goto(`${site}/account`, { waitUntil: 'networkidle2' });

  const pack = PACKS[0];
  if (!pack) throw new Error('no packs');
  step(`the $${pack.price} pack opens Stripe Checkout (stopping before payment)`);
  const [buy] = await page.$$(`xpath/.//button[normalize-space(.)="$${pack.price}"]`);
  if (!buy) throw new Error(`no $${pack.price} button`);
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), buy.click()]);
  await page.waitForFunction(() => document.body.innerText.includes('credits'), {
    timeout: 30_000,
  });
  const checkout = await page.evaluate(() => document.body.innerText);
  expect(page.url().startsWith('https://checkout.stripe.com/'), `on Stripe Checkout`);
  expect(checkout.includes(`${pack.credits} credits`), `it sells ${pack.credits} credits`);
  expect(new RegExp(`\\$${pack.price}(\\.00)?`).test(checkout), `at $${pack.price}`);
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
      ledger,
      ws,
      accountUrl: `${site}/account`,
      now: () => Date.now() + offsetDays * 86_400_000,
    });
  expect((await at(0).resolve(userId)).allowed, 'a new account works (free)');
  const limits = await at(0).limits(userId);
  expect(
    limits.jobs === 1 && limits.shortSide === 1080 && !limits.refuseJobs,
    `the free plan runs one job at a time, up to 1080p (${JSON.stringify(limits)})`,
  );
  const balance = await at(0).balance(userId);
  expect(
    balance.plan === 'free' && balance.left === FREE_CREDITS && balance.used === 0,
    `a new account has ${FREE_CREDITS} credits, none used (${JSON.stringify(balance)})`,
  );
  const outage = await new AccessCheck({
    workosKey: 'sk_test_not_a_key',
    stripeKey,
    ledger,
    ws,
    accountUrl: `${site}/account`,
  })
    .require(userId)
    .then(
      () => null,
      (e: { code?: string }) => e,
    );
  expect(
    outage?.code === 'service_unavailable',
    'an account that cannot be checked is refused, retryably',
  );
  const unverified = await workos('/user_management/users', {
    method: 'POST',
    body: { email: `unverified-${email}`, password, email_verified: false },
  });
  const pending = await at(0).resolve(unverified.id as string);
  expect(
    !pending.allowed && pending.reason === 'email_unverified',
    'an unverified email is refused until it is verified',
  );
  await workos(`/user_management/users/${unverified.id}`, { method: 'DELETE' });
  const later = await at(90).resolve(userId);
  expect(
    later.allowed && later.plan === 'free',
    'ninety days later it still works: free credits have no time limit',
  );

  await workos(`/user_management/users/${userId}`, {
    method: 'PUT',
    body: { metadata: { ...linked, plan: 'lifetime' } },
  });
  const lifetime = await at(0).resolve(userId);
  expect(lifetime.allowed && lifetime.plan === 'lifetime', 'lifetime counts as lifetime');

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
