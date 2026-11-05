import { track } from '@vercel/analytics/server';
import { getSignUpUrl, withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';

// Start free: WorkOS's sign-up screen, then the welcome page that connects the agent. Someone
// already signed in goes straight there. Opening the sign-up screen counts as a step in Web
// Analytics, so the funnel shows who left before signing up and who left on WorkOS's screen.
export async function GET() {
  const { user } = await withAuth();
  if (user) redirect('/welcome');
  await track('Sign-up opened').catch(() => {});
  redirect(await getSignUpUrl({ returnTo: '/welcome' }));
}
