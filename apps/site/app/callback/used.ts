// The sign-in cookie a callback checks is deleted after its first use, so arriving at /callback a
// second time (Back from the next page, a reload) fails with one of these codes. The sign-in
// itself already happened or never started, so it isn't an error to show: someone signed in goes
// on (a new account into Kazi, as its sign-up meant), anyone else signs in again. Any other
// failure is real and still shows.
const USED = new Set(['missing_pkce_cookie', 'oauth_state_mismatch', 'missing_auth_params']);

/** Where a used or stale callback goes on to, or null when the error is real. */
export function afterUsedCallback(
  error: unknown,
  user: { createdAt: string } | null,
  now = Date.now(),
): string | null {
  // AuthKit's CallbackError, by its code (the package only loads inside Next).
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !USED.has(code)) return null;
  if (!user) return '/account';
  return now - Date.parse(user.createdAt) < 10 * 60_000 ? '/kazi' : '/account';
}
