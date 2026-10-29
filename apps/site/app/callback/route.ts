import { track } from '@vercel/analytics/server';
import { handleAuth } from '@workos-inc/authkit-nextjs';

// WorkOS sends people back here after sign-in. An account made in the last ten minutes counts
// as a sign-up in Web Analytics; any other return is a sign-in.
export const GET = handleAuth({
  returnPathname: '/account',
  onSuccess: async ({ user, authenticationMethod }) => {
    const fresh = Date.now() - Date.parse(user.createdAt) < 10 * 60_000;
    await track(fresh ? 'Sign up' : 'Sign in', { method: authenticationMethod ?? 'unknown' }).catch(
      () => {},
    );
  },
});
