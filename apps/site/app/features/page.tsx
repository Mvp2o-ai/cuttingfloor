import { FREE_CREDITS } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { KEYS, LICENCE, NO_KEY } from '../../content/facts.ts';
import { TOOL_COUNT } from '../../content/tools.ts';
import { LiveCard } from '../live-card.tsx';
import { DOCS_URL, SITE_URL } from '../seo.ts';
import { Breadcrumbs, Footer, JsonLd, Nav, SIGN_UP } from '../shell.tsx';
import {
  DESCRIPTION,
  FEATURE_LIST,
  GROUPS,
  keyNeed,
  runs,
  TITLE,
  TOOL_ROWS,
  UPDATED,
} from './content.ts';

// Everything cuttingfloor can do, in server-rendered HTML: MCP server cards leave tool lists out,
// so this page is where an agent or a search engine reads the full list before connecting.

export const metadata: Metadata = {
  title: `${TITLE} | cuttingfloor`,
  description: DESCRIPTION,
  alternates: { canonical: '/features', types: { 'text/markdown': '/features.md' } },
  openGraph: { type: 'article', url: '/features', title: TITLE, description: DESCRIPTION },
};

export default function Features() {
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'SoftwareApplication',
          name: 'cuttingfloor',
          url: `${SITE_URL}/features`,
          description: DESCRIPTION,
          applicationCategory: 'MultimediaApplication',
          applicationSubCategory: 'Video editing MCP server',
          operatingSystem: 'Any MCP client; self-hosted with Docker',
          license: `https://spdx.org/licenses/${LICENCE}.html`,
          softwareHelp: DOCS_URL,
          dateModified: UPDATED,
          featureList: FEATURE_LIST,
        }}
      />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Features', href: '/features' }]} />
          <span className="label">Features</span>
          <h1 className="display">Everything your agent can do with video.</h1>
          <p className="lede wt-answer">
            cuttingfloor is an open-source video editing MCP server: connect Claude, ChatGPT, Cursor
            or Kazi and your agent gets {TOOL_COUNT} editing tools. It cuts by what was said,
            captions, mixes and levels the sound, makes graphics and voiceovers, checks its own work
            and exports an MP4 or the edit for your editing app.{' '}
            <em>Here is all of it, in plain words first and tool names second.</em>
          </p>
          <LiveCard />
          <nav className="ft-jump" aria-label="Feature groups">
            {GROUPS.map((g) => (
              <a key={g.id} href={`#${g.id}`}>
                {g.name}
              </a>
            ))}
            <a href="#keys">Your own keys</a>
            <a href="#tools">All {TOOL_COUNT} tools</a>
          </nav>
        </section>

        {GROUPS.map((g, i) => (
          <section
            key={g.id}
            id={g.id}
            className={g.id === 'audio' ? 'cell paper marks ft-group' : 'cell ft-group'}
          >
            {g.id === 'audio' && <span className="mark-b" />}
            <div className="head">
              <span className="label">
                {String(i + 1).padStart(2, '0')} / {g.name}
              </span>
              <div>
                <h2 className="display">{g.title}</h2>
                <p className="compare-lede">{g.intro}</p>
              </div>
            </div>
            <ul className="ft-list">
              {g.items.map((item) => (
                <li key={item.say}>
                  <p>{item.say}</p>
                  <span className="ft-tools">
                    {item.tools.map((t) => (
                      <code key={t}>{t}</code>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section className="cell" id="keys">
          <div className="head">
            <span className="label">{String(GROUPS.length + 1).padStart(2, '0')} / Keys</span>
            <div>
              <h2 className="display">What needs your own key.</h2>
              <p className="compare-lede">
                Almost nothing. Your agent is whatever you already use, and the rest runs on the
                server. <a href="/pricing">See pricing</a> for credits and what every account gets.
              </p>
            </div>
          </div>
          <table className="ft-table ft-keys">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Hosted</th>
                <th>Self-hosted</th>
              </tr>
            </thead>
            <tbody>
              {KEYS.map((k) => (
                <tr key={k.feature}>
                  <td>
                    <strong>{k.feature}</strong>
                    <span className="ft-tools">
                      {k.tools.map((t) => (
                        <code key={t}>{t}</code>
                      ))}
                    </span>
                  </td>
                  <td data-label="Hosted">{k.hosted}</td>
                  <td className="ft-meta" data-label="Self-hosted">
                    {k.selfHosted}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="ft-sub">No key, hosted or self-hosted</h3>
          <ul className="ft-nokey">
            {NO_KEY.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>

        <section className="cell" id="tools">
          <div className="head">
            <span className="label">{String(GROUPS.length + 2).padStart(2, '0')} / Tools</span>
            <div>
              <h2 className="display">All {TOOL_COUNT} tools.</h2>
              <p className="compare-lede">
                The server’s own tool list, read from it when this page was built. Each tool is one
                editing step your agent calls; it composes them into the edit you asked for.
              </p>
            </div>
          </div>
          <table className="ft-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>What it does</th>
                <th>Group</th>
                <th>Runs</th>
                <th>Your key</th>
              </tr>
            </thead>
            <tbody>
              {TOOL_ROWS.map((t) => (
                <tr key={t.name}>
                  <td className="ft-name">
                    <code>{t.name}</code>
                  </td>
                  <td>{t.say}</td>
                  <td className="ft-meta" data-label="Group">
                    {t.group}
                  </td>
                  <td className="ft-meta" data-label="Runs">
                    {runs(t)}
                  </td>
                  <td className="ft-meta" data-label="Your key">
                    {keyNeed(t.name) || 'None'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            <a className="link-big" href={SIGN_UP}>
              Start free: {FREE_CREDITS} credits
            </a>
            <a className="link-big quiet" href="/demos">
              Watch it edit
            </a>
          </div>
        </section>

        <Footer />
      </main>
    </>
  );
}
