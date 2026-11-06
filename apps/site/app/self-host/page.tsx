import { TRIAL_DAYS } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import {
  IMAGE,
  KEYS,
  LICENCE,
  LOCAL_ADDRESS,
  NO_KEY,
  REPO_URL,
  SELF_HOST_STEPS,
} from '../../content/facts.ts';
import { LiveCard } from '../live-card.tsx';
import { Breadcrumbs, Footer, Nav, SIGN_UP } from '../shell.tsx';
import { Copy } from '../walkthroughs/copy.tsx';
import {
  AGPL,
  COMPARE,
  CONTRIBUTING_URL,
  LICENCE_URL,
  LOCAL_CONNECT,
  LOCAL_NOTES,
  REQUIREMENTS,
  SELF_HOST_DESCRIPTION,
  SELF_HOST_LEAD,
  SELF_HOST_TITLE,
  UPDATE_STEPS,
} from './copy.ts';

// Download it, make it your own, or go hosted. The quick start and keys come from
// content/facts.ts; the rest from ./copy.ts, which the Markdown twin (/self-host.md) reads too.

export const metadata: Metadata = {
  title: `${SELF_HOST_TITLE} | cuttingfloor`,
  description: SELF_HOST_DESCRIPTION,
  alternates: { canonical: '/self-host', types: { 'text/markdown': '/self-host.md' } },
  openGraph: {
    type: 'article',
    url: '/self-host',
    title: SELF_HOST_TITLE,
    description: SELF_HOST_DESCRIPTION,
  },
};

function Code({ code, label }: { code: string; label: string }) {
  return (
    <figure className="wt-prompt">
      <pre>
        <code>{code}</code>
      </pre>
      <figcaption>
        <span className="label">{label}</span>
        <Copy text={code} label="Copy" />
      </figcaption>
    </figure>
  );
}

export default function SelfHostPage() {
  const start = SELF_HOST_STEPS.join('\n');
  return (
    <>
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Run it yourself', href: '/self-host' }]} />
          <span className="label">Open source · {LICENCE}</span>
          <h1 className="display">Download it, make it your own, or go hosted.</h1>
          <p className="lede wt-answer">
            {SELF_HOST_LEAD} <em>Run it on your computer for free, or let us run it for you.</em>
          </p>
          <LiveCard />
          <div className="actions">
            <a className="link-big" href="#quick-start">
              Run it yourself, free
            </a>
            <a className="link-big quiet" href={SIGN_UP}>
              Go hosted: {TRIAL_DAYS} days free
            </a>
          </div>
        </section>

        <section className="cell" id="quick-start">
          <div className="head">
            <span className="label">01 / Quick start</span>
            <h2 className="display">Two lines.</h2>
          </div>
          <div className="cl-body">
            <div>
              <ol className="cl-steps">
                <li>Install Docker, if you don’t have it.</li>
                <li>
                  Run the two lines. Compose starts the editor and a locked-down sandbox where
                  motion graphics are drawn.
                </li>
                <li>
                  Point your agent at <code>{LOCAL_ADDRESS}</code>.
                </li>
              </ol>
            </div>
            <div className="cl-snippets">
              <Code code={start} label="Run in a terminal" />
            </div>
          </div>
        </section>

        <section className="cell" id="connect-local">
          <div className="head">
            <span className="label">02 / Connect your agent</span>
            <h2 className="lede">Same tools, on your computer.</h2>
          </div>
          <div className="cl-body">
            <ul className="cl-notes">
              {LOCAL_NOTES.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <div className="cl-snippets">
              {LOCAL_CONNECT.map((s) => (
                <Code key={s.label} code={s.code} label={s.label} />
              ))}
            </div>
          </div>
        </section>

        <section className="cell" id="compare">
          <div className="head">
            <span className="label">03 / Hosted or yourself</span>
            <div>
              <h2 className="display">Same code. Who does the work?</h2>
              <p className="compare-lede">
                Nothing is held back when you run it yourself. Paying for hosted buys one thing: we
                run it.
              </p>
            </div>
          </div>
          <div className="sk-table">
            <table className="compare-table">
              <thead>
                <tr>
                  <th />
                  <th>Hosted (cuttingfloor.ai)</th>
                  <th>Run it yourself</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((r) => (
                  <tr key={r.row}>
                    <td className="tier">{r.row}</td>
                    <td>{r.hosted}</td>
                    <td>{r.self}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="wt-links">
            <a href={SIGN_UP}>Start hosted, {TRIAL_DAYS} days free</a> ·{' '}
            <a href="/#pricing">Plans</a> · <a href="/connect">Connect to hosted</a>
          </p>
        </section>

        <section className="cell" id="keys">
          <div className="head">
            <span className="label">04 / Keys</span>
            <h2 className="lede">Almost nothing needs a key of your own.</h2>
          </div>
          <div className="sk-table">
            <table className="compare-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Hosted</th>
                  <th>Run it yourself</th>
                </tr>
              </thead>
              <tbody>
                {KEYS.map((k) => (
                  <tr key={k.feature}>
                    <td className="tier">{k.feature}</td>
                    <td>{k.hosted}</td>
                    <td>{k.selfHosted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="cl-sub">Built in, no key, either way</h3>
          <ul className="cl-notes">
            {NO_KEY.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="wt-links">
            Running it yourself, keys go in the <code>.env</code> file next to{' '}
            <code>compose.yaml</code>. Run <code>docker compose up -d</code> after adding one.
          </p>
        </section>

        <section className="cell paper" id="licence">
          <div className="head">
            <span className="label">05 / The licence</span>
            <h2 className="lede">What {LICENCE} means for you.</h2>
          </div>
          <dl className="cl-agpl">
            {AGPL.map((a) => (
              <div key={a.q}>
                <dt>{a.q}</dt>
                <dd>{a.a}</dd>
              </div>
            ))}
          </dl>
          <p className="wt-links">
            <a href={LICENCE_URL}>Read the licence</a>
          </p>
        </section>

        <section className="cell" id="requirements">
          <div className="head">
            <span className="label">06 / What you need</span>
            <h2 className="lede">Docker, and some memory.</h2>
          </div>
          <ul className="cl-notes">
            {REQUIREMENTS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="wt-links">
            To update later: <code>{UPDATE_STEPS.join(' && ')}</code>
          </p>
        </section>

        <section className="cell" id="make-it-yours">
          <div className="head">
            <span className="label">07 / Make it your own</span>
            <h2 className="lede">Change it, and send it back if you like.</h2>
          </div>
          <p className="wt-links">
            The code, issues and releases are on <a href={REPO_URL}>GitHub</a>. To send a change,
            read <a href={CONTRIBUTING_URL}>CONTRIBUTING.md</a>: fork it, branch from{' '}
            <code>develop</code> and open a pull request. The image is <code>{IMAGE}</code>.
          </p>
        </section>

        <Footer />
      </main>
    </>
  );
}
