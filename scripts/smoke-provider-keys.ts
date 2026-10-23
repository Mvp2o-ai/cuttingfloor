// Provider keys saved on the account page, against the real WorkOS.
//
//   node scripts/smoke-provider-keys.ts
//
// Keys come from deploy/hetzner/cuttingfloor.env (WORKOS_API_KEY, CUTTINGFLOOR_KEY_SECRET).
// Makes a throwaway WorkOS user, saves a made-up sync. labs key for it, and checks it reads back,
// shows only its last four characters, is stored only as ciphertext, can't be read with another
// secret, and is gone once removed. Deletes the user after.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ProviderKeys } from '../apps/hosted/src/provider-keys.ts';

const env = await readFile(new URL('../deploy/hetzner/cuttingfloor.env', import.meta.url), 'utf8');
const read = (name: string) => new RegExp(`^${name}=(\\S+)`, 'm').exec(env)?.[1] ?? '';
const workosKey = read('WORKOS_API_KEY');
const secret = read('CUTTINGFLOOR_KEY_SECRET');

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

const user = await workos('/user_management/users', {
  method: 'POST',
  body: { email: `smoke-keys-${Date.now()}@cuttingfloor-smoke.dev`, email_verified: true },
});
const id = String(user.id);
const key = `sk-smoke-${randomBytes(12).toString('hex')}`;
try {
  process.stdout.write('• save a key\n');
  const keys = new ProviderKeys(workosKey, secret);
  await keys.save(id, 'sync', key);
  expect((await keys.get(id, 'sync')) === key, 'reads back');
  const listed = await new ProviderKeys(workosKey, secret).list(id);
  expect(
    listed.length === 1 && listed[0]?.ends === key.slice(-4),
    `lists only its last four (${JSON.stringify(listed)})`,
  );
  const stored = JSON.stringify((await workos(`/user_management/users/${id}`)).metadata);
  expect(stored.includes('key_sync') && !stored.includes(key), 'WorkOS holds only ciphertext');
  const other = new ProviderKeys(workosKey, randomBytes(32).toString('base64'));
  expect((await other.get(id, 'sync')) === undefined, 'another secret reads nothing');

  process.stdout.write('• remove it\n');
  await keys.remove(id, 'sync');
  expect((await new ProviderKeys(workosKey, secret).get(id, 'sync')) === undefined, 'gone');
} finally {
  await workos(`/user_management/users/${id}`, { method: 'DELETE' });
  process.stdout.write('• deleted the throwaway user\n');
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
