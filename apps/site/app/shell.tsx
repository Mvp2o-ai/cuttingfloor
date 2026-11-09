import { LEGAL_NAME, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import cli from '../../cli/package.json' with { type: 'json' };
import { NOT_FROM_AGENT, onlyFrom } from './from.tsx';
import { kaziUrl } from './kazi.tsx';
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

// The live demo, on every page: the menu link, and a strip under the nav that phones see too.
const LIVE_DEMO = kaziUrl('demos');
const PHONE_KAZI = kaziUrl('phone');

/** cta: the button's words. Pages for creators say "Get started", without trial language. */
export function Nav({ cta = 'Start free' }: { cta?: string }) {
  return (
    <header className="nav">
      <div className="nav-inner">
        <a className="wordmark" href="/">
          <svg
            className="marker"
            viewBox="0 0 32 32"
            width="18"
            height="18"
            fill="#00B140"
            aria-hidden="true"
          >
            <path d="M4.4 4.4H24.4L4.4 24.4Z" />
            <path d="M27.6 7.6V27.6H7.6Z" />
          </svg>
          cuttingfloor
        </a>
        <nav className="nav-links" aria-label="Sections">
          <a className="nav-live" href={LIVE_DEMO} rel="noopener" data-track="Live demo: menu">
            Watch it live
          </a>
          <a href="/#session">How it works</a>
          <a href="/demos">Demos</a>
          <a href="/features">Features</a>
          <a href="/mcp">What is MCP</a>
          <a href="/connect">Connect</a>
          <a href="/pricing">Pricing</a>
          <a href={SIGN_IN}>Sign in</a>
        </nav>
        <a className="nav-cta" href={SIGN_UP}>
          {cta}
        </a>
      </div>
      <a
        className="live-strip"
        href={LIVE_DEMO}
        rel="noopener"
        data-track="Live demo: strip"
        {...NOT_FROM_AGENT}
      >
        <b>
          Watch it live now <span aria-hidden="true">→</span>
        </b>
        <small>
          Kazi gives Big Buck Bunny a happy ending. Free, no sign-up. Then add it to your ChatGPT,
          Claude or Kazi.
        </small>
      </a>
      <a
        className="live-strip on-computer"
        href="/connect#chatgpt"
        data-track="From ChatGPT: strip"
        {...onlyFrom('chatgpt')}
      >
        <b>
          Add cuttingfloor to ChatGPT <span aria-hidden="true">→</span>
        </b>
        <small>Paste one address as a connector, then ask ChatGPT to edit your video.</small>
      </a>
      <a
        className="live-strip on-computer"
        href="/connect#claude"
        data-track="From Claude: strip"
        {...onlyFrom('claude')}
      >
        <b>
          Add cuttingfloor to Claude <span aria-hidden="true">→</span>
        </b>
        <small>Paste one address as a connector, then ask Claude to edit your video.</small>
      </a>
      {/* ChatGPT and Claude add servers only on a computer; Kazi works on this phone. */}
      {(['ChatGPT', 'Claude'] as const).map((name) => (
        <a
          key={name}
          className="live-strip on-phone"
          href={PHONE_KAZI}
          rel="noopener"
          data-track={`From ${name}: phone strip`}
          {...onlyFrom(name === 'ChatGPT' ? 'chatgpt' : 'claude')}
        >
          <b>
            Try it on this phone in Kazi <span aria-hidden="true">→</span>
          </b>
          <small>Free. {name} adds cuttingfloor on a computer; Kazi works right here.</small>
        </a>
      ))}
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
          <a href="/agents">Agents</a>
          <a href="/fixes">Fixes</a>
          <a href="/guides/add-captions-to-a-video">Captions</a>
          <a href="/es/editar-videos-con-ia" hrefLang="es">
            En español
          </a>
          <a href="/walkthroughs">Walkthroughs</a>
          <a href="/skills">Skills</a>
          <a href="/features">Features</a>
          <a href="/mcp">What is MCP</a>
          <a href="/pricing">Pricing</a>
          <a href="/connect">Connect</a>
          <a href="/self-host">Self-host</a>
          <a href="/compare">Compare</a>
          <a href="/alternatives">Alternatives</a>
          <a href={DOCS_URL}>GitHub</a>
          <a href="/support">Support</a>
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

/** "18 October 2026" (or "18 de octubre de 2026"), for the visible Updated line. */
export function formatDate(iso: string, lang: 'en' | 'es' = 'en'): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
