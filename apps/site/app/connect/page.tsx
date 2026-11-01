import type { Metadata } from 'next';
import { CLIENTS, CLIENTS_CHECKED, type Client, MCP_URL } from '../../content/clients.ts';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav, SIGN_UP } from '../shell.tsx';
import { Copy } from '../walkthroughs/copy.tsx';
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

function ClientSection({ client: c, n }: { client: Client; n: number }) {
  return (
    <section className="cell cl-client" id={c.slug} aria-labelledby={`${c.slug}-name`}>
      <div className="head">
        <span className="label">
          {String(n).padStart(2, '0')} / {c.where}
        </span>
        <h2 id={`${c.slug}-name`} className="cl-name">
          <LogoSlot client={c} />
          <span className="sr-only">: how to connect cuttingfloor</span>
        </h2>
      </div>
      <div className="cl-body">
        <div>
          <ol className="cl-steps">
            {c.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {c.install && (
            <p className="actions">
              <a className="link-big" href={c.install.href} data-track={`Install: ${c.name}`}>
                {c.install.label}
              </a>
            </p>
          )}
          {c.notes && (
            <ul className="cl-notes">
              {c.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          {c.docs && (
            <p className="wt-links">
              <a href={c.docs} rel="noopener">
                {c.docsLabel ?? `${c.name}’s own help page`}
              </a>
            </p>
          )}
        </div>
        <div className="cl-snippets">
          {c.snippets.map((s) => (
            <figure key={s.label} className="wt-prompt">
              <pre>
                <code>{s.code}</code>
              </pre>
              <figcaption>
                <span className="label">{s.label}</span>
                <Copy text={s.code} label="Copy" />
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
