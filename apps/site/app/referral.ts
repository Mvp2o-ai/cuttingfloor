import { SOURCE_COOKIE, SOURCE_MAX_AGE } from './source.tsx';

// A person's own link, cuttingfloor.ai/r/<code>: the server makes each account's code from its
// id (apps/hosted/src/referral.ts), eight characters with nothing personal in them. Opening it
// leaves the same 30-day cookie a tagged link does (source.tsx), as `referral~<code>~`, so
// /callback keeps `source` (referral / <code>) and `referred_by` (<code>) on the new account.
// A review copy's release page shares /r/: its file ids start `j_` or `m_`, a code never has `_`.

/** A referral code: eight lowercase Crockford base32 characters (no i, l, o or u). */
export const REFERRAL_CODE = /^[0-9a-hjkmnp-tv-z]{8}$/;

/** The source tag a referral link leaves. */
const REFERRAL = 'referral';

/** The code of a /r/<code> path, or undefined when the path is anything else. */
export function referralPath(pathname: string): string | undefined {
  const code = /^\/r\/([^/]+)$/.exec(pathname)?.[1];
  return code && REFERRAL_CODE.test(code) ? code : undefined;
}

/** The cookie a referral link leaves: the tagged links' cookie, its source `referral`. */
export function referralCookie(code: string, secure: boolean) {
  return {
    name: SOURCE_COOKIE,
    value: `${REFERRAL}~${code}~`,
    maxAge: SOURCE_MAX_AGE,
    path: '/',
    sameSite: 'lax' as const,
    secure,
  };
}

/** The code a stored source names, when the visit that set it was a referral link. */
export function referredBy(source: string | undefined): string | undefined {
  const [tag, code] = (source ?? '').split('~');
  return tag === REFERRAL && code && REFERRAL_CODE.test(code) ? code : undefined;
}
