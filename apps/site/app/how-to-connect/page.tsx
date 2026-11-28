import type { Metadata } from 'next';
import {
  BUILDER_FAQS,
  BUILDER_GUIDES,
  BUILDER_WAYS,
  CREATOR_WAYS,
  WAYS_DESCRIPTION,
  WAYS_TITLE,
} from '../../content/ways.ts';
import { Breadcrumbs, Footer, JsonLd, Nav, SIGN_UP } from '../shell.tsx';
import { WayCard } from './card.tsx';
import { WaysGraphic } from './graphic.tsx';

// Who is connecting decides how: people who make videos use an AI app they already have and sign
// in once; engineers call the same tools over REST with an API key, from their app's backend or
// from code an LLM runs in a sandbox. The cards and the engineers' questions come from
// content/ways.ts, which the Markdown twin (/how-to-connect.md) reads too.

export const metadata: Metadata = {
  title: `${WAYS_TITLE} | cuttingfloor`,
  description: WAYS_DESCRIPTION,
  alternates: { canonical: '/how-to-connect', types: { 'text/markdown': '/how-to-connect.md' } },
  openGraph: {
    type: 'article',
    url: '/how-to-connect',
    title: WAYS_TITLE,
    description: WAYS_DESCRIPTION,
  },
};

const faqPage = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: BUILDER_FAQS.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
};

export default function HowToConnectPage() {
  return (
    <>
      <JsonLd data={faqPage} />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'How to connect', href: '/how-to-connect' }]} />
          <span className="label">How to connect</span>
          <h1 className="display hc-h1">Three ways in. One editor.</h1>
          <p className="lede wt-answer">
            Make videos in the AI app you already use, or build on the API: from your app’s backend,
            or from code an LLM runs.{' '}
            <em>Pick the one that fits you; they all edit the same way.</em>
          </p>
          <p className="hc-jump">
            <a href="#creators">I make videos</a>
            <a href="#builders">I build with code</a>
          </p>
          <WaysGraphic />
        </section>

        <section className="cell" id="creators">
          <div className="head">
            <span className="label">Creators, students, marketers</span>
            <div>
              <h2 className="display">I make videos.</h2>
              <p className="lede hc-sublede">
                Use the AI app you already have. You sign in once: no keys, no code.
              </p>
            </div>
          </div>
          <ul className="hc-grid hc-grid-five">
            {CREATOR_WAYS.map((w) => (
              <WayCard key={w.id} way={w} />
            ))}
          </ul>
        </section>

        <section className="cell hc-builders" id="builders">
          <div className="head">
            <span className="label">Engineers and builders</span>
            <div>
              <span className="hc-tag hc-tag-key">Recommended for engineers and builders</span>
              <h2 className="display">I build with code.</h2>
              <p className="lede hc-sublede">
                One REST API, two ways to call it: from your app’s backend like any web service, or
                from code an LLM runs in a sandbox. Either way it takes an API key from your account
                page, acts as your account and uses its credits.
              </p>
            </div>
          </div>
          <ul className="hc-grid hc-grid-two">
            {BUILDER_WAYS.map((w) => (
              <WayCard key={w.id} way={w} />
            ))}
          </ul>
          <p className="wt-links">
            Guides:{' '}
            {BUILDER_GUIDES.map((l, i) => (
              <span key={l.href}>
                {i > 0 && ' · '}
                <a href={l.href}>{l.label}</a>
              </span>
            ))}
          </p>
        </section>

        <section className="cell" id="developer-questions">
          <div className="head">
            <span className="label">Engineers ask</span>
            <h2 className="display">Questions.</h2>
          </div>
          <div className="faq">
            {BUILDER_FAQS.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="cell wt-end">
          <p className="wt-links">
            <a href={SIGN_UP}>Start free</a> · <a href="/account#api-keys">Your API keys</a> ·{' '}
            <a href="/connect">Setup for every app</a> · <a href="/self-host">Run it yourself</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
