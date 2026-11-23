import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FIXES, FIXES_UPDATED, fix, fixLead, fixPath } from '../../../content/fixes.ts';
import { AgentBlock } from '../../agents/block.tsx';
import { LiveCard } from '../../live-card.tsx';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav, SIGN_UP } from '../../shell.tsx';
import { ToolCalls } from '../../tool-calls.tsx';
import { Copy } from '../../walkthroughs/copy.tsx';

// One page per searched question, /fixes/<id>: the question as the H1 and the answer right under
// it, because answer engines cite the page titled with the exact question, not a list. Nothing
// here knows which fix it is showing; the words come from content/fixes.ts.

export const dynamicParams = false;

export function generateStaticParams() {
  return FIXES.map((f) => ({ slug: f.id }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const f = fix((await params).slug);
  if (!f) return {};
  const path = fixPath(f);
  const title = `${f.problem} | cuttingfloor`;
  return {
    title,
    description: f.answer,
    alternates: { canonical: path, types: { 'text/markdown': `${path}.md` } },
    openGraph: { type: 'article', url: path, title, description: f.answer },
  };
}

export default async function FixPage({ params }: Props) {
  const f = fix((await params).slug);
  if (!f) notFound();
  const path = fixPath(f);
  const related = f.related.flatMap((id) => FIXES.filter((r) => r.id === id));
  // Sections are numbered in order; the tool calls section shows only when the fix lists them.
  const at = (k: number) => String(k + (f.tools ? 1 : 0)).padStart(2, '0');
  return (
    <>
      {/* One question, answered by us: FAQPage, as on the guides. QAPage is for questions users
          ask and answer, with several answers. */}
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [
            {
              '@type': 'Question',
              name: f.problem,
              acceptedAnswer: { '@type': 'Answer', text: f.answer },
            },
          ],
        }}
      />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs
            trail={[
              { name: 'Fixes', href: '/fixes' },
              { name: f.problem, href: path },
            ]}
          />
          <span className="label">Fix</span>
          <h1 className="display">{f.problem}</h1>
          <p className="lede wt-answer">{f.answer}</p>
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
            <span className="label">01 / Say</span>
            <h2 className="lede">What to type.</h2>
          </div>
          <div className="fix-body">
            <figure className="wt-prompt">
              <pre>{f.prompt}</pre>
              <figcaption>
                <span className="label">Paste it into your agent, or say it your way</span>
                <Copy text={f.prompt} label="Copy prompt" />
              </figcaption>
            </figure>
            {f.see && (
              <p>
                See it: <a href={f.see.href}>{f.see.label}</a>
              </p>
            )}
            {f.watch && (
              <p>
                Watch it done: <a href={f.watch.href}>{f.watch.label}</a>
              </p>
            )}
          </div>
        </section>

        {f.tools && <ToolCalls tools={f.tools} lang="en" n="02" />}

        <AgentBlock lang="en" n={at(2)} />

        <section className="cell">
          <div className="head">
            <span className="label">{at(3)} / More fixes</span>
            <h2 className="display">People also ask.</h2>
          </div>
          <ol className="ledger">
            {related.map((r) => (
              <li key={r.id}>
                <span className="n">→</span>
                <h3>
                  <a href={fixPath(r)}>{r.problem}</a>
                </h3>
                <p>{fixLead(r)}</p>
              </li>
            ))}
          </ol>
          <p className="wt-links">
            <a href="/fixes">Every fix</a> · <a href="/demos">All demos</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
