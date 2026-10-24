import { DEMOS } from '../content/demos.ts';
import { HOME_SESSION } from '../content/home-session.ts';
import { Capabilities } from './capabilities.tsx';
import { Connect } from './connect.tsx';
import { AgentDemo } from './demos/demo.tsx';
import { PLANS } from './pricing.ts';
import { Prompts } from './prompts.tsx';
import { ALTERNATIVES, FAQS, structuredData } from './seo.ts';
import { Session } from './session/session.tsx';
import { Check, Footer, JsonLd, Nav, SIGN_UP } from './shell.tsx';

// Linking here plays the session from the top.
const SESSION_ID = 'session';

// The agents it already works in. Kazi is ours, so it leads, in the accent.
const CLIENTS = ['Kazi', 'Claude', 'Claude Code', 'Cursor', 'ChatGPT', 'Codex'] as const;

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
            <span>the control plane for AI video agents</span>
          </h1>
          <p className="display title rise d1">
            Video editing,
            <br />
            finished.
            <Check />
          </p>
          <div className="hero-row">
            <div className="rise d2">
              <p className="lede">
                One connection.{' '}
                <em>
                  Your AI assistant cuts, captions and mixes — then hands back a file a human editor
                  can finish.
                </em>
              </p>
              <div className="actions">
                <a className="link-big" href={SIGN_UP}>
                  Start free — 3 days
                </a>
                <a className="link-big quiet" href="/demos">
                  Watch it edit
                </a>
              </div>
              <span>Self-hosted · no external AI keys</span>
            </div>
            <div className="rise d3 works-in">
              <span className="label">Works in</span>
              <ul>
                {CLIENTS.map((c, i) => (
                  <li key={c} className={i === 0 ? 'ours' : undefined}>
                    {c}
                  </li>
                ))}
              </ul>
              <p>Any remote MCP client</p>
              <p>
                Bring the agent you already use. Sign in, then add one server address; the setup for
                each is <a href="#start">below</a>.
              </p>
            </div>
          </div>
        </section>

        <section className="cell floor" aria-label="An agent editing over MCP">
          <video src="/floor.mp4" poster="/floor.jpg" muted loop playsInline autoPlay />
          <div className="floor-cap">
            <span className="label">01 / The layer after generation</span>
            <span className="label">Generation is cheap now. Assembly is not.</span>
          </div>
        </section>

        <section className="cell" id={SESSION_ID} aria-label="A session">
          <div className="head">
            <span className="label">02 / A session</span>
            <h2 className="lede">
              Agentic video editing, one tool call at a time. <em>Here is one.</em>
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
              <span className="label">03 / In your agent</span>
              <h2 className="lede">
                Plug cuttingfloor into the agent you already use. <em>We make it finish.</em>
              </h2>
            </div>
            <AgentDemo demo={DEMOS[0]} />
            <p className="wt-links">
              <a href={`/demos/${DEMOS[0].slug}`}>Watch the before and after</a> ·{' '}
              <a href="/demos">All demos</a>
            </p>
          </section>
        )}

        <section className="cell" aria-label="Things to ask for">
          <div className="head">
            <span className="label">04 / Ask for</span>
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
          <span className="label">05 / What it does</span>
          <h2 className="display big-stat">
            66 tools.
            <br />
            No timeline.
            <small>Granular tools an agent composes, plus code when it needs a loop.</small>
          </h2>
          <Capabilities />
        </section>

        <section className="cell" id="start">
          <div className="head">
            <span className="label">06 / Start</span>
            <h2 className="display">Three steps.</h2>
          </div>
          <ol className="ledger">
            <li>
              <span className="n">01</span>
              <h3>Connect your agent.</h3>
              <p>
                Add <code>https://api.cuttingfloor.ai/mcp</code> as an MCP server in Claude, Cursor,
                ChatGPT or Kazi. Your client opens a sign-in page; Google, GitHub, Microsoft, Apple
                or email.
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
              <span className="label">07 / Made here</span>
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
            <span className="label">08 / Pricing</span>
            <div>
              <h2 className="display">Pay for the finished minute, not the seat.</h2>
              <p className="compare-lede">
                About 16 cents a rendered minute. A ten-minute captioned, mixed video uses about 35
                of them — around $5.70, against four to six hours of manual work.
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
            A render minute is a minute of our servers working for you: exports, imports,
            transcripts, graphics, voiceovers, cutouts. When minutes run out, work waits. You are
            never charged more than the plan price. Yearly plans get two months free. Payments by
            Stripe; cancel any time.
          </p>
        </section>

        <section className="cell" id="compare">
          <div className="head">
            <span className="label">09 / Compared</span>
            <div>
              <h2 className="display">Edits, not templates.</h2>
              <p className="compare-lede">
                Looking for a Remotion, Shotstack, Creatomate or JSON2Video alternative? Those
                render a video you have already described in code or JSON. cuttingfloor is a video
                editing API your agent drives call by call, looking at each result.
              </p>
            </div>
          </div>
          <table className="compare-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>What it is</th>
                <th>Pick it when</th>
              </tr>
            </thead>
            <tbody>
              {ALTERNATIVES.map((a) => (
                <tr key={a.name} className={'ours' in a && a.ours ? 'ours' : ''}>
                  <td className="tier">{a.name}</td>
                  <td>{a.is}</td>
                  <td className="note">{a.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">10 / Questions</span>
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
