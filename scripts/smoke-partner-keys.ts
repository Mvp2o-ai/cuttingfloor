// Partner keys (POST /partner/keys) against the real WorkOS.
//
//   node scripts/smoke-partner-keys.ts
//
// Keys come from deploy/hetzner/cuttingfloor.env. Runs the hosted HTTP server in this process
// with a throwaway partner secret, asks it for keys for a new email and for an existing account,
// checks what WorkOS says and that each key calls /v1, then deletes the throwaway users through
// DELETE /partner/users and checks WorkOS no longer has them.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessCheck } from '../apps/hosted/src/access.ts';
import { createHttpServer } from '../apps/hosted/src/http.ts';
import { ScriptKeys } from '../apps/hosted/src/keys.ts';
import { Ledger } from '../apps/hosted/src/ledger.ts';
import { Lifecycle, madeByPartner } from '../apps/hosted/src/lifecycle.ts';
import { WorkosSubscribers } from '../apps/hosted/src/sequence.ts';
import { LocalCredentialStore } from '../packages/credentials/src/index.ts';
import { Runtime } from '../packages/server/src/index.ts';

const env = await readFile(new URL('../deploy/hetzner/cuttingfloor.env', import.meta.url), 'utf8');
const read = (name: string) => new RegExp(`^${name}=(\\S+)`, 'm').exec(env)?.[1] ?? '';
const workosKey = read('WORKOS_API_KEY');
const stripeKey = read('STRIPE_SECRET_KEY');
const SECRET = `cfp_smoke_${Date.now()}`;

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

const dir = await mkdtemp(join(tmpdir(), 'cf-smoke-partner-'));
const runtime = new Runtime({
  dataDir: join(dir, 'data'),
  mode: 'hosted',
  publicUrl: 'http://127.0.0.1:0',
  mediaRoots: [],
  exportsDir: null,
  maxJobs: 1,
  outputUrlTtlMs: 60_000,
  maxDownloadBytes: 1024,
  allowPrivateUrls: false,
  inlineMaxBytes: 1024,
  motionUrl: null,
});
await runtime.start({ sweep: false });
const accountUrl = 'https://cuttingfloor.ai/account';
const ledger = new Ledger(read('KAZI_CREDITS_URL'), read('KAZI_CREDITS_KEY'));
const access = new AccessCheck({ workosKey, stripeKey, ledger, accountUrl, ws: runtime.ws });
const keys = new ScriptKeys(runtime.ws);
const lifecycle = new Lifecycle({
  runtime,
  access,
  ledger,
  workosKey,
  stripeKey,
  accountUrl,
  keys,
  partners: new Map([[createHash('sha256').update(SECRET).digest('hex'), 'Kazi']]),
});
const server = createHttpServer({
  runtime,
  credentials: new LocalCredentialStore({}, false),
  apiKeys: new Map(),
  scriptKeys: keys,
  access: async (owner) => void (await access.require(owner)),
  route: (req, res, url) => lifecycle.route(req, res, url),
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const provision = async (email: string, sub: string) => {
  const res = await fetch(`${base}/partner/keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, sub }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const remove = async (email: string, sub: string) => {
  const res = await fetch(`${base}/partner/users`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, sub }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const v1 = async (key: string) =>
  (
    await fetch(`${base}/v1/media.list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: '{}',
    })
  ).status;

const users = new Set<string>();
try {
  process.stdout.write('• a new email\n');
  const email = `smoke-partner-new-${Date.now()}@cuttingfloor-smoke.dev`;
  const newSub = `smoke-sub-${Date.now()}`;
  const made = await provision(email, newSub);
  const owner = String(made.body.owner ?? '');
  if (owner) users.add(owner);
  expect(made.status === 200 && made.body.created === true, `made an account (${made.status})`);
  const user = await workos(`/user_management/users/${owner}`);
  const metadata = (user.metadata ?? {}) as Record<string, string>;
  expect(user.email === email && user.email_verified === true, 'with the email, verified');
  expect(!metadata.plan && madeByPartner(metadata), 'made by Kazi, with no plan given');
  expect((await v1(String(made.body.key))) === 200, 'the key calls /v1');
  const welcomed: string[] = [];
  for await (const s of new WorkosSubscribers(workosKey).createdSince(Date.now() - 600_000))
    welcomed.push(s.id);
  expect(!welcomed.includes(owner), 'no sign-up email for it (WorkOS lists its metadata)');

  process.stdout.write('• an email that already has an account\n');
  const existing = await workos('/user_management/users', {
    method: 'POST',
    body: {
      email: `smoke-partner-old-${Date.now()}@cuttingfloor-smoke.dev`,
      email_verified: true,
    },
  });
  users.add(String(existing.id));
  const sub = `smoke-sub-old-${Date.now()}`;
  const first = await provision(String(existing.email), sub);
  expect(
    first.status === 200 && first.body.owner === existing.id && first.body.created === false,
    `the same account (${first.status})`,
  );
  const tagged = (await workos(`/user_management/users/${existing.id}`)).metadata as Record<
    string,
    string
  >;
  expect(!tagged.plan && !tagged.plan_reason, 'left as it was');
  const second = await provision(String(existing.email), sub);
  expect((await v1(String(first.body.key))) === 401, 'a second call revokes the first key');
  expect((await v1(String(second.body.key))) === 200, 'and its key works');
  const moved = await provision(`elsewhere-${Date.now()}@cuttingfloor-smoke.dev`, sub);
  expect(moved.status === 409, 'the user id with another email is refused');

  process.stdout.write('• deleting them as the partner\n');
  for (const [address, userSub, id, key] of [
    [email, newSub, owner, String(made.body.key)],
    [String(existing.email), sub, String(existing.id), String(second.body.key)],
  ]) {
    const gone = await remove(address, userSub);
    expect(
      gone.status === 200 && gone.body.deleted === true,
      `deleted ${address} (${gone.status})`,
    );
    const left = await fetch(`https://api.workos.com/user_management/users/${id}`, {
      headers: { authorization: `Bearer ${workosKey}` },
    });
    expect(left.status === 404, `WorkOS no longer has it (${left.status})`);
    expect((await v1(key)) === 401, 'its key stops');
    const again = await remove(address, userSub);
    expect(again.status === 404 && again.body.error === 'account_not_found', 'a repeat is a 404');
  }
} finally {
  for (const id of users) {
    const res = await fetch(`https://api.workos.com/user_management/users/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workosKey}` },
    });
    if (!res.ok && res.status !== 404) process.stdout.write(`  ✗ could not delete ${id}\n`);
  }
  process.stdout.write(`• no throwaway user left (${users.size} made)\n`);
  server.close();
  runtime.stop();
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
process.exit(0);
