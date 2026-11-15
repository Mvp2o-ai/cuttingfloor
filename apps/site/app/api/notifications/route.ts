import { withAuth } from '@workos-inc/authkit-nextjs';
import { server } from '../../lib/files.ts';

// File reminders: the email that names files going in 3 days or within a day, on or off. The
// server keeps the choice in the account's WorkOS metadata.
export async function POST(request: Request) {
  const { user } = await withAuth();
  const origin = new URL(request.url).origin;
  if (!user) return Response.redirect(`${origin}/account`, 303);
  const form = await request.formData();
  const s = server();
  if (s)
    await fetch(`${s.base}/account/notifications`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user: user.id, expiry_emails: form.get('on') === '1' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  return Response.redirect(`${origin}/account#notifications`, 303);
}
