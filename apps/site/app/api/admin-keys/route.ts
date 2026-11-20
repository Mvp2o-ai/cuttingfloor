import { withAuth } from '@workos-inc/authkit-nextjs';
import { changeKeys, keysOf } from '../../lib/keys.ts';

// The account page's admin keys, for a signed-in admin: as /api/keys does for script keys. The
// server refuses anyone its rights table doesn't make an admin.

export async function GET() {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
  const keys = await keysOf(user.id, 'admin');
  if (!keys) return Response.json({ error: 'Your keys could not be read' }, { status: 503 });
  return Response.json({ keys }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { label?: unknown; revoke?: unknown };
  const done = await changeKeys(
    user.id,
    typeof body.revoke === 'string'
      ? { revoke: body.revoke }
      : { label: typeof body.label === 'string' ? body.label : '' },
    'admin',
  );
  return Response.json(done.body, {
    status: done.status,
    headers: { 'cache-control': 'no-store' },
  });
}
