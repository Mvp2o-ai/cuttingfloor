import type { Metadata } from 'next';
import { FIXES, FIXES_UPDATED, fixLead, fixPath } from '../../content/fixes.ts';
import { AgentBlock } from '../agents/block.tsx';
import { LiveCard } from '../live-card.tsx';
import { SITE_URL } from '../seo.ts';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav, SIGN_UP } from '../shell.tsx';

// The index of the editing problems people search for most: each question links to its own page,
// /fixes/<id>, with the answer's opening under it. The answers are marked up once, on their own
// pages, so this one lists them. Each entry keeps the id old /fixes#<id> links point at.

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
          '@type': 'ItemList',
          name: TITLE,
          itemListElement: FIXES.map((f, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: f.problem,
            url: new URL(fixPath(f), SITE_URL).toString(),
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
            video and say what is wrong. Here are the problems people search for most; each has its
            own page with what the agent does about it and what to type.
          </p>
          <LiveCard />
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
                <h3>
                  <a href={fixPath(f)}>{f.problem}</a>
                </h3>
                <p>{fixLead(f)}</p>
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
