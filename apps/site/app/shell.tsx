import { LEGAL_NAME, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import cli from '../../cli/package.json' with { type: 'json' };
import { DOCS_URL, SITE_URL } from './seo.ts';

// The chrome every page shares: the nav, the footer and the breadcrumb trail.

// Signing up: WorkOS's sign-up screen, then the welcome page that connects the agent.
export const SIGN_UP = '/start';
// Signing in: WorkOS's sign-in screen, then the account page.
export const SIGN_IN = '/account';

/** Solved: a check, drawn on once in the accent. */
export function Check() {
  return (
    <svg className="check" viewBox="0 0 48 40" role="img" aria-label="solved">
      <path d="M5 21 L18 33 L43 6" />
    </svg>
  );
}

/** cta: the button's words. Pages for creators say "Get started", without trial language. */
export function Nav({ cta = 'Start free' }: { cta?: string }) {
  return (
    <header className="nav">
      <div className="nav-inner">
        <a className="wordmark" href="/">
          <span className="marker" aria-hidden="true" />
          cuttingfloor
        </a>
        <nav className="nav-links" aria-label="Sections">
          <a href="/demos">Demos</a>
          <a href="/walkthroughs">Walkthroughs</a>
          <a href="/skills">Skills</a>
          <a href="/#how">How it works</a>
          <a href="/#pricing">Pricing</a>
          <a href={DOCS_URL}>Open source</a>
          <a href={SIGN_IN}>Sign in</a>
        </nav>
        <a className="nav-cta" href={SIGN_UP}>
          {cta}
        </a>
      </div>
    </header>
  );
}

export function Footer({ cta = 'Start free' }: { cta?: string }) {
  return (
    <footer className="cell footer marks">
      <span className="mark-b" />
      <div>
        <p className="display">
          Video editing, solved.
          <Check />
        </p>
        <div className="footer-links">
          <a href={SIGN_UP}>{cta}</a>
          <a href="/walkthroughs">Walkthroughs</a>
          <a href="/skills">Skills</a>
          <a href={DOCS_URL}>GitHub</a>
          <a href={`mailto:${SUPPORT_EMAIL}`}>Support</a>
          <a href="/status">Status</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/refunds">Refunds</a>
          <a href="/acceptable-use">Acceptable use</a>
        </div>
      </div>
      <div className="win">
        <div className="win-bar">
          <span>About</span>
          <span className="grip" />
        </div>
        <p>
          cuttingfloor {cli.version}
          <br />© {new Date().getFullYear()} {LEGAL_NAME}
          <br />
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
      </div>
    </footer>
  );
}

export type Crumb = { name: string; href: string };

/** The trail, shown and as BreadcrumbList. The last crumb is the page itself. */
export function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  const all = [{ name: 'Home', href: '/' }, ...trail];
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: all.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: new URL(c.href, SITE_URL).toString(),
    })),
  };
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <JsonLd data={data} />
      <ol>
        {all.map((c, i) =>
          i === all.length - 1 ? (
            <li key={c.href} aria-current="page">
              {c.name}
            </li>
          ) : (
            <li key={c.href}>
              <a href={c.href}>{c.name}</a>
            </li>
          ),
        )}
      </ol>
    </nav>
  );
}

export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant data, serialised for crawlers
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

/** "18 October 2026", for the visible Updated line. */
export function formatDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
