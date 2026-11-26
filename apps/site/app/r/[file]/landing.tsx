import { DEMOS } from '../../../content/demos.ts';
import { DemoCards } from '../../demos/cards.tsx';
import { LiveCard } from '../../live-card.tsx';
import { Check, Footer, Nav, SIGN_UP } from '../../shell.tsx';

// Where a person's link (/r/<code>) lands: someone who watched a video made with cuttingfloor, or
// was sent the link, and has no agent open yet. The proxy has already kept the code for the
// sign-up; the page shows what cuttingfloor makes and how to start. It names no one: the code is
// the only thing about the person who shared it, and it isn't shown.
export function ReferralLanding() {
  return (
    <>
      <Nav />
      <main className="frame">
        <section className="cell hero marks">
          <span className="mark-b" />
          <h1 className="display title">
            Made with cuttingfloor.
            <Check />
          </h1>
          <div className="hero-row">
            <div>
              <p className="lede">
                Ask your AI assistant for the video you want.{' '}
                <em>
                  It cuts, captions and mixes your clips with cuttingfloor, in Kazi, ChatGPT or
                  Claude, and hands back a file ready to post.
                </em>
              </p>
              <div className="actions">
                <a className="link-big" href={SIGN_UP} data-track="Referral: start">
                  Start free
                </a>
                <a className="link-big quiet" href="/demos">
                  Watch it edit
                </a>
              </div>
            </div>
            <div className="hero-live">
              <LiveCard />
            </div>
          </div>
        </section>
        <section className="cell" aria-label="Before and after">
          <div className="head">
            <span className="label">What it makes</span>
            <div>
              <h2 className="display">Real clips, edited by asking.</h2>
              <p className="compare-lede">
                A creator’s own ChatGPT, Claude or Kazi, with cuttingfloor connected. Tap one to see
                what they asked for and every step.
              </p>
            </div>
          </div>
          <DemoCards demos={DEMOS} />
        </section>
        <Footer />
      </main>
    </>
  );
}
