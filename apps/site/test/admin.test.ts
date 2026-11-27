import { NextRequest } from 'next/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The staff pages: signed-out visitors go to sign-in, and the adjustment form's route asks the
// hosted server as the signed-in person, with the site's own key, so the server's rights table
// decides. No key reaches the browser. The server's side is tested in apps/hosted.

const STAFF = 'user_01ADM1NABCDEFGHJKMNPQRSTVW';
const STRANGER = 'user_01STRANGERABCDEFGHJKMNPQRS';
const ACCOUNT = 'user_01R1CHABCDEFGHJKMNPQRSTVWX';
let signedIn: string | null = STAFF;

vi.mock('server-only', () => ({}));
vi.mock('@workos-inc/authkit-nextjs', () => ({
  authkitProxy: () => () => new Response(null, { status: 307, headers: { location: '/sign-in' } }),
  withAuth: async () => ({ user: signedIn ? { id: signedIn, email: 'x@example.com' } : null }),
}));

describe('the staff pages', () => {
  let proxy: typeof import('../proxy.ts').default;
  beforeAll(async () => {
    proxy = (await import('../proxy.ts')).default;
  });
  const open = (path: string) =>
    proxy(new NextRequest(`https://cuttingfloor.ai${path}`), {} as never) as Promise<Response>;

  it('send signed-out visitors to sign in', async () => {
    expect((await open('/admin')).status).toBe(307);
    expect((await open(`/admin/${ACCOUNT}`)).status).toBe(307);
    expect((await open('/api/admin/adjust')).status).toBe(307);
    // The fixtures page is for development and holds no one's data.
    expect((await open('/admin/preview')).status).toBe(200);
  });
});

describe('POST /api/admin/adjust', () => {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  let POST: typeof import('../app/api/admin/adjust/route.ts').POST;

  beforeAll(async () => {
    vi.stubEnv('CUTTINGFLOOR_ACCOUNT_KEY', 'site-key-0123456789abcdef');
    vi.stubEnv('CUTTINGFLOOR_SERVER_URL', 'https://api.example.com');
    // The hosted server, as far as the route sees it: admins in its rights table get through.
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      calls.push({ url: String(input), headers, body: JSON.parse(String(init.body ?? 'null')) });
      if (headers.get('x-cuttingfloor-admin') !== STAFF)
        return Response.json(
          { error: { code: 'forbidden', message: 'This account is not an admin' } },
          { status: 403 },
        );
      return Response.json({ entry: { id: 'adjust:f1' }, balance: 13, duplicate: false });
    });
    ({ POST } = await import('../app/api/admin/adjust/route.ts'));
  });
  afterEach(() => {
    calls.length = 0;
    signedIn = STAFF;
  });

  const post = (body: unknown) =>
    POST(
      new Request('https://cuttingfloor.ai/api/admin/adjust', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );

  it('asks the server as the signed-in person, with the site key', async () => {
    const res = await post({ account: ACCOUNT, id: 'f1', credits: 10, reason: 'refund' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ balance: 13 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`https://api.example.com/admin/v1/accounts/${ACCOUNT}/adjustments`);
    expect(call?.headers.get('authorization')).toBe('Bearer site-key-0123456789abcdef');
    expect(call?.headers.get('x-cuttingfloor-admin')).toBe(STAFF);
    expect(call?.body).toEqual({ id: 'f1', credits: 10, reason: 'refund' });
  });

  it("passes on the server's refusal for someone who is not staff", async () => {
    signedIn = STRANGER;
    const res = await post({ account: ACCOUNT, id: 'f2', credits: 10, reason: 'refund' });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'This account is not an admin' });
    // The answer never carries the site's key.
    expect(text).not.toContain('site-key');
  });

  it('refuses the signed out, and an account that is not an id, without asking', async () => {
    signedIn = null;
    expect((await post({ account: ACCOUNT, id: 'f3', credits: 1, reason: 'x' })).status).toBe(401);
    signedIn = STAFF;
    expect(
      (await post({ account: 'ken@example.com', id: 'f3', credits: 1, reason: 'x' })).status,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
