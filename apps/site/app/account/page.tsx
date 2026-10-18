import { signOut, withAuth } from '@workos-inc/authkit-nextjs';
import { Connect } from '../connect.tsx';
import { type Status, statusOf } from '../lib/billing.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Account — cuttingfloor' };

const PLAN_NAMES: Record<string, string> = {
  admin: 'Admin',
  lifetime: 'Lifetime',
  creator: 'Creator',
  pro: 'Pro',
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

export default async function Account({
  searchParams,
}: {
  searchParams: Promise<{ subscribed?: string }>;
}) {
  const { user } = await withAuth({ ensureSignedIn: true });
  const status = await statusOf(user.id);
  const { subscribed } = await searchParams;

  return (
    <>
      <header className="nav">
        <div className="nav-inner">
          <a className="wordmark" href="/">
            <span className="marker" aria-hidden="true" />
            cuttingfloor
          </a>
          <nav className="nav-links" aria-label="Account">
            <span className="account-email">{user.email}</span>
          </nav>
          <form
            action={async () => {
              'use server';
              await signOut({ returnTo: '/' });
            }}
          >
            <button type="submit" className="nav-cta as-button">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="frame">
        <section className="cell marks">
          <span className="mark-b" />
          <span className="label">Account</span>
          <h1 className="display account-head">{headline(status)}</h1>
          <p className="lede">{explain(status, subscribed === '1')}</p>
          <Billing status={status} />
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">Connect</span>
            <p className="lede">
              Add the address to your agent and sign in with this same account. Its tools follow
              your plan.
            </p>
          </div>
          <Connect />
        </section>
      </main>
    </>
  );
}

function headline(s: Status): string {
  switch (s.kind) {
    case 'comped':
      return `${PLAN_NAMES[s.plan]}.`;
    case 'subscribed':
      return `${PLAN_NAMES[s.plan] ?? s.plan}.`;
    case 'trial':
      return 'On the trial.';
    case 'expired':
      return 'Trial over.';
  }
}

function explain(s: Status, justSubscribed: boolean): string {
  switch (s.kind) {
    case 'comped':
      return 'Free for good, everything included. Nothing to pay.';
    case 'subscribed':
      if (s.status === 'past_due')
        return 'Your last payment didn’t go through. Update the card to keep working.';
      return `${justSubscribed ? 'Thank you. ' : ''}Billed ${s.interval === 'year' ? 'yearly' : 'monthly'}${s.renews ? `; ${s.cancels ? 'ends' : 'renews'} ${day(s.renews)}` : ''}.`;
    case 'trial':
      return `Everything works until ${day(s.ends)}. Subscribe now or when it ends; your work carries over.`;
    case 'expired':
      return `The trial ended ${day(s.ended)}. Pick a plan and your agent picks up where it left off.`;
  }
}

function Billing({ status }: { status: Status }) {
  if (status.kind === 'comped') return null;
  if (status.kind === 'subscribed')
    return (
      <form action="/api/portal" method="post" className="actions">
        <button type="submit" className="link-big as-button">
          Manage billing
        </button>
      </form>
    );
  return (
    <div className="plans">
      {[
        {
          key: 'creator',
          name: 'Creator',
          month: '$49',
          year: '$490',
          what: '300 render min a month',
        },
        { key: 'pro', name: 'Pro', month: '$99', year: '$990', what: '900 render min a month, 4K' },
      ].map((p) => (
        <div className="plan" key={p.key}>
          <h2 className="tier">{p.name}</h2>
          <p>{p.what}</p>
          <div className="plan-buttons">
            <form action="/api/checkout" method="post">
              <input type="hidden" name="plan" value={`cf_${p.key}_month`} />
              <button type="submit" className="buy">
                {p.month} / month
              </button>
            </form>
            <form action="/api/checkout" method="post">
              <input type="hidden" name="plan" value={`cf_${p.key}_year`} />
              <button type="submit" className="buy quiet">
                {p.year} / year
              </button>
            </form>
          </div>
        </div>
      ))}
    </div>
  );
}
