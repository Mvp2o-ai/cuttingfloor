import { FREE_CREDITS, FREE_FOOTAGE_MINUTES } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import {
  BUILDER_WAYS,
  CREATOR_WAYS,
  WAYS_DESCRIPTION,
  WAYS_TITLE,
  type Way,
} from '../../content/ways.ts';
import { Breadcrumbs, Footer, Nav, SIGN_UP } from '../shell.tsx';
import { Copy } from '../walkthroughs/copy.tsx';
import { WaysGraphic } from './graphic.tsx';
import { WayIconMark } from './icons.tsx';

// Who is connecting decides how: people who make videos use an AI app they already have and sign
// in once; engineers call the same tools from code with an API key, over REST or MCP. The cards
// come from content/ways.ts, which the Markdown twin (/how-to-connect.md) reads too.

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

function WayCard({ way }: { way: Way }) {
  return (
    <li className="hc-card" id={way.id}>
      <div className="hc-card-top">
        <WayIconMark icon={way.icon} />
        <h3>{way.name}</h3>
        {way.tag ? <span className="hc-tag">{way.tag}</span> : null}
      </div>
      <p>{way.text}</p>
      {way.snippet ? (
        <figure className="wt-prompt hc-snippet">
          <pre>
            <code>{way.snippet.code}</code>
          </pre>
          <figcaption>
            <span className="label">{way.snippet.label}</span>
            <Copy text={way.snippet.code} label="Copy" />
          </figcaption>
        </figure>
      ) : null}
      <p className="hc-links">
        {way.links.map((l, i) => (
          <a
            key={l.href}
            href={l.href}
            className={i === 0 ? 'hc-go' : undefined}
            data-track={l.track}
            {...(l.href.startsWith('http') ? { rel: 'noopener' } : {})}
          >
            {l.label}
          </a>
        ))}
      </p>
    </li>
  );
}

export default function HowToConnectPage() {
  return (
    <>
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'How to connect', href: '/how-to-connect' }]} />
          <span className="label">How to connect</span>
          <h1 className="display hc-h1">Three ways in. One editor.</h1>
          <p className="lede wt-answer">
            Make videos in the AI app you already use, or call every editing tool from your own
            code. <em>Pick the one that fits you; they all edit the same way.</em>
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
                One API key from your account page, two ways to use it. It acts as your account and
                uses its credits.
              </p>
            </div>
          </div>
          <ul className="hc-grid hc-grid-two">
            {BUILDER_WAYS.map((w) => (
              <WayCard key={w.id} way={w} />
            ))}
          </ul>
        </section>

        <section className="cell wt-end">
          <p className="wt-links">
            <a href={SIGN_UP}>Start free: {FREE_FOOTAGE_MINUTES} minutes of footage</a> ·{' '}
            <a href="/account#api-keys">Your API keys</a> ·{' '}
            <a href="/connect">Setup for every app</a> · <a href="/self-host">Run it yourself</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
