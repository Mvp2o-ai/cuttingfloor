import { PLANS, TRIAL_DAYS } from '@cuttingfloor/plans';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { AccountNav } from '../account/chrome.tsx';
import { Connect } from '../connect.tsx';
import { accountOf } from '../lib/billing.ts';
import { FirstCall, Prompt } from './live.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Welcome — cuttingfloor', robots: { index: false } };

const FIRST_PROMPT =
  'Use cuttingfloor: import https://cuttingfloor.ai/demo/interview/raw.mp4, cut out the pauses and ums, add captions, and export it as a 9:16 Short.';

// After sign-up: connect the agent, paste a first prompt, and see the first call arrive.
export default async function Welcome() {
  const { user } = await withAuth({ ensureSignedIn: true });
  const { status, metadata } = await accountOf(user.id);
  const trial = status.kind === 'trial';

  return (
    <>
      <AccountNav email={user.email} />
      <main className="frame">
        <section className="cell marks">
          <span className="mark-b" />
          <span className="label">Welcome{user.firstName ? `, ${user.firstName}` : ''}</span>
          <h1 className="display account-head">Connect your agent.</h1>
          <p className="lede">
            {trial
              ? `Your trial is on: ${TRIAL_DAYS} days and ${PLANS.trial.limits.renderMinutes} render minutes, no card. `
              : ''}
            Three steps, about a minute.
          </p>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">1 / Add the server</span>
            <p className="lede">
              Pick your agent and follow its one step. When it asks you to sign in, use this same
              account ({user.email}).
            </p>
          </div>
          <Connect />
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">2 / Ask for an edit</span>
            <p className="lede">
              Paste this into your agent. It edits a sample interview, so you see a finished cut
              before you bring your own footage.
            </p>
          </div>
          <Prompt text={FIRST_PROMPT} />
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">3 / Watch it connect</span>
          </div>
          <FirstCall
            initial={{
              first_call_at: metadata.first_call_at ?? null,
              first_export_at: metadata.first_export_at ?? null,
            }}
          />
          <p className="account-help">
            Plans, usage and billing are on <a href="/account">your account page</a>.
          </p>
        </section>
      </main>
    </>
  );
}
