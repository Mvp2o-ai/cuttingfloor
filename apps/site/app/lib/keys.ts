import { server } from './files.ts';

// The account's script keys on the hosted server: what the account page lists, makes and
// revokes. The site asks with its account key for the signed-in user; a new key is shown once.

export type ScriptKey = {
  key_id: string;
  label: string;
  starts: string;
  created_at: string;
  expires_at: string;
};

/** The user's keys; undefined when the server can't say. */
export async function keysOf(userId: string): Promise<ScriptKey[] | undefined> {
  const s = server();
  if (!s) return undefined;
  try {
    const res = await fetch(`${s.base}/account/keys?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${s.key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { keys: ScriptKey[] }).keys;
  } catch {
    return undefined;
  }
}

/** Makes or revokes a key for the user: the server's answer as it is, with its status. */
export async function changeKeys(
  userId: string,
  change: { label: string } | { revoke: string },
): Promise<{ status: number; body: unknown }> {
  const s = server();
  if (!s) return { status: 503, body: { error: 'Keys are not available just now' } };
  const revoke = 'revoke' in change;
  try {
    const res = await fetch(`${s.base}/account/keys${revoke ? '/revoke' : ''}`, {
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
