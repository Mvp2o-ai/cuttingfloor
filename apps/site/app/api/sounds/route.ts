import { withAuth } from '@workos-inc/authkit-nextjs';
import { accountSounds } from '../../lib/sounds.ts';

// The signed-in user's community sounds. GET lists them; POST {upload_id or media_id,
// name, description, category, tags, author?} shares one of their files; POST {remove: sound_id}
// takes one down.

export const maxDuration = 120;

export async function GET() {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
  const { status, body } = await accountSounds('', { method: 'GET', user: user.id });
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
  const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!body) return Response.json({ error: 'Send JSON' }, { status: 400 });
  if (typeof body.remove === 'string') {
    const { status, body: answer } = await accountSounds('/remove', {
      method: 'POST',
      body: { user: user.id, sound_id: body.remove },
    });
    return Response.json(answer, { status });
  }
  const { status, body: answer } = await accountSounds('', {
    method: 'POST',
    body: { ...body, user: user.id },
  });
  return Response.json(answer, { status });
}
