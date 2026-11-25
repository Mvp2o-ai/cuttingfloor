import { track } from '@vercel/analytics/server';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { cookies } from 'next/headers';
import { FROM_COOKIE } from '../../from.tsx';
import { isNew, kaziLink } from '../../kazi/link.ts';

// For /kazi's page: the one-time link into Kazi for the new account signed in, or none (the page
// then goes to the welcome page). Only a new account gets one.
export async function POST() {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'signed out' }, { status: 401 });
  if (!isNew(user.createdAt)) return Response.json({ url: null }, { status: 409 });
  const url = await kaziLink(user.id, (await cookies()).get(FROM_COOKIE)?.value, {
    key: process.env.CUTTINGFLOOR_ACCOUNT_KEY,
    server: process.env.CUTTINGFLOOR_SERVER_URL,
  });
  await track(url ? 'Sign up: to Kazi' : 'Sign up: Kazi failed').catch(() => {});
  return Response.json(
    { url },
    { status: url ? 200 : 502, headers: { 'cache-control': 'no-store' } },
  );
}
