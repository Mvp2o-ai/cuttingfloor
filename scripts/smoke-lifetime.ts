// Lifetime for accounts used through a client that grants it (Kazi), against the real WorkOS.
//
//   node scripts/smoke-lifetime.ts
//
// Keys come from deploy/hetzner/cuttingfloor.env. Makes throwaway WorkOS users, has the server's
// own Lifecycle see a call from each through a client, and checks what their metadata and access
// say afterwards. Deletes the users after.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessCheck } from '../apps/hosted/src/access.ts';
import { Lifecycle } from '../apps/hosted/src/lifecycle.ts';
import { Runtime } from '../packages/server/src/index.ts';

const env = await readFile(new URL('../deploy/hetzner/cuttingfloor.env', import.meta.url), 'utf8');
const read = (name: string) => new RegExp(`^${name}=(\\S+)`, 'm').exec(env)?.[1] ?? '';
const workosKey = read('WORKOS_API_KEY');
const stripeKey = read('STRIPE_SECRET_KEY');
const KAZI = 'https://app.apifunnel.ai/api/user-mcp-connections/oauth/client-metadata';

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
const metadataOf = async (id: string) =>
  ((await workos(`/user_management/users/${id}`)).metadata ?? {}) as Record<string, string>;

const dir = await mkdtemp(join(tmpdir(), 'cf-smoke-lifetime-'));
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
const accountUrl = 'https://cuttingfloor.ai/account';
const access = new AccessCheck({ workosKey, stripeKey, accountUrl });
const lifecycle = new Lifecycle({
  runtime,
  access,
  workosKey,
  stripeKey,
  accountUrl,
  welcomeUrl: 'https://cuttingfloor.ai/welcome',
  serverUrl: 'https://api.cuttingfloor.ai',
  lifetimeClients: new Map([[KAZI, 'Kazi']]),
});

const users: string[] = [];
const make = async (name: string, metadata: Record<string, string> = {}) => {
  const user = await workos('/user_management/users', {
    method: 'POST',
    body: {
      email: `smoke-lifetime-${name}-${Date.now()}@cuttingfloor-smoke.dev`,
      email_verified: true,
      metadata,
    },
  });
  users.push(String(user.id));
  return String(user.id);
};

try {
  process.stdout.write('• a new account used through Kazi\n');
  const kazi = await make('kazi');
  await lifecycle.called(kazi, KAZI);
  const tagged = await metadataOf(kazi);
  expect(tagged.plan === 'lifetime', `tagged lifetime (${JSON.stringify(tagged)})`);
  expect(tagged.plan_reason === 'via Kazi', 'the reason says via Kazi');
  expect(Boolean(Date.parse(tagged.plan_since ?? '')), 'the date is recorded');
  const now = await access.get(kazi);
  expect(now.allowed && now.plan === 'lifetime', 'access says lifetime at once');
  await new Lifecycle({
    ...{ runtime, access, workosKey, stripeKey, accountUrl },
    welcomeUrl: '',
    serverUrl: '',
    lifetimeClients: new Map([[KAZI, 'Kazi']]),
  }).called(kazi, KAZI);
  expect((await metadataOf(kazi)).plan_since === tagged.plan_since, 'a later call changes nothing');

  process.stdout.write('• an account with a plan given already\n');
  const staff = await make('staff', { plan: 'admin' });
  await lifecycle.called(staff, KAZI);
  const kept = await metadataOf(staff);
  expect(kept.plan === 'admin' && !kept.plan_reason, `left as it was (${JSON.stringify(kept)})`);

  process.stdout.write('• an account used through another client\n');
  const other = await make('other');
  await lifecycle.called(other, 'https://example.com/client-metadata');
  expect(!(await metadataOf(other)).plan, 'not tagged');
} finally {
  for (const id of users) await workos(`/user_management/users/${id}`, { method: 'DELETE' });
  process.stdout.write(`• deleted ${users.length} throwaway users\n`);
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
