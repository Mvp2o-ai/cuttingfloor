// End-to-end check of cuttingfloor's credit ledger on the live server. Run it on the server, inside
// the image, so it uses production's keys and record database (they never leave there):
//
//   ssh root@<server> 'cd /opt/cuttingfloor && docker compose exec -T cuttingfloor node scripts/smoke-ledger.ts'
//
// Makes a throwaway account and a script key for it, checks that its ledger account opened with
// the activation grant and nothing else, that /v1/credits shows it as the phone app reads it, that
// automatic top-up is set and cleared in the ledger, and that the balance equals its entries.
// Moves no money. Deletes the account, its key, its data and its ledger account after.

import { rm } from 'node:fs/promises';
import { totals } from '../apps/hosted/src/ledger.ts';
import { ledgerFromEnv } from '../apps/hosted/src/ledger-store.ts';
import { Workspace } from '../packages/core/src/index.ts';
import { FREE_CREDITS } from '../packages/plans/src/index.ts';
import type { AccountGetResult } from '../packages/schema/src/index.ts';

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const workosKey = need('WORKOS_API_KEY');
const accountKey = need('CUTTINGFLOOR_ACCOUNT_KEY');
const { ledger, close } = ledgerFromEnv();
const ws = new Workspace(process.env.CUTTINGFLOOR_DATA ?? '/data');
const server = (process.env.CUTTINGFLOOR_PUBLIC_URL ?? 'https://api.cuttingfloor.ai').replace(
  /\/$/,
  '',
);

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

async function site(path: string, body?: unknown) {
  const res = await fetch(`${server}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${accountKey}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await res.json()) as Record<string, unknown>;
}

const email = `smoke-ledger-${Date.now()}@cuttingfloor-smoke.dev`;
const user = await workos('/user_management/users', {
  method: 'POST',
  body: { email, email_verified: true, first_name: 'Smoke' },
});
const userId = user.id as string;
step(`a throwaway account (${userId}, ${email})`);
let keyId = '';

try {
  const made = await site('/account/keys', { user: userId, label: 'smoke-ledger' });
  const key = String(made.key ?? '');
  keyId = String(made.key_id ?? '');
  expect(key.startsWith('cf_'), 'the server made a script key for the account');

  step('opened in the ledger with the activation grant');
  const account = async () =>
    (await site(`/account/usage?user=${userId}&fresh=1`)).account as AccountGetResult | undefined;
  const page = await account();
  expect(
    page?.credits.left === FREE_CREDITS && page.credits.used === 0 && page.plan === 'free',
    `the account page shows ${FREE_CREDITS} credits (${JSON.stringify(page?.credits)})`,
  );
  const opened = await ledger.get(userId);
  const entries = await ledger.entries(userId);
  expect(
    opened?.balance === FREE_CREDITS &&
      entries.length === 1 &&
      entries[0]?.id === 'grant:activation',
    `the ledger granted ${FREE_CREDITS} and nothing else (${JSON.stringify(entries)})`,
  );

  step('the phone app’s view');
  const phone = (await (
    await fetch(`${server}/v1/credits`, { headers: { authorization: `Bearer ${key}` } })
  ).json()) as { balance?: number; apple_products?: unknown[]; apple_account_token?: string };
  expect(
    phone.balance === FREE_CREDITS &&
      Boolean(phone.apple_products?.length) &&
      /^[0-9a-f-]{36}$/.test(phone.apple_account_token ?? ''),
    `GET /v1/credits answers the balance, packs and token (${JSON.stringify(phone)})`,
  );

  step('automatic top-up lives in the ledger');
  await site('/account/top-up', { user: userId, pack: 'cf_credits_5' });
  const on = await ledger.get(userId);
  const onPage = await account();
  expect(
    on?.refill?.pack === 'cf_credits_5' && onPage?.top_up?.automatic === true,
    `turned on, in the ledger and on the page (${JSON.stringify(on?.refill)})`,
  );
  await site('/account/top-up', { user: userId, pack: null });
  expect((await ledger.get(userId))?.refill === null, 'turned off again');

  const summed = totals(await ledger.entries(userId));
  const now = await ledger.get(userId);
  expect(
    now?.balance === summed.balance && now?.granted_total === summed.granted_total,
    'the balance and totals equal the entries',
  );
} finally {
  if (keyId) await site('/account/keys/revoke', { user: userId, key_id: keyId }).catch(() => {});
  await workos(`/user_management/users/${userId}`, { method: 'DELETE' });
  await rm(ws.ownerDir(userId), { recursive: true, force: true });
  await ws.records.forget(userId).catch(() => {});
  await ledger.forget(userId);
  await close();
  step('deleted the throwaway account, its key, its data and its ledger account');
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
