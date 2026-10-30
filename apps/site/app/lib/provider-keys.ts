import { server } from './files.ts';

// The account's own provider keys on the hosted server (its sync. labs key, for lip sync). The
// site asks with its account key for the signed-in user. A key goes to the server once and never
// comes back; only its last four characters are shown.

export type SavedKey = { provider: string; ends: string };

/** The user's saved keys; undefined when the server can't say. */
export async function providerKeysOf(userId: string): Promise<SavedKey[] | undefined> {
  const s = server();
  if (!s) return undefined;
  try {
    const res = await fetch(`${s.base}/account/provider-keys?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${s.key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { keys: SavedKey[] }).keys;
  } catch {
    return undefined;
  }
}

/** Saves or removes a key for the user: the server's answer as it is, with its status. */
export async function changeProviderKey(
  userId: string,
  change: { provider: string; key: string } | { provider: string; remove: true },
): Promise<{ status: number; body: unknown }> {
  const s = server();
  if (!s) return { status: 503, body: { error: 'Keys are not available just now' } };
  const remove = 'remove' in change;
  try {
    const res = await fetch(`${s.base}/account/provider-keys${remove ? '/remove' : ''}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        remove
          ? { user: userId, provider: change.provider }
          : { user: userId, provider: change.provider, key: change.key },
      ),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: 503, body: { error: 'The server could not be reached; try again' } };
  }
}
