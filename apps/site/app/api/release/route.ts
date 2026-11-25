import { withAuth } from '@workos-inc/authkit-nextjs';
import { FILE_ID, release } from '../../lib/release.ts';

// The release page's button: removes the watermark from the signed-in user's own file, then back
// to the page, which now offers the clean copy (or says the credits were short).
export async function POST(request: Request) {
  const { user } = await withAuth();
  const origin = new URL(request.url).origin;
  const form = await request.formData();
  const file = String(form.get('file') ?? '');
  if (!FILE_ID.test(file)) return Response.redirect(`${origin}/account`, 303);
  if (!user) return Response.redirect(`${origin}/r/${file}`, 303);
  const done = await release(user.id, file);
  const outcome = done.ok ? 'released' : done.status === 402 ? 'short' : 'failed';
  return Response.redirect(`${origin}/r/${file}?${outcome}=1`, 303);
}
