import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  DEMOS,
  type Demo,
  type DemoVideo,
  demo,
  finished,
  length,
  lengths,
} from '../../../content/demos.ts';
import { skill } from '../../../content/skills.ts';
import { AgentBlock } from '../../agents/block.tsx';
import { demoPlace, TryKazi } from '../../kazi.tsx';
import { LiveCard } from '../../live-card.tsx';
import { Breadcrumbs, Footer, JsonLd, Nav } from '../../shell.tsx';
import { AgentDemo } from '../demo.tsx';
import { BeforeAfter } from '../pair.tsx';
import { Seek } from '../seek.tsx';
import { videoObject } from '../video.ts';

// One watch page per demo. It opens on the result (the finished video beside the clip it came
// from), a link to try it live in Kazi and links down to each act, then tells it in order: the
// clip before, the edit in the agent's chat, and the finished video after. The finished video carries the VideoObject, so search shows the after.

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
    alternates: { canonical: path, types: { 'text/markdown': `${path}.md` } },
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
  const cuts = d.transcript.filter((w) => w.cut !== undefined).length;

  return (
    <>
      <JsonLd data={videoObject(d)} />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head dm-hero marks">
          <span className="mark-b" />
          <div className="dm-hero-head">
            <Breadcrumbs
              trail={[
                { name: 'Demos', href: '/demos' },
                { name: d.title, href: `/demos/${d.slug}` },
              ]}
            />
            <span className="label">Demo · {d.agent}</span>
            <h1 className="display">{d.title}</h1>
          </div>
          <BeforeAfter before={d.raw} after={v} />
          <div className="dm-hero-lede">
            <p className="lede wt-answer">{d.description}</p>
            <LiveCard />
            <TryKazi place={demoPlace(d.id)} />
            <nav className="dm-jump" aria-label="The editing journey">
              <a className="link-big quiet" href="#before" data-track="Demo jump: journey">
                See the full editing journey ↓
              </a>
              <ol>
                <li>
                  <a href="#before" data-track="Demo jump: before">
                    <span className="label">01</span>Before
                  </a>
                </li>
                <li>
                  <a href="#edit" data-track="Demo jump: edit">
                    <span className="label">02</span>Your agent edits
                  </a>
                </li>
                <li>
                  <a href="#after" data-track="Demo jump: after">
                    <span className="label">03</span>After
                  </a>
                </li>
              </ol>
            </nav>
          </div>
        </section>

        <section className="cell dm-act" id="before">
          <div className="head">
            <span className="label">01</span>
            <div>
              <h2 className="display">Before</h2>
              <p className="lede">The clip as it came in · {length(d.raw)}</p>
            </div>
          </div>
          <div className={d.raw.wide ? 'dm-side wide' : 'dm-side'}>
            <figure>
              <Clip v={d.raw} />
              <figcaption>{d.raw.label}</figcaption>
            </figure>
            <div className="dm-notes">
              <h3>{cuts ? 'What needs to go' : 'What it says'}</h3>
              <p className="dm-script">
                {d.transcript.map((w, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the transcript is fixed
                  <span key={i}>{w.cut === undefined ? w.text : <del>{w.text}</del>} </span>
                ))}
              </p>
              {cuts > 0 && (
                <p className="dm-key">
                  <del>Struck in red</del>: {cuts} {cuts === 1 ? 'thing' : 'things'} the agent cuts.
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="cell dm-act" id="edit">
          <div className="head">
            <span className="label">02</span>
            <div>
              <h2 className="display">The edit</h2>
              <p className="lede">In {d.agent}, with cuttingfloor connected</p>
            </div>
          </div>
          <AgentDemo demo={d} />
        </section>

        <section className="cell dm-act" id="after">
          <div className="head">
            <span className="label">03</span>
            <div>
              <h2 className="display">After</h2>
              <p className="lede">Ready to post · {lengths(d)}</p>
            </div>
          </div>
          <div className={v.wide ? 'dm-side wide' : 'dm-side'}>
            <figure className="dm-main">
              <Seek target="finished" />
              <Clip v={v} id="finished" />
              <figcaption>{v.label}</figcaption>
            </figure>
            <div className="dm-notes">
              <h3>What the agent did</h3>
              <ol className="dm-steps">
                {d.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          </div>
          {d.extra?.map((x) => (
            <figure key={x.src} className="dm-extra">
              <Clip v={x} />
              <figcaption>
                <span className="label">{x.caption}</span> {x.label}
              </figcaption>
            </figure>
          ))}
        </section>

        <AgentBlock />

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

function Clip({ v, id }: { v: DemoVideo; id?: string }) {
  return (
    <video
      id={id}
      src={v.src}
      poster={v.poster}
      width={v.wide ? 960 : 540}
      height={v.wide ? 540 : 960}
      controls
      playsInline
      preload="none"
    >
      <track kind="captions" srcLang="en" label="English" src={v.captions} default />
    </video>
  );
}
