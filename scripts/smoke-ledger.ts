// End-to-end check of credits in Kazi's ledger on the live server. Run it on the server, inside
// the image, so it uses production's keys (they never leave there):
//
//   ssh root@<server> 'cd /opt/cuttingfloor && docker compose exec -T cuttingfloor node scripts/smoke-ledger.ts'
//
// Makes a throwaway account and a script key for it, checks that the account is linked to the
// ledger with the free credits, runs a real job through /mcp and checks the ledger took exactly
// that job's credits, once (a repeat is a duplicate and changes nothing), and that automatic
// top-up is set and cleared in the ledger. Moves no money. Deletes the account, its key and its
// data after; the ledger account it printed is Kazi's to delete.

import { rm } from 'node:fs/promises';
import { linkPath } from '../apps/hosted/src/access.ts';
import { Ledger } from '../apps/hosted/src/ledger.ts';
import { Workspace } from '../packages/core/src/index.ts';
import { FREE_CREDITS } from '../packages/plans/src/index.ts';
import type { AccountGetResult } from '../packages/schema/src/index.ts';
import type { MeterEntry } from '../packages/server/src/index.ts';

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const workosKey = need('WORKOS_API_KEY');
const accountKey = need('CUTTINGFLOOR_ACCOUNT_KEY');
const ledger = new Ledger(need('KAZI_CREDITS_URL'), need('KAZI_CREDITS_KEY'));
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
let accountId = '';

try {
  const made = await site('/account/keys', { user: userId, label: 'smoke-ledger' });
  const key = String(made.key ?? '');
  keyId = String(made.key_id ?? '');
  expect(key.startsWith('cf_'), 'the server made a script key for the account');

  step('linked to the ledger');
  const account = async () =>
    (await site(`/account/usage?user=${userId}&fresh=1`)).account as AccountGetResult | undefined;
  const page = await account();
  expect(
    page?.credits.left === FREE_CREDITS && page.credits.used === 0 && page.plan === 'free',
    `the account page shows ${FREE_CREDITS} free credits (${JSON.stringify(page?.credits)})`,
  );
  const link = await ws.readJson<{ account_id: string }>(linkPath(ws, userId));
  accountId = link?.account_id ?? '';
  expect(Boolean(accountId), `the server kept its link (${accountId})`);
  const opened = await ledger.balance(accountId);
  expect(
    opened.balance === FREE_CREDITS &&
      opened.granted_total === FREE_CREDITS &&
      !opened.opening_total,
    `the ledger granted ${FREE_CREDITS} and carried nothing over (${JSON.stringify(opened)})`,
  );

  step('a real job spends its credits in the ledger, once');
  // Plain JSON-RPC, as any client sends it: the image carries no MCP client package.
  let session: string | undefined;
  let id = 0;
  const call = async (name: string, args: unknown) => {
    const res = await fetch(`${server}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name, arguments: args },
        id: ++id,
      }),
    });
    session = res.headers.get('mcp-session-id') ?? session;
    const text = await res.text();
    const body = text.trimStart().startsWith('{')
      ? text
      : (text
          .split('\n')
          .findLast((l) => l.startsWith('data:'))
          ?.slice(5) ?? '{}');
    const reply = JSON.parse(body) as {
      result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
    };
    return reply.result?.structuredContent ?? {};
  };
  const started = await call('create.matte', { color: '#1a1a1a', width: 640, height: 360 });
  const jobId = String(started.job_id ?? '');
  expect(jobId.length > 0, `create.matte started a job (${jobId})`);
  let status = '';
  for (let i = 0; i < 12 && status !== 'completed' && status !== 'failed'; i++)
    status = String((await call('job.get', { job_id: jobId, wait_seconds: 10 })).status ?? '');
  expect(status === 'completed', `the job finished (${status})`);
  let entry: MeterEntry | undefined;
  for (let i = 0; i < 20 && !entry; i++) {
    for (const month of await ws.list(ws.ownerDir(userId, 'meter')))
      entry ??= await ws.readJson<MeterEntry>(ws.ownerDir(userId, 'meter', month, `${jobId}.json`));
    if (!entry) await sleep(500);
  }
  const credits = Math.round(((entry?.seconds ?? 0) / 60) * 1000) / 1000;
  expect(credits > 0, `the meter recorded it (${entry?.seconds} s = ${credits} credits)`);
  let after = opened;
  for (let i = 0; i < 30 && after.used_total === 0; i++) {
    await sleep(1000);
    after = await ledger.balance(accountId);
  }
  expect(
    Math.abs(after.used_total - credits) < 1e-6 &&
      Math.abs(after.balance - (FREE_CREDITS - credits)) < 1e-6,
    `the ledger took exactly ${credits} (used ${after.used_total}, balance ${after.balance})`,
  );
  expect(
    Boolean(await ws.readJson(ws.ownerDir(userId, 'ledger-spent', `${jobId}.json`))),
    'the server marked the job spent',
  );
  const again = await ledger.usage({
    account_id: accountId,
    job_id: jobId,
    credits,
    tool: 'create.matte',
    finished_at: entry?.ended_at ?? new Date().toISOString(),
  });
  const still = await ledger.balance(accountId);
  expect(
    again.duplicate && still.balance === after.balance && still.used_total === after.used_total,
    `the same job again is a duplicate and changes nothing (${JSON.stringify(again)})`,
  );
  const shown = await account();
  expect(
    Math.abs((shown?.credits.left ?? 0) - Math.round(after.balance * 10) / 10) < 1e-6,
    `the account page shows the ledger's balance (${shown?.credits.left})`,
  );

  step('automatic top-up lives in the ledger');
  await site('/account/top-up', { user: userId, pack: 'cf_credits_5' });
  const on = await ledger.balance(accountId);
  const onPage = await account();
  expect(
    on.refill?.pack === 'cf_credits_5' && onPage?.top_up?.automatic === true,
    `turned on, in the ledger and on the page (${JSON.stringify(on.refill)})`,
  );
  await site('/account/top-up', { user: userId, pack: null });
  const off = await ledger.balance(accountId);
  expect(off.refill === null, 'turned off again');
} finally {
  if (keyId) await site('/account/keys/revoke', { user: userId, key_id: keyId }).catch(() => {});
  await workos(`/user_management/users/${userId}`, { method: 'DELETE' });
  await rm(ws.ownerDir(userId), { recursive: true, force: true });
  step(
    `deleted the throwaway account, its key and its data; ledger account ${accountId} is Kazi's to delete`,
  );
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
