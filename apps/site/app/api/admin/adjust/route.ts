import { withAuth } from '@workos-inc/authkit-nextjs';
import { adjustCredits } from '../../../lib/admin.ts';

// The admin page's adjustment form: credits plus or minus on one account, with a reason, written
// by the server for the staff member signed in here. The server checks they are an admin (its
// rights table) and refuses anyone else; the form's id makes a resent form count once.

export async function POST(request: Request) {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const account = typeof body.account === 'string' ? body.account : '';
  if (!/^user_[0-9A-Z]{26}$/.test(account))
    return Response.json({ error: 'account must be a WorkOS user id' }, { status: 400 });
  const done = await adjustCredits(user.id, account, {
    id: typeof body.id === 'string' ? body.id : '',
    credits: typeof body.credits === 'number' ? body.credits : Number.NaN,
    reason: typeof body.reason === 'string' ? body.reason : '',
  });
  return Response.json(done.ok ? done.body : { error: done.message }, {
    status: done.ok ? 200 : done.status,
    headers: { 'cache-control': 'no-store' },
  });
}
