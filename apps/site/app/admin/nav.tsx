import { Marker } from '../shell.tsx';

/** The staff pages' nav: the wordmark, Accounts and the signed-in email. */
export function AdminNav({ email }: { email: string }) {
  return (
    <header className="nav">
      <div className="nav-inner">
        <a className="wordmark" href="/">
          <Marker />
          cuttingfloor
        </a>
        <nav className="nav-links account-links" aria-label="Staff">
          <a href="/admin">Accounts</a>
          <a href="/account">Your account</a>
          <span className="account-email">{email}</span>
        </nav>
      </div>
    </header>
  );
}
