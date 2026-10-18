import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WALKTHROUGHS, type Walkthrough, walkthrough } from '../../../content/walkthroughs.ts';
import { SITE_URL } from '../../seo.ts';
import { Session } from '../../session/session.tsx';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav } from '../../shell.tsx';
import { Copy } from '../copy.tsx';

// One template for every walkthrough. Nothing here knows which one it is showing.

export const dynamicParams = false;

export function generateStaticParams() {
  return WALKTHROUGHS.map((w) => ({ slug: w.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const w = walkthrough((await params).slug);
  if (!w) return {};
  const path = `/walkthroughs/${w.slug}`;
  return {
    title: w.metaTitle,
    description: w.metaDescription,
    alternates: { canonical: path },
    openGraph: { type: 'article', url: path, title: w.metaTitle, description: w.metaDescription },
  };
}

export default async function WalkthroughPage({ params }: Props) {
  const w = walkthrough((await params).slug);
  if (!w) notFound();
  const n = String(WALKTHROUGHS.indexOf(w) + 1).padStart(2, '0');
  const calls = w.session.steps.filter((s) => s.kind === 'call');

  return (
    <>
      <JsonLd data={article(w)} />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs
            trail={[
              { name: 'Walkthroughs', href: '/walkthroughs' },
              { name: w.title, href: `/walkthroughs/${w.slug}` },
            ]}
          />
          <span className="label">Walkthrough {n}</span>
          <h1 className="display">{w.title}</h1>
          <p className="lede wt-answer">{w.answer}</p>
          <p className="wt-byline">
            Updated <time dateTime={w.updated}>{formatDate(w.updated)}</time> · Ken Wiltshire
          </p>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">01 / The prompt</span>
            <h2 className="lede">What did they ask for?</h2>
          </div>
          <figure className="wt-prompt">
            <pre>{w.prompt}</pre>
            <figcaption>
              <span className="label">Typed into the agent, word for word</span>
              <Copy text={w.prompt} />
            </figcaption>
          </figure>
        </section>

        <section className="cell" id="session">
          <div className="head">
            <span className="label">02 / The session</span>
            <h2 className="lede">What did the agent do?</h2>
          </div>
          <Session
            id="session"
            data={w.session}
            families
            note={`${calls.length} tool calls to the cuttingfloor MCP server. Each call returns a new timeline, so the agent can look, and step back.`}
          />
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">03 / Every call</span>
            <h2 className="lede">Which tool calls did it make?</h2>
          </div>
          <ol className="wt-calls">
            {calls.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the script is fixed; order is identity
              <li key={i}>
                <code className="wt-fn" data-family={c.fn.split('.')[0]}>
                  {c.fn}
                </code>
                <code className="wt-args">{c.full ?? c.args}</code>
                <span className="wt-ret">
                  <span aria-hidden="true">← </span>
                  {c.ret}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">04 / The result</span>
            <h2 className="lede">What does the timeline look like after?</h2>
          </div>
          <Result w={w} />
        </section>

        <section className="cell paper">
          <div className="wt-prose">
            {w.sections.map((s) => (
              <section key={s.heading}>
                <h2>{s.heading}</h2>
                {s.body.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </section>
            ))}
          </div>
        </section>

        <section className="cell wt-end">
          <div className="head">
            <span className="label">05 / The file</span>
            <h2 className="lede">What came out?</h2>
          </div>
          <dl className="wt-file">
            <div className="wt-file-name">
              <dt>File</dt>
              <dd>{w.file.name}</dd>
            </div>
            <div>
              <dt>Format</dt>
              <dd>
                {w.file.container}, {w.file.codec}
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{w.file.duration}</dd>
            </div>
            <div>
              <dt>Resolution</dt>
              <dd>{w.file.resolution}</dd>
            </div>
          </dl>
          <p className="wt-links">
            Footage in, editing out. <a href="/walkthroughs">More walkthroughs</a> ·{' '}
            <a href="/how-it-works">How it works</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}

/** The finished timeline, drawn from the data. */
function Result({ w }: { w: Walkthrough }) {
  const { length, tracks, legend, stats } = w.result;
  const pct = (s: number) => `${(s / length) * 100}%`;
  const step = length > 900 ? 300 : length > 120 ? 30 : 5;
  const ticks = Array.from({ length: Math.floor(length / step) + 1 }, (_, i) => i * step);
  return (
    <figure className="wt-result">
      <div
        className="wt-tl"
        role="img"
        aria-label={`The finished timeline: ${stats.map((s) => `${s.label} ${s.value}`).join(', ')}`}
      >
        <div className="wt-ruler">
          {ticks.map((t) => (
            <span key={t} style={{ left: pct(t) }}>
              {clock(t)}
            </span>
          ))}
        </div>
        {tracks.map((t) => (
          <div key={t.name} className="wt-lane">
            <span className="wt-lane-name">{t.name}</span>
            <div className={`wt-lane-body ${t.name}`}>
              {t.segments.map((g) => (
                <i
                  key={g.from}
                  className={g.tone}
                  style={{ left: pct(g.from), width: `calc(${pct(g.to - g.from)} - 2px)` }}
                />
              ))}
              {t.marks?.map((m) => (
                <b key={m} style={{ left: pct(m) }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <figcaption>
        <ul className="wt-legend">
          {legend.map((l) => (
            <li key={l.text}>
              <span className={`sw ${l.swatch}`} aria-hidden="true" />
              {l.text}
            </li>
          ))}
        </ul>
        <dl className="wt-stats">
          {stats.map((s) => (
            <div key={s.label}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      </figcaption>
    </figure>
  );
}

function clock(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

function article(w: Walkthrough) {
  const url = `${SITE_URL}/walkthroughs/${w.slug}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: w.metaTitle.replace(/ \| cuttingfloor$/, ''),
    description: w.metaDescription,
    url,
    mainEntityOfPage: url,
    datePublished: w.updated,
    dateModified: w.updated,
    author: { '@type': 'Person', name: 'Ken Wiltshire' },
    publisher: { '@type': 'Organization', name: 'cuttingfloor', url: SITE_URL },
  };
}
