import type { Metadata } from 'next';
import { DEMOS, type DemoVideo, finished, length, lengths } from '../../content/demos.ts';
import { Breadcrumbs, Footer, Nav } from '../shell.tsx';

export const metadata: Metadata = {
  title: 'AI video editing demos: Claude and ChatGPT editing real clips | cuttingfloor',
  description:
    'Watch an AI agent edit video: a creator’s own Claude or ChatGPT, with cuttingfloor connected, cuts the pauses, adds captions and hands back a finished short. Before and after, every step.',
  alternates: { canonical: '/demos' },
};

export default function Demos() {
  return (
    <>
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Demos', href: '/demos' }]} />
          <span className="label">Demos</span>
          <h1 className="display">Watch your agent edit.</h1>
          <p className="lede wt-answer">
            Each demo is a real clip edited by a creator’s own agent with cuttingfloor connected.
            You see what they asked for, every step the agent took, and the video before and after.
          </p>
        </section>
        <section className="cell">
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
        <Footer />
      </main>
    </>
  );
}

function Poster({ v, tag }: { v: DemoVideo; tag: string }) {
  return (
    <span className="dm-poster">
      {v.poster && (
        // biome-ignore lint/performance/noImgElement: a fixed-size poster, no layout shift
        <img
          src={v.poster}
          alt=""
          width={v.wide ? 960 : 540}
          height={v.wide ? 540 : 960}
          loading="lazy"
          className={v.wide ? 'wide' : undefined}
        />
      )}
      <span className="label">
        {tag} · {length(v)}
      </span>
    </span>
  );
}
