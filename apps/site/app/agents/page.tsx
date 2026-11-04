import type { Metadata } from 'next';
import { AGENTS, agentDemos } from '../../content/agents.ts';
import { Breadcrumbs, Footer, Nav } from '../shell.tsx';

export const metadata: Metadata = {
  title: 'Edit videos with your AI agent: Kazi, Claude and ChatGPT | cuttingfloor',
  description:
    'Connect cuttingfloor to Kazi, Claude or ChatGPT and your agent edits your videos: cuts, captions, music and the finished file. How to set up each one, with real edits made in it.',
  alternates: { canonical: '/agents', types: { 'text/markdown': '/agents.md' } },
};

export default function Agents() {
  return (
    <>
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Agents', href: '/agents' }]} />
          <span className="label">Agents</span>
          <h1 className="display">Edit from the agent you already use.</h1>
          <p className="lede wt-answer">
            Kazi, Claude and ChatGPT can’t cut video on their own. Connect cuttingfloor and they
            can: your agent cuts your footage, adds captions and music, checks a preview and gives
            you the finished video. Each page has the setup and real edits made in that agent.
          </p>
        </section>
        <section className="cell">
          <ol className="ledger">
            {AGENTS.map((a, i) => (
              <li key={a.slug}>
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <h3>
                  <a href={`/agents/${a.slug}`}>{a.title}</a>
                </h3>
                <p>
                  {a.answer} ({agentDemos(a).length} demo
                  {agentDemos(a).length === 1 ? '' : 's'})
                </p>
              </li>
            ))}
          </ol>
          <p className="wt-links">
            Claude Code, Codex, Cursor, VS Code, Gemini, Zed, Goose and any other MCP app:{' '}
            <a href="/connect">every setup</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
