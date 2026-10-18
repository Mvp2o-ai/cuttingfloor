import type { Metadata } from 'next';
import { SKILLS } from '../../content/skills.ts';
import { Breadcrumbs, Footer, Nav } from '../shell.tsx';

export const metadata: Metadata = {
  title: 'Skills: step-by-step video editing instructions for your AI agent | cuttingfloor',
  description:
    'Each skill is a set of steps your agent follows to do one job with cuttingfloor, like cutting the pauses and ums out of a talking video. Copy one into Kazi, Claude or ChatGPT.',
  alternates: { canonical: '/skills' },
};

export default function Skills() {
  return (
    <>
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Skills', href: '/skills' }]} />
          <span className="label">Skills</span>
          <h1 className="display">Steps your agent can follow.</h1>
          <p className="lede wt-answer">
            A skill is one job written down step by step, so your agent does it the same good way
            every time: which cuttingfloor tools to use, in what order, and what to check before it
            hands you the video. Copy one into your agent, or let it find the right one itself once
            cuttingfloor is connected.
          </p>
        </section>
        <section className="cell">
          <ol className="wt-hub">
            {SKILLS.map((s, i) => (
              <li key={s.slug}>
                <a href={`/skills/${s.slug}`}>
                  <span className="label">{String(i + 1).padStart(2, '0')}</span>
                  <h2>{s.title}</h2>
                  <p>{s.description}</p>
                  <span className="wt-hub-meta">
                    {s.body.split('\n').filter((l) => /^\d+\.\s/.test(l)).length} steps · version{' '}
                    {s.version}
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
