import { describe, expect, it } from 'vitest';
import { afterUsedCallback } from '../app/callback/used.ts';

// Arriving at /callback a second time (Back, a reload) found its one-use sign-in cookie gone and
// showed a 500, nine times over, to someone already signed in. It goes on now instead.

const NOW = Date.parse('2026-11-25T16:31:00Z');
const used = (code: string) => Object.assign(new Error('x'), { name: 'CallbackError', code });

describe('a callback arrived at again', () => {
  it('sends a new account on into Kazi, anyone else signed in to their account', () => {
    expect(
      afterUsedCallback(used('missing_pkce_cookie'), { createdAt: '2026-11-25T16:30:10Z' }, NOW),
    ).toBe('/kazi');
    expect(
      afterUsedCallback(used('oauth_state_mismatch'), { createdAt: '2026-10-01T00:00:00Z' }, NOW),
    ).toBe('/account');
  });

  it('sends someone signed out to sign in again', () => {
    expect(afterUsedCallback(used('missing_auth_params'), null, NOW)).toBe('/account');
  });

  it('leaves a real failure to show', () => {
    expect(afterUsedCallback(new Error('invalid_grant'), null, NOW)).toBeNull();
    expect(
      afterUsedCallback(used('missing_tokens'), { createdAt: '2026-11-25T16:30:10Z' }, NOW),
    ).toBeNull();
  });
});
