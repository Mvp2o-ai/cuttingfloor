import { withAuth } from '@workos-inc/authkit-nextjs';
import { changeProviderKey, providerKeysOf } from '../../lib/provider-keys.ts';

// The account page's provider keys. GET lists which the signed-in user saved (last four
// characters); POST {provider, key} saves one; POST {provider, remove: true} takes it off.

export async function GET() {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
  const keys = await providerKeysOf(user.id);
  if (!keys) return Response.json({ error: 'Your keys could not be read' }, { status: 503 });
  return Response.json({ keys }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    provider?: unknown;
    key?: unknown;
    remove?: unknown;
  };
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const done = await changeProviderKey(
    user.id,
    body.remove === true
      ? { provider, remove: true }
      : { provider, key: typeof body.key === 'string' ? body.key : '' },
  );
  return Response.json(done.body, {
    status: done.status,
    headers: { 'cache-control': 'no-store' },
  });
}
