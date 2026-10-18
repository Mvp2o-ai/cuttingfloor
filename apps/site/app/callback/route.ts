import { handleAuth } from '@workos-inc/authkit-nextjs';

// WorkOS sends people back here after sign-in.
export const GET = handleAuth({ returnPathname: '/account' });
