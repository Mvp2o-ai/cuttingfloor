import { track } from '@vercel/analytics/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { KAZI_LINKS } from '../kazi.tsx';

// After sign-up on the site: straight into Kazi, signed in as themselves, with cuttingfloor
// connected to this account and the live demo open (no guest limit; it's their account). Accounts
// made on the site with no agent of their own did nothing at all, while those made inside an AI
// app got to work. The server asks Kazi for a one-time link (the key that does it stays there);
// when Kazi can't answer, the welcome page that connects an agent, as before. Someone who signed
// in to an older account on the sign-up screen gets that page too: only a new account goes on.
export async function GET() {
  const { user } = await withAuth({ ensureSignedIn: true });
  if (Date.now() - Date.parse(user.createdAt) > 10 * 60_000) redirect('/welcome');
  const key = process.env.CUTTINGFLOOR_ACCOUNT_KEY;
  const server = process.env.CUTTINGFLOOR_SERVER_URL ?? 'https://api.cuttingfloor.ai';
  let url: string | undefined;
  if (key) {
    try {
      const res = await fetch(`${server}/account/kazi-handoff`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ user: user.id, share_code: KAZI_LINKS.demos }),
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) url = ((await res.json()) as { url?: string }).url;
    } catch {}
  }
  await track(url ? 'Sign up: to Kazi' : 'Sign up: Kazi failed').catch(() => {});
  redirect(url?.startsWith('https://app.apifunnel.ai/') ? url : '/welcome');
}
