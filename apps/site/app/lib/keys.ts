import { server } from './files.ts';

// The account's script keys on the hosted server: what the account page lists, makes and
// revokes. The site asks with its account key for the signed-in user; a new key is shown once.
// Admin keys (cfa_…, for the admin API) work the same way under /account/admin-keys, and only
// for a user the server's rights table makes an admin.

/** Which keys: script keys for /mcp and /v1, or admin keys for /admin/v1. */
export type KeyKind = 'script' | 'admin';
const PATHS: Record<KeyKind, string> = { script: '/account/keys', admin: '/account/admin-keys' };

export type ScriptKey = {
  key_id: string;
  label: string;
  starts: string;
  created_at: string;
  expires_at: string;
};

/**
 * The user's keys; undefined when the server can't say, and for admin keys also when the user
 * is not an admin.
 */
export async function keysOf(
  userId: string,
  kind: KeyKind = 'script',
): Promise<ScriptKey[] | undefined> {
  const s = server();
  if (!s) return undefined;
  try {
    const res = await fetch(`${s.base}${PATHS[kind]}?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${s.key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { keys: ScriptKey[]; admin?: boolean };
    return kind === 'admin' && !body.admin ? undefined : body.keys;
  } catch {
    return undefined;
  }
}

/** Makes or revokes a key for the user: the server's answer as it is, with its status. */
export async function changeKeys(
  userId: string,
  change: { label: string } | { revoke: string },
  kind: KeyKind = 'script',
): Promise<{ status: number; body: unknown }> {
  const s = server();
  if (!s) return { status: 503, body: { error: 'Keys are not available just now' } };
  const revoke = 'revoke' in change;
  try {
    const res = await fetch(`${s.base}${PATHS[kind]}${revoke ? '/revoke' : ''}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        revoke ? { user: userId, key_id: change.revoke } : { user: userId, label: change.label },
      ),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: 503, body: { error: 'The server could not be reached; try again' } };
  }
}
