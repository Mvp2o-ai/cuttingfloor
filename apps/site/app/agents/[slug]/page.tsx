import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  AGENTS,
  AGENTS_UPDATED,
  agent,
  agentClients,
  agentDemos,
} from '../../../content/agents.ts';
import { ClientSection } from '../../connect/client-section.tsx';
import { DemoCards } from '../../demos/cards.tsx';
import { LiveCard } from '../../live-card.tsx';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav, SIGN_UP } from '../../shell.tsx';
import { Copy } from '../../walkthroughs/copy.tsx';

// One template for every agent page. Nothing here knows which agent it is showing.

export const dynamicParams = false;

export function generateStaticParams() {
  return AGENTS.map((a) => ({ slug: a.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const a = agent((await params).slug);
  if (!a) return {};
  const path = `/agents/${a.slug}`;
  return {
    title: a.metaTitle,
    description: a.metaDescription,
    alternates: { canonical: path, types: { 'text/markdown': `${path}.md` } },
    openGraph: { type: 'article', url: path, title: a.metaTitle, description: a.metaDescription },
  };
}

export default async function AgentPage({ params }: Props) {
  const a = agent((await params).slug);
  if (!a) notFound();
  const clients = agentClients(a);
  const demos = agentDemos(a);
  const others = AGENTS.filter((o) => o !== a);

  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: a.faqs.map((f) => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: { '@type': 'Answer', text: f.a },
          })),
        }}
      />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs
            trail={[
              { name: 'Agents', href: '/agents' },
              { name: a.name, href: `/agents/${a.slug}` },
            ]}
          />
          <span className="label">Edit with {a.name}</span>
          <h1 className="display">{a.title}</h1>
          <p className="lede wt-answer">{a.answer}</p>
          <LiveCard />
          <p className="wt-byline">
            Updated <time dateTime={AGENTS_UPDATED}>{formatDate(AGENTS_UPDATED)}</time> · Ken
            Wiltshire
          </p>
          <div className="actions">
            <a className="link-big" href={SIGN_UP}>
              Start free
            </a>
            <a className="link-big quiet" href="#connect">
              Connect {a.name}
            </a>
          </div>
        </section>

        <div id="connect">
          {clients.map((c, i) => (
            <ClientSection key={c.slug} client={c} n={i + 1} />
          ))}
        </div>

        <section className="cell">
          <div className="head">
            <span className="label">Ask</span>
            <h2 className="lede">Then say what you want.</h2>
          </div>
          <figure className="wt-prompt">
            <pre>{a.prompt}</pre>
            <figcaption>
              <span className="label">Try it in {a.name}, word for word</span>
              <Copy text={a.prompt} />
            </figcaption>
          </figure>
        </section>

        {demos.length > 0 && (
          <section className="cell">
            <div className="head">
              <span className="label">Watch</span>
              <h2 className="display">Edited in {a.name}.</h2>
            </div>
            <DemoCards demos={demos} />
          </section>
        )}

        <section className="cell">
          <div className="head">
            <span className="label">Questions</span>
            <h2 className="display">Asked.</h2>
          </div>
          <div className="faq">
            {a.faqs.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="cell wt-end">
          <p className="wt-links">
            {others.map((o) => (
              <span key={o.slug}>
                <a href={`/agents/${o.slug}`}>Edit with {o.name}</a> ·{' '}
              </span>
            ))}
            <a href="/connect">Every other app</a> · <a href="/demos">All demos</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
