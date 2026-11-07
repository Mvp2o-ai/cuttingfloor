import { FREE_CREDITS } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { LICENCE } from '../content/facts.ts';
import { HOME_SESSION } from '../content/home-session.ts';
import { EDITING_PAINS, type Pain } from '../content/pains.ts';
import { DESKTOP_TOOLS, TOOLKIT_HEADLINE, TOOLKIT_LEDE, TOOLKIT_LINE } from '../content/toolkit.ts';
import { ConnectNow } from './connect-now.tsx';
import { TryKazi } from './kazi.tsx';
import { LiveCard } from './live-card.tsx';
import { PLANS } from './pricing.ts';
import { Prompts } from './prompts.tsx';
import { FAQS, structuredData } from './seo.ts';
import { Session } from './session/session.tsx';
import { Check, Footer, JsonLd, Nav, SIGN_UP } from './shell.tsx';

// The cheapest paid plan, for the pricing line.
const FROM_PRICE = `$${Math.min(...PLANS.flatMap((p) => (p.amount ? [p.amount] : [])))}`;

// The home page's Markdown version is /index.md; layout.tsx has the rest of its metadata.
export const metadata: Metadata = {
  alternates: { canonical: '/', types: { 'text/markdown': '/index.md' } },
};

// Linking here plays the session from the top.
const SESSION_ID = 'session';

// The agents it already works in. Kazi is ours, so it leads, in the accent.
const CLIENTS = [
  'Kazi',
  'Claude',
  'Claude Cowork',
  'Claude Code',
  'ChatGPT',
  'ChatGPT Work',
  'Codex',
  'Cursor',
] as const;

function PainTable({ caption, rows }: { caption: string; rows: Pain[] }) {
  return (
    <table className="compare-table">
      <caption className="label">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">The problem</th>
          <th scope="col">What your agent does with cuttingfloor</th>
          <th scope="col">Tools</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.pain}>
            <th scope="row" className="tier">
              {r.pain}
            </th>
            <td>{r.answer}</td>
            <td className="note">
              {r.tools.length ? r.tools.map((t) => <code key={t}>{t} </code>) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Home() {
  return (
    <>
      <JsonLd data={structuredData()} />
      <Nav />

      <main className="frame">
        <section className="cell hero marks">
          <span className="mark-b" />
          <h1 className="leader rise">
            <b>cuttingfloor</b>
            <span className="dots" />
            <span>the video editing MCP for creators</span>
          </h1>
          <p className="display title rise d1">
            Video editing,
            <br />
            solved.
            <Check />
          </p>
          <div className="rise d2">
            <ConnectNow />
          </div>
          <div className="hero-row">
            <div className="rise d2">
              <p className="lede">
                One MCP connection.{' '}
                <em>
                  Your AI assistant cuts, captions and mixes — then hands back a file a human editor
                  can finish.
                </em>
              </p>
              <div className="works-in">
                <span className="label">An MCP server for</span>
                <ul>
                  {CLIENTS.map((c) => (
                    <li key={c} className={c === 'Kazi' ? 'ours kazi-word' : undefined}>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="actions">
                <a className="link-big" href={SIGN_UP}>
                  Start free — {FREE_CREDITS} credits
                </a>
                <a className="link-big quiet" href="/demos">
                  Watch it edit
                </a>
              </div>
              <p>
                Open source ({LICENCE}): <a href="/self-host">run it yourself, free</a>.
              </p>
            </div>
            <div className="rise d3 hero-live">
              <LiveCard />
            </div>
          </div>
        </section>

        <section className="cell floor" aria-label="An agent editing over MCP">
          <video src="/floor.mp4" poster="/floor.jpg" muted loop playsInline autoPlay />
          <div className="floor-cap">
            <span className="label">01 / The floor</span>
            <span className="label">
              AI video editing: your agent, one MCP server, every edit a call
            </span>
          </div>
        </section>

        <section className="cell" id="toolkit" aria-label="The toolkit">
          <div className="head">
            <span className="label">02 / The toolkit</span>
            <div>
              <h2 className="display">{TOOLKIT_HEADLINE}</h2>
              <p className="compare-lede">
                {TOOLKIT_LEDE} <strong>{TOOLKIT_LINE}</strong>
              </p>
            </div>
          </div>
          <table className="compare-table toolkit-table">
            <caption className="label">In a desktop editor, and the tools your agent calls</caption>
            <thead>
              <tr>
                <th scope="col">What you’d reach for</th>
                <th scope="col">Tools</th>
              </tr>
            </thead>
            <tbody>
              {DESKTOP_TOOLS.map((r) => (
                <tr key={r.does}>
                  <th scope="row" className="tier">
                    {r.does}
                  </th>
                  <td>
                    {r.tools.map((t) => (
                      <code key={t}>{t} </code>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <figure className="reel toolkit-reel">
            <div>
              <video src="/reel.mp4" poster="/reel.jpg" muted loop playsInline autoPlay />
              <figcaption className="label">
                <span>infinite agentic memory</span>
                <span className="tc">00:00:13:00</span>
              </figcaption>
            </div>
            <div>
              <p>
                Made here: a 24-minute explainer, every slide drawn with create.motion, every cut
                placed by an agent. This is thirteen seconds of it.
              </p>
              <p className="wt-links">
                <a href="/features">Every tool</a> ·{' '}
                <a href="/compare">How the other video MCPs compare</a>
              </p>
            </div>
          </figure>
        </section>

        <section className="cell" id={SESSION_ID} aria-label="A session">
          <div className="head">
            <span className="label">03 / A session</span>
            <h2 className="lede">
              AI video editing, one tool call at a time. <em>Here is one.</em>
            </h2>
          </div>
          <Session
            id={SESSION_ID}
            data={HOME_SESSION}
            note="Every edit is a tool call. Every call returns a timeline and a picture of it, so the agent sees what it made before it ships."
          />
        </section>

        <section className="cell" id="problems" aria-label="Problems it solves">
          <div className="head">
            <span className="label">04 / Solved</span>
            <div>
              <h2 className="display">The jobs that eat your week.</h2>
              <p className="compare-lede">
                The editing creators hate most, and the places AI editors still fall down, each with
                what your agent does about it here.
              </p>
            </div>
          </div>
          <PainTable caption="Five of the slowest editing jobs" rows={EDITING_PAINS.slice(0, 5)} />
          <p className="wt-links">
            <a href="/features">Everything it can do</a> ·{' '}
            <a href="/compare">Where other AI editors go wrong</a>
          </p>
        </section>

        <section className="cell" aria-label="Things to ask for">
          <div className="head">
            <span className="label">05 / Ask for</span>
            <div>
              <h2 className="display">Say it like you’d say it to an editor.</h2>
              <p className="compare-lede">
                No prompt craft, no timeline. Rescue a take, cut it down, or make what you don’t
                have.
              </p>
            </div>
          </div>
          <Prompts />
        </section>

        <section className="cell" id="pricing">
          <div className="head">
            <span className="label">06 / Pricing</span>
            <div>
              <h2 className="display">Every tool on every plan. Start free.</h2>
              <p className="compare-lede">
                {FREE_CREDITS} free credits, no card, no time limit. Then plans from {FROM_PRICE} a
                month. Run it yourself and it is all free.
              </p>
            </div>
          </div>
          <p className="wt-links">
            <a href="/pricing">See the plans</a> · <a href="/self-host">Run it yourself</a>
          </p>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">07 / Questions</span>
            <h2 className="display">Asked.</h2>
          </div>
          <div className="faq">
            {FAQS.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <Footer />
      </main>
    </>
  );
}
