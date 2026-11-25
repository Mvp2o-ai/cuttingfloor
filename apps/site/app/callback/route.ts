import { track } from '@vercel/analytics/server';
import { handleAuth, withAuth } from '@workos-inc/authkit-nextjs';
import { cookies } from 'next/headers';
import { setMetadata } from '../lib/billing.ts';
import { readSource, SOURCE_COOKIE, sourceLabel } from '../source.tsx';
import { afterUsedCallback } from './used.ts';

// WorkOS sends people back here after sign-in. An account made in the last ten minutes counts
// as a sign-up in Web Analytics; any other return is a sign-in. A sign-up that arrived by a
// tagged link (source.tsx) also sends "Sign up from: <source / campaign / content>" and keeps
// that label as `source` on the account, so its first export can be counted per campaign. None
// of it may stop a sign-in. A callback arrived at again (used.ts) goes on instead of failing.
export const GET = handleAuth({
  returnPathname: '/account',
  onSuccess: async ({ user, authenticationMethod }) => {
    const fresh = Date.now() - Date.parse(user.createdAt) < 10 * 60_000;
    await track(fresh ? 'Sign up' : 'Sign in', { method: authenticationMethod ?? 'unknown' }).catch(
      () => {},
    );
    if (!fresh) return;
    try {
      const value = readSource((await cookies()).get(SOURCE_COOKIE)?.value);
      if (!value) return;
      const label = sourceLabel(value);
      await track(`Sign up from: ${label}`, { label, method: authenticationMethod ?? 'unknown' });
      await setMetadata(user.id, { source: label });
    } catch {}
  },
  onError: async ({ error, request }) => {
    const user = await withAuth()
      .then((auth) => auth.user)
      .catch(() => null);
    const next = afterUsedCallback(error, user);
    // Built by hand: handleAuth adds its no-cache and cookie headers after, and a
    // Response.redirect's headers can't be changed.
    if (next)
      return new Response(null, {
        status: 307,
        headers: { location: new URL(next, request.url).href },
      });
    return new Response("Couldn't sign in. Please try again from cuttingfloor.ai.", {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
});
