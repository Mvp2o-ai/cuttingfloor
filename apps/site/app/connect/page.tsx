import { FREE_CREDITS, FREE_FOOTAGE_MINUTES } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import {
  ALLOW_ACCESS_TEXT,
  ALLOW_ACCESS_TITLE,
  CLIENTS,
  CLIENTS_CHECKED,
} from '../../content/clients.ts';
import { ConnectNow } from '../connect-now.tsx';
import { LiveCard } from '../live-card.tsx';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav, SIGN_UP } from '../shell.tsx';
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
          <ConnectNow steps="#apps" />
          <p className="lede wt-answer">
            {CONNECT_LEAD}{' '}
            <em>One address works in every app below, and your app opens the sign-in for you.</em>
          </p>
          <p className="hc-jump">
            <a href="/how-to-connect" data-track="Connect: ways to connect">
              Three ways in: apps, REST, MCP
            </a>
          </p>
          <LiveCard />
          <p className="wt-byline">
            Steps checked <time dateTime={CLIENTS_CHECKED}>{formatDate(CLIENTS_CHECKED)}</time>{' '}
            against each app’s own help pages
          </p>
        </section>

        <section className="cell" id="apps" aria-label="Pick your app">
          <div className="head">
            <span className="label">00 / Your app</span>
            <h2 className="lede">Which one do you use?</h2>
          </div>
          <ul className="cl-index">
            {CLIENTS.map((c) => (
              <li key={c.slug}>
                <a href={`#${c.slug}`} data-track={`Connect app: ${c.name}`}>
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

        <section className="cell" id="allow-access">
          <div className="head">
            <span className="label">Signing in</span>
            <h2 className="display">{ALLOW_ACCESS_TITLE}</h2>
          </div>
          <div className="cl-body">
            <div>
              {ALLOW_ACCESS_TEXT.map((t) => (
                <p key={t}>{t}</p>
              ))}
            </div>
          </div>
        </section>

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
            <a href={SIGN_UP}>Start free: {FREE_FOOTAGE_MINUTES} minutes of footage</a> ·{' '}
            <a href="/self-host">Run it yourself</a> · <a href="/demos">Watch it edit</a> ·{' '}
            <a href="/skills">Skills</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
