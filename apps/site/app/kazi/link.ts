import { KAZI_LINKS } from '../kazi.tsx';

// A one-time Kazi link for a new account: the server asks Kazi with the key that stays there, and
// the link comes back to the browser only. Kazi's links work once and for two minutes, so it is
// asked for when the page is ready to go there. Anything that isn't a Kazi link counts as no link.
export async function kaziLink(
  user: string,
  via: string | undefined,
  env: { key?: string; server?: string },
  call: typeof fetch = fetch,
): Promise<string | null> {
  if (!env.key) return null;
  try {
    const res = await call(`${env.server ?? 'https://api.cuttingfloor.ai'}/account/kazi-handoff`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        user,
        share_code: KAZI_LINKS.demos,
        ...(via && /^[a-z0-9-]{1,32}$/.test(via) ? { via } : {}),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const url = ((await res.json()) as { url?: string }).url;
    return url?.startsWith('https://app.apifunnel.ai/') ? url : null;
  } catch {
    return null;
  }
}

/** Whether the account was made in the last ten minutes, so this sign-in was its sign-up. */
export function isNew(createdAt: string, now = Date.now()): boolean {
  return now - Date.parse(createdAt) < 10 * 60_000;
}
