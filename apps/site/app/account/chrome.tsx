import { signOut } from '@workos-inc/authkit-nextjs';
import { headers } from 'next/headers';

/** The signed-in pages' nav: the wordmark, the account's email and Sign out. */
export function AccountNav({ email }: { email: string }) {
  return (
    <header className="nav">
      <div className="nav-inner">
        <a className="wordmark" href="/">
          <span className="marker" aria-hidden="true" />
          cuttingfloor
        </a>
        <nav className="nav-links" aria-label="Account">
          <a href="/welcome">Connect</a>
          <a href="/account">Account</a>
          <span className="account-email">{email}</span>
        </nav>
        <form
          action={async () => {
            'use server';
            // WorkOS returns only to an absolute address on its list: this site's own home page.
            const h = await headers();
            const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'cuttingfloor.ai';
            const proto = h.get('x-forwarded-proto') ?? 'https';
            await signOut({ returnTo: `${proto}://${host}/` });
          }}
        >
          <button type="submit" className="nav-cta as-button">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
