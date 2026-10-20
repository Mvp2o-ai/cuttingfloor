import { getSignUpUrl, withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';

// Start free: WorkOS's sign-up screen, then the welcome page that connects the agent. Someone
// already signed in goes straight there.
export async function GET() {
  const { user } = await withAuth();
  if (user) redirect('/welcome');
  redirect(await getSignUpUrl({ returnTo: '/welcome' }));
}
