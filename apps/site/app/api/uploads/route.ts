import { withAuth } from '@workos-inc/authkit-nextjs';
import { filesOf, startUpload } from '../../lib/files.ts';

// The account page's drop zone. GET lists the signed-in user's files; POST {name, bytes} starts
// an upload and returns the signed URL the browser sends the file to; POST {upload_id} returns an
// unfinished upload's URL again, to carry on where it stopped.

export async function GET() {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
  const files = await filesOf(user.id);
  if (!files) return Response.json({ error: 'Your files could not be read' }, { status: 503 });
  return Response.json(files, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'Sign in first' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    name?: unknown;
    bytes?: unknown;
    upload_id?: unknown;
  };
  if (typeof body.upload_id === 'string') {
    const resumed = await startUpload(user.id, { uploadId: body.upload_id });
    return Response.json(resumed.body, { status: resumed.status });
  }
  if (typeof body.name !== 'string' || typeof body.bytes !== 'number')
    return Response.json({ error: 'Give the file name and size' }, { status: 400 });
  const started = await startUpload(user.id, { name: body.name, bytes: body.bytes });
  return Response.json(started.body, { status: started.status });
}
