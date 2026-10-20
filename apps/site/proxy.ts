import { authkitProxy } from '@workos-inc/authkit-nextjs';

// Sessions for the signed-in pages only; the landing page stays static. Signed-out visitors to
// /account, /welcome and the billing routes go to the WorkOS sign-in first; /start sends them to
// the sign-up screen itself.
export default authkitProxy({
  middlewareAuth: { enabled: true, unauthenticatedPaths: ['/callback', '/start'] },
});

export const config = { matcher: ['/account', '/welcome', '/start', '/callback', '/api/:path*'] };
