import { signOut } from '@workos-inc/authkit-nextjs';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { Marker } from './shell.tsx';

// The look of the signed-in pages where work is done (account, files, staff): a slim bar, a plain
// page title, and cards with a header row, in a compact UI type. The landing look (big display
// type, cells) stays on every public page. Everything here sits inside .app, so its styles never
// reach the public pages.

export type AppLink = { href: string; label: string };

/** The bar: the wordmark, the page links, the signed-in email and Sign out. */
export function AppNav({
  email,
  links,
  current,
}: {
  email: string;
  links: AppLink[];
  /** The href of the page shown, to mark its link. */
  current?: string;
}) {
  return (
    <header className="app-nav">
      <div className="app-nav-inner">
        <a className="app-wordmark" href="/">
          <Marker />
          cuttingfloor
        </a>
        <nav className="app-links" aria-label="Account">
          {links.map((l) => (
            <a key={l.href} href={l.href} aria-current={l.href === current ? 'page' : undefined}>
              {l.label}
            </a>
          ))}
        </nav>
        <span className="app-email">{email}</span>
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
          <button type="submit" className="app-btn">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

/** The account pages' links; staff also get the staff pages. */
export function accountLinks(staff: boolean): AppLink[] {
  return [
    { href: '/account', label: 'Account' },
    { href: '/upload', label: 'Files' },
    { href: '/welcome', label: 'Connect' },
    ...(staff ? [{ href: '/admin', label: 'Staff' }] : []),
  ];
}

export const STAFF_LINKS: AppLink[] = [
  { href: '/admin', label: 'Accounts' },
  { href: '/account', label: 'Your account' },
];

/** A page: the bar, then a title row and the cards. */
export function AppPage({
  nav,
  title,
  sub,
  back,
  actions,
  children,
}: {
  nav: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  back?: AppLink;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app">
      {nav}
      <main className="app-main">
        {back ? (
          <a className="app-back" href={back.href}>
            ← {back.label}
          </a>
        ) : null}
        <div className="app-head">
          <div>
            <h1>{title}</h1>
            {sub ? <p className="app-sub">{sub}</p> : null}
          </div>
          {actions ? <div className="app-head-actions">{actions}</div> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

/** A card: a title with an optional action on the right, a line under it, then the body. */
export function Card({
  id,
  title,
  desc,
  action,
  tone,
  children,
}: {
  id?: string;
  title?: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
  /** key: a green-edged notice card. */
  tone?: 'key';
  children?: ReactNode;
}) {
  return (
    <section id={id} className={tone ? `app-card app-card-${tone}` : 'app-card'}>
      {title || action ? (
        <div className="app-card-head">
          {title ? <h2>{title}</h2> : <span />}
          {action ? <div className="app-card-action">{action}</div> : null}
        </div>
      ) : null}
      {desc ? <p className="app-card-desc">{desc}</p> : null}
      {children}
    </section>
  );
}

/** A small status pill. */
export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  return <span className={tone ? `app-badge app-badge-${tone}` : 'app-badge'}>{children}</span>;
}

/** Label and value pairs in a grid. */
export function Details({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="app-details">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
