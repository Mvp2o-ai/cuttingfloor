import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DEMOS, type Demo, demo, finished } from '../../../content/demos.ts';
import { skill } from '../../../content/skills.ts';
import { Breadcrumbs, Footer, JsonLd, Nav } from '../../shell.tsx';
import { AgentDemo } from '../demo.tsx';
import { videoObject } from '../video.ts';

// One watch page per demo: the finished video is the main thing on it, so search can show it.

export const dynamicParams = false;

export function generateStaticParams() {
  return DEMOS.map((d) => ({ slug: d.slug }));
}

type Props = { params: Promise<{ slug: string }> };

const metaTitle = (d: Demo) => `${d.title} | cuttingfloor demo`;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const d = demo((await params).slug);
  if (!d) return {};
  const path = `/demos/${d.slug}`;
  const v = finished(d);
  return {
    title: metaTitle(d),
    description: d.description,
    alternates: { canonical: path },
    openGraph: {
      type: 'video.other',
      url: path,
      title: metaTitle(d),
      description: d.description,
      images: v.poster ? [{ url: v.poster, width: 540, height: 960 }] : [],
      videos: [{ url: v.src, width: 540, height: 960, type: 'video/mp4' }],
    },
  };
}

export default async function DemoPage({ params }: Props) {
  const d = demo((await params).slug);
  if (!d) notFound();
  const v = finished(d);
  const s = d.skill ? skill(d.skill) : undefined;
  const others = DEMOS.filter((o) => o !== d);

  return (
    <>
      <JsonLd data={videoObject(d)} />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs
            trail={[
              { name: 'Demos', href: '/demos' },
              { name: d.title, href: `/demos/${d.slug}` },
            ]}
          />
          <span className="label">Demo · {d.agent}</span>
          <h1 className="display">{d.title}</h1>
          <p className="lede wt-answer">{d.description}</p>
        </section>

        <section className="cell">
          <div className="dm-pair">
            <figure className="dm-main">
              <video
                src={v.src}
                poster={v.poster}
                width={540}
                height={960}
                controls
                playsInline
                preload="none"
              >
                <track kind="captions" srcLang="en" label="English" src={v.captions} default />
              </video>
              <figcaption>
                <span className="label">After</span> {v.label}
              </figcaption>
            </figure>
            <figure>
              <video
                src={d.raw.src}
                poster={d.raw.poster}
                width={540}
                height={960}
                controls
                playsInline
                preload="none"
              >
                <track kind="captions" srcLang="en" label="English" src={d.raw.captions} default />
              </video>
              <figcaption>
                <span className="label">Before</span> {d.raw.label}
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">01 / What it did</span>
            <h2 className="lede">What did the agent do?</h2>
          </div>
          <ol className="dm-steps">
            {d.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">02 / The chat</span>
            <h2 className="lede">What it looked like in {d.agent}</h2>
          </div>
          <AgentDemo demo={d} />
        </section>

        <section className="cell wt-end">
          <p className="wt-links">
            {s && (
              <>
                <a href={`/skills/${s.slug}`}>The skill it followed: {s.title}</a> ·{' '}
              </>
            )}
            {others.map((o) => (
              <span key={o.slug}>
                <a href={`/demos/${o.slug}`}>{o.title}</a> ·{' '}
              </span>
            ))}
            <a href="/demos">All demos</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
