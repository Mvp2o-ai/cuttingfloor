import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { REFERRAL_CODE, referralPath, referredBy } from '../app/referral.ts';
import { readSource, SOURCE_COOKIE, sourceLabel } from '../app/source.tsx';

// A person's link, /r/<code>: it opens without sign-in, leaves the tagged links' 30-day cookie
// naming the code, and the sign-up keeps the code. A review copy's release page shares /r/ and
// still asks for sign-in.

vi.mock('@workos-inc/authkit-nextjs', () => ({
  authkitProxy: () => () => new Response(null, { status: 307, headers: { location: '/sign-in' } }),
}));

describe('a referral link', () => {
  let proxy: typeof import('../proxy.ts').default;
  beforeAll(async () => {
    proxy = (await import('../proxy.ts')).default;
  });
  const open = (path: string) =>
    proxy(new NextRequest(`https://cuttingfloor.ai${path}`), {} as never);

  it('tells a code from a release page’s file id', () => {
    expect(referralPath('/r/k3x9mnpq')).toBe('k3x9mnpq');
    expect(referralPath('/r/j_01KAB3XYZ7Q8RSTUVW12345678')).toBeUndefined();
    expect(referralPath('/r/m_01kab3xyz7q8rstuvw12345678')).toBeUndefined();
    // Crockford base32 has no i, l, o or u, and a code is exactly eight long.
    expect(REFERRAL_CODE.test('k3x9mnpo')).toBe(false);
    expect(REFERRAL_CODE.test('K3X9MNPQ')).toBe(false);
    expect(referralPath('/r/k3x9mnp')).toBeUndefined();
    expect(referralPath('/r/k3x9mnpq/x')).toBeUndefined();
  });

  it('opens without sign-in and leaves the code in the tagged links’ cookie for 30 days', async () => {
    const res = await open('/r/k3x9mnpq');
    expect(res?.headers.get('location')).toBeNull();
    const cookie = res?.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SOURCE_COOKIE}=referral~k3x9mnpq~`);
    expect(cookie).toMatch(/Max-Age=2592000/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Secure/i);
  });

  it('still sends a release page through sign-in, and sets no cookie', async () => {
    const res = await open('/r/j_01KAB3XYZ7Q8RSTUVW12345678');
    expect(res?.headers.get('location')).toBe('/sign-in');
  });

  it('gives the sign-up its source and referred_by', () => {
    const value = readSource('referral~k3x9mnpq~');
    expect(value).toBe('referral~k3x9mnpq~');
    expect(sourceLabel(value ?? '')).toBe('referral / k3x9mnpq');
    expect(referredBy(value)).toBe('k3x9mnpq');
    // A campaign link, or a referral tag with no well-formed code, refers no one.
    expect(referredBy('reddit~capcut~bollywood')).toBeUndefined();
    expect(referredBy('referral~k3x9mnpo~')).toBeUndefined();
    expect(referredBy(undefined)).toBeUndefined();
  });
});
