import { PLANS, type PlanId, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { Connect } from '../connect.tsx';
import { TryKazi } from '../kazi.tsx';
import { accountOf, type Status, type Usage, usageOf } from '../lib/billing.ts';
import { filesOf } from '../lib/files.ts';
import { keysOf } from '../lib/keys.ts';
import { providerKeysOf } from '../lib/provider-keys.ts';
import { AccountNav } from './chrome.tsx';
import { FilesPanel } from './files.tsx';
import { KeysPanel } from './keys.tsx';
import { ProviderKeysPanel } from './provider-keys.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Account — cuttingfloor', robots: { index: false } };

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

export default async function Account({
  searchParams,
}: {
  searchParams: Promise<{ subscribed?: string }>;
}) {
  const { user } = await withAuth({ ensureSignedIn: true });
  const [{ status }, usage, files, keys, providerKeys] = await Promise.all([
    accountOf(user.id),
    usageOf(user.id),
    filesOf(user.id),
    keysOf(user.id),
    providerKeysOf(user.id),
  ]);
  const { subscribed } = await searchParams;
  const plan = planOf(status);

  return (
    <>
      <AccountNav email={user.email} />
      <main className="frame">
        <section className="cell marks">
          <span className="mark-b" />
          <span className="label">Account</span>
          <h1 className="display account-head">{headline(status)}</h1>
          <p className="lede">{explain(status, subscribed === '1')}</p>
          {usage && plan ? <Meter usage={usage} plan={plan} /> : null}
          {plan ? <Limits plan={plan} /> : null}
          <Billing status={status} />
        </section>

        {files ? (
          <section className="cell">
            <div className="head">
              <span className="label">Files</span>
              <p className="lede">
                Files on this computer your agent can’t reach? Drop them here, then tell your agent
                which ones to use by name.
              </p>
            </div>
            <FilesPanel initial={files} />
          </section>
        ) : null}

        <section className="cell">
          <div className="head">
            <span className="label">Connect</span>
            <p className="lede">
              Add the address to your agent and sign in with this same account. Step by step, with a
              first prompt to try: <a href="/welcome">the welcome page</a>.
            </p>
          </div>
          <Connect />
          <TryKazi place="account" label="No agent yet? Try it live in Kazi, free" />
        </section>

        {providerKeys ? (
          <section className="cell" id="keys">
            <div className="head">
              <span className="label">Your sync. labs key</span>
              <p className="lede">
                Lip sync runs at sync. labs on your own key, and they bill you for each second sent.
                Get a key at sync.so (Settings, then API keys) and save it here once. It is stored
                encrypted and never shown again.
              </p>
            </div>
            <ProviderKeysPanel initial={providerKeys} />
          </section>
        ) : null}

        {keys ? (
          <section className="cell">
            <div className="head">
              <span className="label">Keys for scripts</span>
              <p className="lede">
                A script that calls cuttingfloor on its own, with no browser to sign in, uses a key.
                It acts as this account, on this plan, and works for a year or until you revoke it.
              </p>
            </div>
            <KeysPanel
              initial={keys}
              server={process.env.CUTTINGFLOOR_SERVER_URL ?? 'https://api.cuttingfloor.ai'}
            />
          </section>
        ) : null}

        <section className="cell">
          <p className="account-help">
            Questions about your plan or a charge? Write to{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. <a href="/terms">Terms</a> ·{' '}
            <a href="/refunds">Refunds</a> · <a href="/privacy">Privacy</a>
          </p>
        </section>
      </main>
    </>
  );
}

/** The plan whose limits apply now; none once access has ended. */
function planOf(s: Status): PlanId | undefined {
  if (s.kind === 'given' || s.kind === 'subscribed') return s.plan;
  if (s.kind === 'free') return 'free';
  return undefined;
}

function headline(s: Status): string {
  switch (s.kind) {
    case 'given':
    case 'subscribed':
      return `${PLANS[s.plan].name}.`;
    case 'free':
      return 'On the free plan.';
    case 'lapsed':
      return 'Paused.';
  }
}

function explain(s: Status, justSubscribed: boolean): string {
  switch (s.kind) {
    case 'given':
      if (s.plan === 'staff') return 'The team’s own account: no limits.';
      if (s.plan === 'lifetime') return 'Pro, for good. Nothing to pay.';
      return `Your team’s plan. To change it, write to ${SUPPORT_EMAIL}.`;
    case 'subscribed':
      if (s.status === 'past_due')
        return `Your last payment didn’t go through. Your agent keeps working until ${s.graceEnds ? day(s.graceEnds) : 'Stripe’s last retry'}; update the card to keep it that way.`;
      return `${justSubscribed ? 'Thank you. ' : ''}Billed ${s.interval === 'year' ? 'yearly' : 'monthly'}${s.renews ? `; ${s.cancels ? 'ends' : 'renews'} ${day(s.renews)}` : ''}.`;
    case 'free':
      return `Every tool, with ${PLANS.free.limits.renderMinutes} free credits and no time limit. Pick a plan when you want more; your work carries over.`;
    case 'lapsed':
      return `The last payment didn’t go through, and access paused on ${day(s.ended)}. Update the card and your agent picks up where it left off.`;
  }
}

function Meter({ usage, plan }: { usage: Usage; plan: PlanId }) {
  const included = usage.included_minutes;
  const used = Math.min(usage.used_minutes, included ?? usage.used_minutes);
  const share = included ? Math.min(1, usage.used_minutes / included) : 0;
  const free = plan === 'free';
  return (
    <div className="meter">
      <p className="meter-line">
        <span>
          <strong>{Math.round(used).toLocaleString('en-US')}</strong>
          {included === null
            ? ' credits this month'
            : ` of ${included.toLocaleString('en-US')} ${free ? 'free ' : ''}credits used`}
        </span>
        {free ? null : <span className="meter-renews">Credits renew {day(usage.period.end)}</span>}
      </p>
      {included === null ? null : (
        <div
          className={`meter-bar${share >= 1 ? ' full' : share >= 0.8 ? ' high' : ''}`}
          aria-hidden="true"
        >
          <span style={{ width: `${share * 100}%` }} />
        </div>
      )}
      {share >= 1 ? (
        <p className="meter-note">
          {free
            ? 'New jobs wait until you pick a plan. Editing and previews still work.'
            : 'New jobs wait until the credits renew. Editing and previews still work.'}
          {plan === 'creator' ? ' A bigger plan adds credits now.' : ''}
        </p>
      ) : null}
    </div>
  );
}

function Limits({ plan }: { plan: PlanId }) {
  const l = PLANS[plan].limits;
  const items = [
    l.jobs === null
      ? 'No limit on jobs at once'
      : `${l.jobs} job${l.jobs === 1 ? '' : 's'} at once`,
    l.shortSide === null
      ? 'Exports at any size'
      : `Exports up to ${l.shortSide >= 2160 ? '4K' : `${l.shortSide}p`}`,
    l.judgmentsPerDay === null
      ? 'Frame checks without a daily cap'
      : `${l.judgmentsPerDay.toLocaleString('en-US')} frame checks a day`,
    l.storageGb === null
      ? 'Storage without a cap'
      : `${l.storageGb.toLocaleString('en-US')} GB of storage`,
  ];
  return (
    <ul className="plan-limits">
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

function Billing({ status }: { status: Status }) {
  if (status.kind === 'given') return null;
  if (status.kind === 'subscribed' || status.kind === 'lapsed')
    return (
      <form action="/api/portal" method="post" className="actions">
        <button type="submit" className="link-big as-button">
          {status.kind === 'lapsed' || status.status === 'past_due'
            ? 'Update your card'
            : 'Manage billing'}
        </button>
      </form>
    );
  return (
    <div className="plans">
      {(['creator', 'pro'] as const).map((id) => {
        const p = PLANS[id];
        const l = p.limits;
        return (
          <div className="plan" key={id}>
            <h2 className="tier">{p.name}</h2>
            <p>
              {l.renderMinutes} credits a month. {p.note}
            </p>
            <div className="plan-buttons">
              <form action="/api/checkout" method="post">
                <input type="hidden" name="plan" value={`cf_${id}_month`} />
                <button type="submit" className="buy">
                  ${p.price?.month} / month
                </button>
              </form>
              <form action="/api/checkout" method="post">
                <input type="hidden" name="plan" value={`cf_${id}_year`} />
                <button type="submit" className="buy quiet">
                  ${p.price?.year} / year
                </button>
              </form>
            </div>
          </div>
        );
      })}
      <div className="plan">
        <h2 className="tier">{PLANS.enterprise.name}</h2>
        <p>{PLANS.enterprise.note}</p>
        <div className="plan-buttons">
          <a
            className="buy quiet"
            href={`mailto:${SUPPORT_EMAIL}?subject=cuttingfloor%20Enterprise`}
          >
            Talk to us
          </a>
        </div>
      </div>
    </div>
  );
}
