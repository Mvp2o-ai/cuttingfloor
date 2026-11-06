import type { Metadata } from 'next';
import { DEMOS, finished, lengths } from '../../content/demos.ts';
import { AgentBlock } from '../agents/block.tsx';
import { Breadcrumbs, Footer, Nav } from '../shell.tsx';
import { LiveDemo } from './live.tsx';
import { Poster } from './poster.tsx';

export const metadata: Metadata = {
  title: 'AI video editing demos: Kazi, Claude and ChatGPT editing real clips | cuttingfloor',
  description:
    'Try a live AI video edit in your browser, free and with no sign-up: Kazi gives Big Buck Bunny a happy ending on cuttingfloor while you watch. Then see creators’ own Kazi, Claude or ChatGPT edit real clips, before and after, every step.',
  alternates: { canonical: '/demos', types: { 'text/markdown': '/demos.md' } },
};

export default function Demos() {
  return (
    <>
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Demos', href: '/demos' }]} />
          <LiveDemo />
        </section>
        <section className="cell">
          <div className="head">
            <span className="label">Real footage</span>
            <div>
              <h2 className="display">Or watch real creators’ edits.</h2>
              <p className="lede">
                Each one is a real clip edited by a creator’s own agent with cuttingfloor connected:
                what they asked for, every step the agent took, and the video before and after.
              </p>
            </div>
          </div>
          <ol className="wt-hub dm-hub">
            {DEMOS.map((d) => {
              const v = finished(d);
              return (
                <li key={d.slug}>
                  <a href={`/demos/${d.slug}`}>
                    <span className="dm-ba">
                      <Poster v={d.raw} tag="Before" />
                      <span className="dm-arrow" aria-hidden="true">
                        →
                      </span>
                      <Poster v={v} tag="After" />
                    </span>
                    <h2>{d.title}</h2>
                    <p>{d.description}</p>
                    <span className="wt-hub-meta">
                      {d.agent} · {lengths(d)}
                    </span>
                  </a>
                </li>
              );
            })}
          </ol>
        </section>
        <AgentBlock />
        <Footer />
      </main>
    </>
  );
}
