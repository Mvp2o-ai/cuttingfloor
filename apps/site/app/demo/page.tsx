import type { Metadata } from 'next';
import { DEMOS } from '../../content/demos.ts';
import { Footer, Nav } from '../shell.tsx';
import { AgentDemo } from './demo.tsx';

// A review page for the agent demo, in the site's own frame. Not linked or indexed yet.
export const metadata: Metadata = { title: 'Agent demo (review)', robots: { index: false } };

export default function DemoReview() {
  return (
    <>
      <Nav />
      <main className="frame">
        <section className="cell">
          <div className="head">
            <span className="label">Your agent, editing</span>
            <h2 className="lede">
              Plug cuttingfloor into the agent you already use. <em>It becomes your editor.</em>
            </h2>
          </div>
          <div className="demo-stack">
            {DEMOS.map((d) => (
              <AgentDemo key={d.id} demo={d} />
            ))}
          </div>
        </section>
        <Footer />
      </main>
    </>
  );
}
