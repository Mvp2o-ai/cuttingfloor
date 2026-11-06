import type { Metadata } from 'next';
import { CLIENTS, CLIENTS_CHECKED, MCP_URL } from '../../content/clients.ts';
import { LiveCard } from '../live-card.tsx';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav, SIGN_UP } from '../shell.tsx';
import { Copy } from '../walkthroughs/copy.tsx';
import { ClientSection } from './client-section.tsx';
import { CONNECT_DESCRIPTION, CONNECT_FAQS, CONNECT_LEAD, CONNECT_TITLE, HOW } from './copy.ts';
import { LogoSlot } from './logo.tsx';

// One section per app: its steps as it labels them, and the config to paste. Everything comes
// from content/clients.ts, which the Markdown twin (/connect.md) reads too.

export const metadata: Metadata = {
  title: `${CONNECT_TITLE} | cuttingfloor`,
  description: CONNECT_DESCRIPTION,
  alternates: { canonical: '/connect', types: { 'text/markdown': '/connect.md' } },
  openGraph: {
    type: 'article',
    url: '/connect',
    title: CONNECT_TITLE,
    description: CONNECT_DESCRIPTION,
  },
};

const faqPage = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: CONNECT_FAQS.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
};

export default function ConnectPage() {
  return (
    <>
      <JsonLd data={faqPage} />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Connect', href: '/connect' }]} />
          <span className="label">Connect your agent</span>
          <h1 className="display">Keep your agent. Add the editing.</h1>
          <p className="lede wt-answer">
            {CONNECT_LEAD}{' '}
            <em>One address works in every app below, and your app opens the sign-in for you.</em>
          </p>
          <LiveCard />
          <div className="cl-address">
            <span className="label">The address</span>
            <div className="code-line">
              <code>{MCP_URL}</code>
              <Copy text={MCP_URL} label="Copy" />
            </div>
          </div>
          <p className="wt-byline">
            Steps checked <time dateTime={CLIENTS_CHECKED}>{formatDate(CLIENTS_CHECKED)}</time>{' '}
            against each app’s own help pages
          </p>
        </section>

        <section className="cell" aria-label="Pick your app">
          <div className="head">
            <span className="label">00 / Your app</span>
            <h2 className="lede">Which one do you use?</h2>
          </div>
          <ul className="cl-index">
            {CLIENTS.map((c) => (
              <li key={c.slug}>
                <a href={`#${c.slug}`}>
                  <LogoSlot client={c} />
                  <span className="cl-where">{c.where}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="cell" id="how">
          <div className="head">
            <span className="label">How it works</span>
            <h2 className="display">Your agent edits. You watch.</h2>
          </div>
          <ol className="ledger">
            {HOW.map((h, i) => (
              <li key={h.title}>
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <h3>{h.title}</h3>
                <p>{h.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {CLIENTS.map((c, i) => (
          <ClientSection key={c.slug} client={c} n={i + 1} />
        ))}

        <section className="cell" id="questions">
          <div className="head">
            <span className="label">Questions</span>
            <h2 className="display">Asked.</h2>
          </div>
          <div className="faq">
            {CONNECT_FAQS.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="cell wt-end">
          <p className="wt-links">
            <a href={SIGN_UP}>Start free for 3 days</a> · <a href="/self-host">Run it yourself</a> ·{' '}
            <a href="/demos">Watch it edit</a> · <a href="/skills">Skills</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
