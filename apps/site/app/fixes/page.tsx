import type { Metadata } from 'next';
import { FIXES, FIXES_UPDATED } from '../../content/fixes.ts';
import { AgentBlock } from '../agents/block.tsx';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav, SIGN_UP } from '../shell.tsx';
import { Copy } from '../walkthroughs/copy.tsx';

// The editing problems people search for most, each with the fix and what to say to your agent.
// The words come from content/fixes.ts; the page only lays them out.

const TITLE = 'Common video editing problems, and how to fix them with AI';
const DESCRIPTION =
  'Compress, trim, blur a logo, jump cuts, stabilize, music, background noise, captions, sync and more: what your AI agent does about each, and what to type.';

export const metadata: Metadata = {
  title: `${TITLE} — cuttingfloor`,
  description: DESCRIPTION,
  alternates: { canonical: '/fixes', types: { 'text/markdown': '/fixes.md' } },
  openGraph: { type: 'article', url: '/fixes', title: TITLE, description: DESCRIPTION },
};

export default function Fixes() {
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: FIXES.map((f) => ({
            '@type': 'Question',
            name: f.problem,
            acceptedAnswer: { '@type': 'Answer', text: f.answer },
          })),
        }}
      />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Fixes', href: '/fixes' }]} />
          <span className="label">Fixes</span>
          <h1 className="display">{TITLE}</h1>
          <p className="lede wt-answer">
            Connect cuttingfloor to the AI you already use (ChatGPT, Claude or Kazi), give it the
            video and say what is wrong. Here are the problems people search for most, what the
            agent does about each, and what to type.
          </p>
          <p className="wt-byline">
            Updated <time dateTime={FIXES_UPDATED}>{formatDate(FIXES_UPDATED, 'en')}</time> · Ken
            Wiltshire
          </p>
          <div className="actions">
            <a className="link-big" href={SIGN_UP}>
              Start free
            </a>
            <a className="link-big quiet" href="/demos">
              Watch it edit
            </a>
          </div>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">01 / Fixes</span>
            <h2 className="display">What people search for most.</h2>
          </div>
          <ol className="ledger">
            {FIXES.map((f, i) => (
              <li key={f.id} id={f.id}>
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <h3>{f.problem}</h3>
                <div className="fix-body">
                  <p>{f.answer}</p>
                  <figure className="wt-prompt">
                    <pre>{f.prompt}</pre>
                    <figcaption>
                      <span className="label">Say it to your agent</span>
                      <Copy text={f.prompt} label="Copy prompt" />
                    </figcaption>
                  </figure>
                  {f.see && (
                    <p>
                      See it: <a href={f.see.href}>{f.see.label}</a>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <AgentBlock lang="en" n="02" />
        <Footer />
      </main>
    </>
  );
}
