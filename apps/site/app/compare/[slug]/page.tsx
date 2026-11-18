import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { demo } from '../../../content/demos.ts';
import { VERSUS } from '../../../content/versus.ts';
import { Breadcrumbs, Footer, JsonLd, Nav, SIGN_UP } from '../../shell.tsx';

// One template for every versus page. The words come from the versus entry.

export const dynamicParams = false;

export function generateStaticParams() {
  return VERSUS.map((v) => ({ slug: v.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const v = VERSUS.find((x) => x.slug === slug);
  if (!v) return {};
  const path = `/compare/${v.slug}`;
  return {
    title: v.metaTitle,
    description: v.metaDescription,
    alternates: { canonical: path, types: { 'text/markdown': `${path}.md` } },
    openGraph: { type: 'article', url: path, title: v.metaTitle, description: v.metaDescription },
  };
}

export default async function VersusPage({ params }: Props) {
  const { slug } = await params;
  const v = VERSUS.find((x) => x.slug === slug);
  if (!v) notFound();
  const path = `/compare/${v.slug}`;
  const demos = v.demos.flatMap((slug) => {
    const d = demo(slug);
    return d ? [d] : [];
  });
  const others = VERSUS.filter((o) => o.slug !== v.slug);

  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: v.faqs.map((f) => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: { '@type': 'Answer', text: f.a },
          })),
        }}
      />
      <Nav />
      <main className="frame wt cmp-tight">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs
            trail={[
              { name: 'Compare', href: '/compare' },
              { name: v.title, href: path },
            ]}
          />
          <h1 className="display">{v.title}</h1>
          <p className="lede wt-answer">{v.answer}</p>
          <div className="actions">
            <a className="link-big" href={SIGN_UP}>
              Start free
            </a>
            <a className="link-big quiet" href={demos[0] ? `/demos/${demos[0].slug}` : '/demos'}>
              Watch it edit
            </a>
          </div>
        </section>

        <section className="cell">
          <div className="cmp-kinds">
            {v.sides.map((s) => (
              <div key={s.name} className={s.name === 'cuttingfloor' ? 'ours' : undefined}>
                <h3>{s.name}</h3>
                <p>{s.is}</p>
                <p>
                  <span className="label">Where it wins</span>
                  <br />
                  {s.wins}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="cell">
          <h2 className="display">The deciding line</h2>
          <p className="lede">
            <em>{v.deciding}</em>
          </p>
          <h2>Pick {v.sides[0].name} if</h2>
          <p>{v.pick[0]}</p>
          <h2>Pick {v.sides[1].name} if</h2>
          <p>{v.pick[1]}</p>
        </section>

        <section className="cell">
          <h2 className="display">Watch it do this</h2>
          <ul>
            {demos.map((d) => (
              <li key={d.slug}>
                <a href={`/demos/${d.slug}`}>{d.title}</a>
              </li>
            ))}
          </ul>
        </section>

        <section className="cell">
          {v.kind === 'neutral' ? (
            <p>
              Neither runs inside your agent. <a href="/start">cuttingfloor</a> does.
            </p>
          ) : null}
          <div className="faq">
            {v.faqs.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="cell wt-end">
          <h2>Related comparisons</h2>
          <ul>
            <li>
              <a href="/compare">Compare</a>
            </li>
            {others.map((o) => (
              <li key={o.slug}>
                <a href={`/compare/${o.slug}`}>{o.title}</a>
              </li>
            ))}
          </ul>
          <p>
            <time dateTime={v.updated}>{v.updated}</time>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
