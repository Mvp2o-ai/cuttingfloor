import { SUPPORT_EMAIL, TRIAL_DAYS } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import {
  ALSO,
  APP_COLUMNS,
  APPS,
  AS_OF,
  COMPARED_ON,
  MARKS,
  type Mark,
  OUR_NOTES,
  SERVER_COLUMNS,
  SERVERS,
} from '../../content/compare.ts';
import { REPO_URL } from '../../content/facts.ts';
import { TryKazi } from '../kazi.tsx';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav, SIGN_UP } from '../shell.tsx';

// Like for like: the agent-facing video servers and APIs, and the creator editing apps, from
// their public docs. The tables are plain HTML so an agent reading the page can decide from it;
// /compare.md carries the same data.

const TITLE = 'Compare AI video editing: MCP servers, APIs and editing apps';
const DESCRIPTION =
  'cuttingfloor side by side with the Descript, invideo, OpusClip, Kapwing and Submagic MCPs, Frapea, the Resolve and Premiere bridges, FFmpeg servers, Shotstack, Creatomate, JSON2Video and HyperFrames, and with CapCut, VEED and other editing apps. From public docs, November 2026.';

export const metadata: Metadata = {
  title: `${TITLE} | cuttingfloor`,
  description: DESCRIPTION,
  alternates: { canonical: '/compare', types: { 'text/markdown': '/compare.md' } },
  openGraph: { type: 'article', url: '/compare', title: TITLE, description: DESCRIPTION },
};

const MARK_CLASS: Record<Mark, string> = { Y: 'yes', N: 'no', P: 'part', $: 'paid', '?': 'q' };

export default function Compare() {
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: 'Agent-facing video editing servers and APIs compared',
          description: `${AS_OF}, read ${COMPARED_ON}.`,
          numberOfItems: SERVERS.length,
          itemListElement: SERVERS.map((s, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: s.name,
            description: s.is,
          })),
        }}
      />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Compare', href: '/compare' }]} />
          <span className="label">Compare</span>
          <h1 className="display">
            Editing tools for your agent, not an editor with an agent inside.
          </h1>
          <p className="lede wt-answer">
            You stay in Claude, ChatGPT, Codex, Cursor or Kazi and connect one open-source MCP
            server, hosted or on your own machine. Your agent gets real editing verbs and sees the
            result after every edit. Here is how that compares with everything else an agent can
            edit video with, cell by cell.
          </p>
          <TryKazi place="compare" />
          <p className="cmp-asof">
            {AS_OF}. Checked {formatDate(COMPARED_ON)}. “?” means we could not confirm it in the
            product’s own docs. Spotted something wrong? Email{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
          </p>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">01 / Two kinds</span>
            <div>
              <h2 className="display">Two kinds of AI video editing.</h2>
            </div>
          </div>
          <div className="cmp-kinds">
            <div>
              <h3>An editor with an AI inside</h3>
              <p>
                Descript (with Underlord), CapCut, VEED, Kapwing, OpusClip, invideo. You open their
                app and their AI works in it, on their credits. When they offer agent access, it is
                often a way to send a request to that AI.
              </p>
            </div>
            <div className="ours">
              <h3>Editing tools for your agent</h3>
              <p>
                cuttingfloor. Your agent, the one you already talk to, gets the editing itself: cut,
                trim, caption, mix, add effects, export. It makes each edit, looks at the result,
                and decides the next one.
              </p>
            </div>
          </div>
          <div className="wt-prose cmp-prose">
            <section>
              <h2>What “forwarding a prompt” means</h2>
              <p>
                Descript’s API and MCP have one call for editing: a job that takes a written
                request, like “remove the section from 1:30 to 2:15”, and hands it to Underlord,
                Descript’s own AI. There is no call to cut, trim, add a caption or render. Your
                agent writes a message to another AI and waits for it to finish. It does not make
                the cut, and Descript’s docs describe no picture of the result coming back to it.
                Import, search, publish and transcript export are direct calls. VideoDB’s{' '}
                <code>call_director</code> works the same way.
              </p>
            </section>
          </div>
          <ol className="ledger">
            <li>
              <span className="n">01</span>
              <h3>Control.</h3>
              <p>
                Each tool does exactly what it says. The cut lands on the word you meant, the music
                sits at the level you asked for, and nothing else changes.
              </p>
            </li>
            <li>
              <span className="n">02</span>
              <h3>The edit stays editable.</h3>
              <p>
                Every edit makes a new version of the timeline and earlier ones stay, so going back
                is one step. Export the edit as FCPXML, OTIO or EDL and finish it in Final Cut Pro,
                Premiere or Resolve.
              </p>
            </li>
            <li>
              <span className="n">03</span>
              <h3>Your agent’s judgment.</h3>
              <p>
                The agent you picked, with your instructions and everything it knows about your
                project, decides the cuts. Not a second AI you cannot brief.
              </p>
            </li>
            <li>
              <span className="n">04</span>
              <h3>No lock-in.</h3>
              <p>
                Open source under AGPL-3.0. The hosted server and the one you run yourself are the
                same Docker image. You get normal MP4s and project files.
              </p>
            </li>
          </ol>
          <div className="wt-prose cmp-prose">
            <section>
              <h2>Seeing the result</h2>
              <p>
                cuttingfloor is not the only one whose agent can look. Frapea makes contact sheets,
                Tella checks frames of the edited video, and the Resolve and Premiere bridges export
                stills. What cuttingfloor adds: a preview comes back with every edit without asking
                (frames, or a waveform with the loudness measured for sound), <code>qa.check</code>{' '}
                measures gaps, black frames, silences, loudness and cuts through words, and{' '}
                <code>media.seek</code> finds a moment from plain words like “where the demo
                starts”.
              </p>
            </section>
          </div>
        </section>

        <section className="cell" id="servers">
          <div className="head">
            <span className="label">02 / For agents</span>
            <div>
              <h2 className="display">Video servers and APIs an agent can call.</h2>
              <p className="compare-lede">
                MCP servers and render APIs, compared on what your agent can actually do with them.
              </p>
            </div>
          </div>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a wide table scrolls inside this box, so keyboard users need to focus it */}
          <section className="cmp-scroll" aria-labelledby="servers-caption" tabIndex={0}>
            <table className="cmp-matrix">
              <caption id="servers-caption">
                Agent-facing video MCP servers and APIs. {AS_OF}, {formatDate(COMPARED_ON)}.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  {SERVER_COLUMNS.map((c) => (
                    <th scope="col" key={c.key}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SERVERS.map((s) => (
                  <tr key={s.name} className={s.ours ? 'ours' : undefined}>
                    <th scope="row">
                      {s.name}
                      <span>{s.is}</span>
                    </th>
                    {SERVER_COLUMNS.map((c) => (
                      <td key={c.key}>{s.cells[c.key]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </section>

        <section className="cell" id="apps">
          <div className="head">
            <span className="label">03 / For creators</span>
            <div>
              <h2 className="display">Editing apps, feature by feature.</h2>
              <p className="compare-lede">
                The jobs creators open an editing app for. In cuttingfloor your agent does each one
                with the tools; the notes under the table say how.
              </p>
            </div>
          </div>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a wide table scrolls inside this box, so keyboard users need to focus it */}
          <section className="cmp-scroll" aria-labelledby="apps-caption" tabIndex={0}>
            <table className="cmp-matrix cmp-marks">
              <caption id="apps-caption">
                Creator editing apps by feature. {AS_OF}, {formatDate(COMPARED_ON)}.
              </caption>
              <thead>
                <tr>
                  <th scope="col">App</th>
                  {APP_COLUMNS.map((c) => (
                    <th scope="col" key={c.key}>
                      {c.label}
                    </th>
                  ))}
                  <th scope="col">Agent access</th>
                  <th scope="col">Self-host</th>
                </tr>
              </thead>
              <tbody>
                {APPS.map((a) => (
                  <tr key={a.name} className={a.ours ? 'ours' : undefined}>
                    <th scope="row">{a.name}</th>
                    {APP_COLUMNS.map((c) => (
                      <td key={c.key} className={`m m-${MARK_CLASS[a.marks[c.key]]}`}>
                        {MARKS[a.marks[c.key]]}
                      </td>
                    ))}
                    <td className="wide">{a.agent}</td>
                    <td>{a.selfHost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <dl className="cmp-notes">
            {APP_COLUMNS.map((c) => (
              <div key={c.key}>
                <dt>{c.label}</dt>
                <dd>{OUR_NOTES[c.key]}</dd>
              </div>
            ))}
          </dl>
          <p className="price-foot">
            “Higher plan or metered” means the feature is on a paid tier or draws on separate
            credits or minutes. None of these apps asks for your own AI provider key; cuttingfloor
            does for one thing, lip-sync. Motion graphics are left out: we could not confirm them
            across the apps. In cuttingfloor, <code>create.motion</code> renders any animated HTML,
            with transparency.
          </p>
        </section>

        <section className="cell" id="pick">
          <div className="head">
            <span className="label">04 / Fair</span>
            <div>
              <h2 className="display">Pick it when.</h2>
              <p className="compare-lede">
                Where another tool is the better choice, it says so here.
              </p>
            </div>
          </div>
          <table className="compare-table">
            <caption className="cmp-hidden">When each tool is the better choice</caption>
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Pick it when</th>
              </tr>
            </thead>
            <tbody>
              {[...SERVERS, ...ALSO].map((s) => (
                <tr key={s.name} className={'ours' in s && s.ours ? 'ours' : undefined}>
                  <th scope="row" className="tier">
                    {s.name}
                  </th>
                  <td className="note">{s.pick}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="cmp-also">
            {ALSO.map((a) => (
              <li key={a.name}>
                <strong>{a.name}.</strong> {a.is}
              </li>
            ))}
          </ul>
        </section>

        <section className="cell paper">
          <div className="wt-prose">
            <section>
              <h2>Try it on your own footage</h2>
              <p>
                <a href={SIGN_UP}>Connect cuttingfloor to your agent</a> and ask for the edit you
                want. Free for {TRIAL_DAYS} days, no card. Or run it yourself from{' '}
                <a href={REPO_URL}>GitHub</a>, free. For people coming from CapCut, Descript, VEED
                or Kapwing, see <a href="/alternatives">the alternatives page</a>.
              </p>
            </section>
          </div>
        </section>

        <Footer />
      </main>
    </>
  );
}
