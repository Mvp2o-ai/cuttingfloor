import { Bay } from './bay.tsx';
import { Capabilities } from './capabilities.tsx';
import { Connect } from './connect.tsx';
import { PLANS } from './pricing.ts';

// The trial starts by connecting: the client opens the sign-in. The account page (plan, billing)
// arrives with subscriptions.
const SIGN_UP = '#start';
const DOCS = 'https://github.com/mvp2o-ai/cuttingfloor';

export default function Home() {
  return (
    <>
      <header className="nav">
        <div className="nav-inner">
          <a className="wordmark" href="/">
            <span className="marker" aria-hidden="true" />
            cuttingfloor
          </a>
          <nav className="nav-links" aria-label="Sections">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href={DOCS}>Open source</a>
          </nav>
          <a className="nav-cta" href={SIGN_UP}>
            Start free
          </a>
        </div>
      </header>

      <main className="frame">
        <section className="cell hero marks">
          <span className="mark-b" />
          <div className="leader rise">
            <b>cuttingfloor</b>
            <span className="dots" />
            <span>agentic video editing</span>
          </div>
          <h1 className="display rise d1">
            Editing,
            <br />
            solved.
            <span className="qed" role="img" aria-label="Q.E.D." />
          </h1>
          <div className="hero-row">
            <div className="rise d2">
              <p className="lede">
                Your agent edits video now. Connect Kazi, Claude, Cursor or ChatGPT and say what you
                want cut.{' '}
                <em>
                  It imports your footage, reads the transcript, trims, captions, mixes and hands
                  back a finished file.
                </em>
              </p>
              <div className="actions">
                <a className="link-big" href={SIGN_UP}>
                  Start free for 3 days
                </a>
                <a className="link-big quiet" href="#how">
                  See it work
                </a>
              </div>
            </div>
            <div className="rise d3" id="start">
              <Connect />
            </div>
          </div>
        </section>

        <section className="cell" aria-label="A session">
          <div className="head">
            <span className="label">01 / The bay</span>
            <p className="lede">
              Every edit is a tool call. Every call returns a new timeline and a picture of it, so
              the agent sees what it did.
            </p>
          </div>
          <Bay />
        </section>

        <section className="cell paper marks" id="how">
          <span className="mark-b" />
          <span className="label">02 / What it does</span>
          <h2 className="display big-stat">
            62 tools.
            <br />
            No timeline UI.
            <small>Granular primitives an agent composes, plus code when it needs a loop.</small>
          </h2>
          <Capabilities />
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">03 / Start</span>
            <h2 className="display">Three steps.</h2>
          </div>
          <ol className="ledger">
            <li>
              <span className="n">01</span>
              <h3>Connect your agent.</h3>
              <p>
                Add <code>cuttingfloorai.apifunnel.ai/mcp</code> as an MCP server. Your client opens
                a sign-in page; Google, GitHub, Microsoft, Apple or email.
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
              <span className="label">04 / Made here</span>
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
            <span className="label">05 / Pricing</span>
            <h2 className="display">Pay for rendering.</h2>
          </div>
          <table className="price-table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Price</th>
                <th>Included</th>
                <th>Over that</th>
                <th>For</th>
              </tr>
            </thead>
            <tbody>
              {PLANS.map((p) => (
                <tr key={p.name} className={p.pick ? 'pick' : ''}>
                  <td className="tier">{p.name}</td>
                  <td className="amount">
                    {p.price} <small>{p.per}</small>
                  </td>
                  <td>{p.included}</td>
                  <td className="over">{p.overage}</td>
                  <td className="note">{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="price-foot">
            A render minute is a minute of our servers working for you: exports, transcripts,
            graphics, voiceovers, cutouts. Planning and editing the timeline cost nothing. Yearly
            plans get two months free. Payments by Stripe; cancel any time.
          </p>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">06 / Questions</span>
            <h2 className="display">Asked.</h2>
          </div>
          <div className="faq">
            <details>
              <summary>Which agents work with it?</summary>
              <p>
                Any MCP client with remote servers: Kazi, Claude (web, desktop and Code), Cursor,
                ChatGPT in developer mode, VS Code, and anything built on the MCP SDKs.
              </p>
            </details>
            <details>
              <summary>Where does my footage go?</summary>
              <p>
                To our servers, for as long as you work on it. Media and renders expire after seven
                days, timelines after a day without use. No one else can see them.
              </p>
            </details>
            <details>
              <summary>Can I run it myself?</summary>
              <p>
                Yes. cuttingfloor is open source and runs in one Docker image on your own machine.
                The hosted version is the same image, run for you.
              </p>
            </details>
            <details>
              <summary>Do I need my own AI keys?</summary>
              <p>
                No. Transcription, voiceover, cutouts and graphics run on our servers. Your agent is
                whatever you already use.
              </p>
            </details>
          </div>
        </section>

        <footer className="cell footer marks">
          <span className="mark-b" />
          <div>
            <p className="display">
              Editing, solved.
              <span className="qed" role="img" aria-label="Q.E.D." />
            </p>
            <div className="footer-links">
              <a href={SIGN_UP}>Start free</a>
              <a href={DOCS}>GitHub</a>
              <a href="mailto:ken@mvp2o.com">Contact</a>
            </div>
          </div>
          <div className="win">
            <div className="win-bar">
              <span>About</span>
              <span className="grip" />
            </div>
            <p>
              cuttingfloor 0.10
              <br />© 2026 mvp2o
              <br />
              Cut on a warm black.
            </p>
          </div>
        </footer>
      </main>
    </>
  );
}
