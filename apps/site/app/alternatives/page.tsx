import type { Metadata } from 'next';
import { DEMOS, finished, lengths } from '../../content/demos.ts';
import { Connect } from '../connect.tsx';
import { Poster } from '../demos/poster.tsx';
import { Breadcrumbs, Footer, JsonLd, Nav, SIGN_UP } from '../shell.tsx';

// For people who edit in CapCut, Descript, VEED, Kapwing and editing software like them, and search for
// something better. The names are there so the page is found; it compares, it claims no tie.

const TITLE = 'AI video editor your agent runs: a CapCut, Descript and VEED alternative';
const DESCRIPTION =
  'You bring the taste, your agent brings the skill of a professional editor. Connect Claude, ChatGPT or Cursor to cuttingfloor, say what you want, and get the finished video back. An alternative to CapCut, Descript, VEED and Kapwing.';

export const metadata: Metadata = {
  title: `${TITLE} | cuttingfloor`,
  description: DESCRIPTION,
  alternates: { canonical: '/alternatives' },
  openGraph: { type: 'article', url: '/alternatives', title: TITLE, description: DESCRIPTION },
};

// The jobs people open editing software for, in the words they would say to their agent.
const JOBS: { job: string; say: string; demo?: string }[] = [
  {
    job: 'Pauses and restarts',
    say: 'Cut my pauses, ums and false starts.',
    demo: 'remove-pauses-and-restarts-from-a-talking-video',
  },
  {
    job: 'Best take',
    say: 'I recorded it three times. Keep the best one.',
    demo: 'pick-your-best-take-with-ai',
  },
  {
    job: 'Beat sync',
    say: 'Cut it to the beat of the song.',
    demo: 'edit-a-dance-short-to-the-beat',
  },
  { job: 'Captions', say: 'Big captions, highlight each word as I say it.' },
  {
    job: 'Interviews',
    say: 'Cut between us when each person talks.',
    demo: 'edit-a-two-person-interview',
  },
  {
    job: 'Voiceover',
    say: 'Add a calm voiceover that walks through each room.',
    demo: 'edit-a-real-estate-listing-video',
  },
  {
    job: 'Talking head',
    say: 'Put a presenter in the corner of my explainer.',
    demo: 'add-a-talking-head-to-your-explainer-video',
  },
  { job: 'Background removal', say: 'Take me out of the background and put me over the product.' },
  { job: 'Speed and zoom', say: 'Slow motion on the jump, punch in on the reveal.' },
  { job: 'Look and color', say: 'Warmer, with a soft vignette.' },
  { job: 'Shaky footage', say: 'Steady the handheld shot.' },
  { job: 'Voice and music', say: 'Pull my voice off the music and bring the music down under it.' },
  { job: 'Every size', say: 'A vertical one for Reels and a square one for LinkedIn.' },
];

const SHOWN = [
  'remove-pauses-and-restarts-from-a-talking-video',
  'edit-a-dance-short-to-the-beat',
  'edit-a-product-review-short',
];

const FAQS = [
  {
    q: 'Is there an AI that edits videos for you?',
    a: 'Yes. Connect cuttingfloor to Claude, ChatGPT, Cursor or Kazi and describe the video you want. Your agent does the editing and sends back a finished MP4.',
  },
  {
    q: 'Do I need to know how to edit?',
    a: 'No. Know how you want it to look and feel, and who it is for. Your agent knows the craft: where to cut, how long to hold a shot, how loud the music should sit under a voice.',
  },
  {
    q: 'Do I still need CapCut or Descript?',
    a: 'Not to finish a video. You get a normal MP4. If you like doing a last pass by hand, open it in any editor you already use.',
  },
  {
    q: 'Is it like Opus Clip?',
    a: 'It can pull short clips out of a long video, and it also edits the whole thing: cuts, captions, sound, graphics and voiceover, in whatever shape you ask for.',
  },
  {
    q: 'How do I change something I do not like?',
    a: 'Say so, the way you would to an editor. "Tighter in the middle." "Lose the second joke." Earlier versions stay, so going back is one sentence too.',
  },
  {
    q: 'What does it cost?',
    a: 'Start free for three days. After that you pay for rendering minutes, with a plan price you never go over. See pricing on the home page.',
  },
];

export default function Alternatives() {
  const shown = SHOWN.flatMap((slug) => DEMOS.filter((d) => d.slug === slug));
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: FAQS.map((f) => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: { '@type': 'Answer', text: f.a },
          })),
        }}
      />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Alternatives', href: '/alternatives' }]} />
          <span className="label">The future of video editing</span>
          <h1 className="display">You bring the taste. Your agent does the editing.</h1>
          <p className="lede wt-answer">
            Your agent edits with the judgment of a professional: what to keep, where to cut, when
            the music should hit. You decide how it should feel and what it is for. It does the
            heavy lifting and hands back the finished video.{' '}
            <em>
              CapCut, Descript, VEED and Kapwing put the tools in your hands. cuttingfloor puts them
              in your agent's.
            </em>
          </p>
          <div className="actions">
            <a className="link-big" href={SIGN_UP}>
              Start free for 3 days
            </a>
            <a className="link-big quiet" href="/demos">
              Watch it edit
            </a>
          </div>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">01 / Who does what</span>
            <h2 className="display">You direct. It edits.</h2>
          </div>
          <ol className="ledger">
            <li>
              <span className="n">01</span>
              <h3>You set the outcome.</h3>
              <p>
                “A 30-second teaser for TikTok. Punchy, big captions, end on the laugh.” That is the
                whole brief.
              </p>
            </li>
            <li>
              <span className="n">02</span>
              <h3>Your agent edits like a pro.</h3>
              <p>
                It listens to every take, finds the moments worth keeping, cuts them together,
                captions them, levels the sound and checks its own work.
              </p>
            </li>
            <li>
              <span className="n">03</span>
              <h3>You make the call.</h3>
              <p>
                Watch the cut and give notes like you would to an editor: “tighter in the middle,”
                “warmer color.” It changes it and shows you again.
              </p>
            </li>
          </ol>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">02 / The work</span>
            <div>
              <h2 className="display">Everything you open editing software for.</h2>
              <p className="compare-lede">Said in a sentence instead of an afternoon of clicks.</p>
            </div>
          </div>
          <table className="compare-table">
            <thead>
              <tr>
                <th>The job</th>
                <th>What you say</th>
                <th>See it</th>
              </tr>
            </thead>
            <tbody>
              {JOBS.map((j) => (
                <tr key={j.job}>
                  <td className="tier">{j.job}</td>
                  <td>“{j.say}”</td>
                  <td className="note">
                    {j.demo ? <a href={`/demos/${j.demo}`}>Watch the demo</a> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">03 / Why your agent</span>
            <h2 className="display">Why your agent beats traditional editing software.</h2>
          </div>
          <ol className="ledger">
            <li>
              <span className="n">01</span>
              <h3>Nothing to learn.</h3>
              <p>
                No timeline, no keyframes, no menus. You describe the result and your agent works
                out the steps.
              </p>
            </li>
            <li>
              <span className="n">02</span>
              <h3>It checks its own work.</h3>
              <p>
                Every edit comes back with a picture of the frame and the sound measured, so your
                agent sees what it made before you do.
              </p>
            </li>
            <li>
              <span className="n">03</span>
              <h3>It lives where you already work.</h3>
              <p>
                Claude, ChatGPT, Cursor or Kazi. The same chat you have open now becomes your
                editing room.
              </p>
            </li>
          </ol>
        </section>

        <section className="cell paper">
          <div className="wt-prose">
            <section>
              <h2>What it does not do yet</h2>
              <p>
                There is no template library, no stock music or stickers, and no timeline to drag
                clips around by hand. If you want to move every clip yourself, traditional editing
                software is still the better tool. If you want the video made, hand it to your
                agent.
              </p>
            </section>
          </div>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">04 / Watch</span>
            <h2 className="display">Real clips, real agents.</h2>
          </div>
          <ol className="wt-hub dm-hub">
            {shown.map((d) => (
              <li key={d.slug}>
                <a href={`/demos/${d.slug}`}>
                  <span className="dm-ba">
                    <Poster v={d.raw} tag="Before" />
                    <span className="dm-arrow" aria-hidden="true">
                      →
                    </span>
                    <Poster v={finished(d)} tag="After" />
                  </span>
                  <h3>{d.title}</h3>
                  <p>{d.description}</p>
                  <span className="wt-hub-meta">
                    {d.agent} · {lengths(d)}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </section>

        <section className="cell" id="start">
          <div className="head">
            <span className="label">05 / Start</span>
            <h2 className="display">Connect your agent.</h2>
          </div>
          <div className="start-connect">
            <p className="label">Your agent’s setup</p>
            <Connect />
          </div>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">06 / Questions</span>
            <h2 className="display">Asked.</h2>
          </div>
          <div className="faq">
            {FAQS.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <Footer />
      </main>
    </>
  );
}
