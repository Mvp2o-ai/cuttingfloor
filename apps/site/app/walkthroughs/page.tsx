import type { Metadata } from 'next';
import { WALKTHROUGHS } from '../../content/walkthroughs.ts';
import { Breadcrumbs, Footer, Nav } from '../shell.tsx';

export const metadata: Metadata = {
  title: 'AI video editing walkthroughs: real prompts, every tool call | cuttingfloor',
  description:
    'Each walkthrough shows one editing technique end to end: the prompt typed, every tool call an agent made to the cuttingfloor MCP server, and the file that came out.',
  alternates: { canonical: '/walkthroughs' },
};

export default function Walkthroughs() {
  return (
    <>
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Walkthroughs', href: '/walkthroughs' }]} />
          <span className="label">Walkthroughs</span>
          <h1 className="display">One technique, start to finish.</h1>
          <p className="lede wt-answer">
            Each walkthrough is one editing technique done by an agent connected to the cuttingfloor
            MCP server: the prompt as it was typed, every tool call in order with its arguments, the
            timeline it left, and the file that came out. Copy a prompt and try it on your own
            footage.
          </p>
        </section>
        <section className="cell">
          <ol className="wt-hub">
            {WALKTHROUGHS.map((w, i) => (
              <li key={w.slug}>
                <a href={`/walkthroughs/${w.slug}`}>
                  <span className="label">{String(i + 1).padStart(2, '0')}</span>
                  <h2>{w.title}</h2>
                  <p>{w.oneLiner}</p>
                  <span className="wt-hub-meta">
                    {w.session.steps.filter((s) => s.kind === 'call').length} tool calls ·{' '}
                    {w.file.name}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </section>
        <Footer />
      </main>
    </>
  );
}
