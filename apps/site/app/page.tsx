import { FREE_CREDITS } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { DEMOS } from '../content/demos.ts';
import { LICENCE } from '../content/facts.ts';
import { HOME_SESSION } from '../content/home-session.ts';
import { EDITING_PAINS, type Pain } from '../content/pains.ts';
import { TOOL_COUNT } from '../content/tools.ts';
import { Capabilities } from './capabilities.tsx';
import { Connect } from './connect.tsx';
import { ConnectNow } from './connect-now.tsx';
import { AgentDemo } from './demos/demo.tsx';
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

        <section className="cell" id="ai-native" aria-label="Tools for your agent">
          <div className="head">
            <span className="label">02 / AI native</span>
            <div>
              <h2 className="display">Not an editor with an agent inside.</h2>
              <p className="compare-lede">
                Other AI editors put their own assistant in their app and hand it your prompt.
                cuttingfloor turns that around: it is the editing tools, served over MCP, for the
                agent you already chose. Your agent brings the judgment of a professional editor and
                cinematographer; cuttingfloor gives it real cuts, real sound and real pictures to
                check. You keep your agent, your history and your habits.{' '}
                <a href="/compare">Compare the two kinds</a>.
              </p>
            </div>
          </div>
          <ul className="ledger">
            <li>
              <span className="n">01</span>
              <h3>Real editing verbs.</h3>
              <p>
                Cut, trim, split, speed, caption, mix, grade, animate: each a tool your agent calls,
                not a prompt sent to someone else’s AI.
              </p>
            </li>
            <li>
              <span className="n">02</span>
              <h3>It checks its own work.</h3>
              <p>
                A preview comes back with every edit, plus exact checks for gaps, black frames,
                clipping and sync, so your agent sees what it made before you do.
              </p>
            </li>
            <li>
              <span className="n">03</span>
              <h3>The edit stays yours.</h3>
              <p>
                Every edit is a timeline you can step back to, or open in your own editor as FCPXML,
                OTIO or EDL. Open source ({LICENCE}): run it yourself, or let us host it.
              </p>
            </li>
          </ul>
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

        {DEMOS[0] && (
          <section className="cell" aria-label="Your agent, editing">
            <div className="head">
              <span className="label">04 / In your agent</span>
              <h2 className="lede">
                Plug cuttingfloor into the agent you already use. <em>It becomes your editor.</em>
              </h2>
            </div>
            <AgentDemo demo={DEMOS[0]} />
            <p className="wt-links">
              <a href={`/demos/${DEMOS[0].slug}`}>Watch the before and after</a> ·{' '}
              <a href="/demos">All demos</a>
            </p>
          </section>
        )}

        <section className="cell" id="problems" aria-label="Problems it solves">
          <div className="head">
            <span className="label">05 / Solved</span>
            <div>
              <h2 className="display">The jobs that eat your week.</h2>
              <p className="compare-lede">
                The editing creators hate most, and the places AI editors still fall down, each with
                what your agent does about it here.
              </p>
            </div>
          </div>
          <PainTable caption="The ten slowest editing jobs" rows={EDITING_PAINS} />
          <p className="wt-links">
            <a href="/features">Everything it can do</a> ·{' '}
            <a href="/compare">Where other AI editors go wrong</a>
          </p>
        </section>

        <section className="cell" aria-label="Things to ask for">
          <div className="head">
            <span className="label">06 / Ask for</span>
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

        <section className="cell paper marks" id="how">
          <span className="mark-b" />
          <span className="label">07 / What it does</span>
          <h2 className="display big-stat">
            {TOOL_COUNT} tools.
            <br />
            No timeline.
            <small>
              Granular tools an agent composes, and a skills library that shows it how to chain
              them.
            </small>
          </h2>
          <Capabilities />
        </section>

        <section className="cell" id="start">
          <div className="head">
            <span className="label">08 / Start</span>
            <h2 className="display">Three steps.</h2>
          </div>
          <ol className="ledger">
            <li>
              <span className="n">01</span>
              <h3>Connect your agent.</h3>
              <p>
                Add <code>https://api.cuttingfloor.ai/mcp</code> as an MCP server in Kazi, Claude,
                ChatGPT, Codex or Cursor. Your client opens a sign-in page the first time. Or{' '}
                <a href="/self-host">run it yourself</a>.
              </p>
            </li>
            <li>
              <span className="n">02</span>
              <h3>Hand it footage.</h3>
              <p>
                A link to a file, or nothing at all: it can make titles, graphics, stills and a
                voiceover from scratch.
              </p>
            </li>
            <li>
              <span className="n">03</span>
              <h3>Say what you want.</h3>
              <p>
                “A 30-second cut for LinkedIn, captions, logo at the end.” It edits, checks its work
                and gives you a download link.
              </p>
            </li>
          </ol>
          <div className="start-connect">
            <p className="label">Your agent’s setup</p>
            <Connect />
          </div>
        </section>

        <section className="cell">
          <figure className="reel" style={{ margin: 0 }}>
            <div>
              <video src="/reel.mp4" poster="/reel.jpg" muted loop playsInline autoPlay />
              <figcaption className="label">
                <span>infinite agentic memory</span>
                <span className="tc">00:00:13:00</span>
              </figcaption>
            </div>
            <div>
              <span className="label">09 / Made here</span>
              <h2
                className="display"
                style={{ fontSize: 'clamp(40px, 5.4vw, 80px)', margin: '16px 0 20px' }}
              >
                Graphics, cuts and sound, from one conversation.
              </h2>
              <p>
                A 24-minute explainer: every slide drawn with create.motion, every cut placed by an
                agent. This is thirteen seconds of it.
              </p>
            </div>
          </figure>
        </section>

        <section className="cell" id="pricing">
          <div className="head">
            <span className="label">10 / Pricing</span>
            <div>
              <h2 className="display">Every tool on every plan. Start free.</h2>
              <p className="compare-lede">
                {FREE_CREDITS} free credits, no card, no time limit. Then plans from {FROM_PRICE} a
                month. Run it yourself and it is all free.
              </p>
            </div>
          </div>
          <table className="price-table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Price</th>
                <th>Included</th>
                <th>Runs</th>
                <th>For</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="tier">Self-hosted</td>
                <td className="amount">
                  <a href="/self-host">Free</a>
                </td>
                <td>No minute limits</td>
                <td className="over">Your machine, the same image</td>
                <td className="note">Open source ({LICENCE}). Bring your own keys where needed.</td>
              </tr>
              {PLANS.map((p) => (
                <tr key={p.name} className={p.pick ? 'pick' : ''}>
                  <td className="tier">{p.name}</td>
                  <td className="amount">
                    {p.amount === undefined ? (
                      <a href={p.href}>{p.price}</a>
                    ) : (
                      <>
                        {p.price} <small>{p.per}</small>
                      </>
                    )}
                  </td>
                  <td>{p.included}</td>
                  <td className="over">{p.limits}</td>
                  <td className="note">{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="price-foot">
            A credit is a minute of our servers working for you: an export, a transcript, graphics,
            a voiceover. Editing the timeline costs nothing. When credits run out, work waits; you
            are never charged more than the plan price.{' '}
            <a href="/pricing#every-plan">What every plan includes</a>.
          </p>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">11 / Questions</span>
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
