import { PACKS, PLANS, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import { Connect } from '../connect.tsx';
import { TryKazi } from '../kazi.tsx';
import type { Account } from '../lib/billing.ts';
import type { Files } from '../lib/files.ts';
import type { ScriptKey } from '../lib/keys.ts';
import type { SavedKey } from '../lib/provider-keys.ts';
import { Prompt } from '../welcome/live.tsx';
import { FilesPanel } from './files.tsx';
import { KeysPanel } from './keys.tsx';
import { ProviderKeysPanel } from './provider-keys.tsx';

// The account page, given everything it shows (page.tsx reads it; preview/ renders fixtures).
// It reads in the order a new person needs it: what they have (the free credits, said plainly),
// the three steps to a first edit with each one ticked off as it happens, then buying more, with
// what a careful buyer looks for before paying: the price per credit, that credits never expire,
// who takes the card, and the refund terms.

export type AccountProps = {
  email: string;
  firstName?: string | null;
  account?: Account;
  /** Why the server won't give the account its credits yet, such as `email_unverified`. */
  refused?: string;
  /** From the WorkOS metadata the server writes on the account's first call, edit and export. */
  progress: { first_call_at?: string; first_edit_at?: string; first_export_at?: string };
  /** Credits just bought, from checkout's return address. */
  bought?: string;
  files?: Files;
  keys?: ScriptKey[];
  providerKeys?: SavedKey[];
  server: string;
};

const FIRST_PROMPT =
  'Use cuttingfloor: import https://cuttingfloor.ai/demo/interview/raw.mp4, cut out the pauses and ums, add captions, and export it as a 9:16 Short.';

const n = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 1 });

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

const height = (shortSide: number | null) =>
  shortSide === null ? 'any size' : shortSide >= 2160 ? '4K' : `${shortSide}p`;

export function AccountView(p: AccountProps) {
  const a = p.account;
  const started = Boolean(p.progress.first_export_at);
  return (
    <main className="frame acct">
      {p.bought ? (
        <p className="acct-banner" role="status">
          <Check /> Payment received: {p.bought} credits added. Thank you.
        </p>
      ) : null}

      <section className="cell marks acct-top">
        <span className="mark-b" />
        <span className="label">Your account{p.firstName ? ` · ${p.firstName}` : ''}</span>
        <h1 className="display acct-head">{headline(a, p.refused, p.firstName)}</h1>
        <p className="lede">{lede(a, p.refused, p.email)}</p>
        {a ? (
          <div className={started ? 'acct-grid solo' : 'acct-grid'}>
            {started ? null : <Steps progress={p.progress} email={p.email} />}
            <Balance account={a} />
          </div>
        ) : null}
      </section>

      {a?.top_up ? <Buy account={a} /> : null}

      {p.files && !p.refused ? (
        <section className="cell" id="files">
          <div className="head">
            <span className="label">Your files</span>
            <p className="lede">
              Your footage, music, logos and photos: drop them here and your AI can use them. Tell
              it the file’s name, for example “cut the pauses out of interview.mp4”.
            </p>
          </div>
          <FilesPanel initial={p.files} />
        </section>
      ) : null}

      {started ? (
        <section className="cell" id="connect">
          <div className="head">
            <span className="label">Connect another app</span>
            <p className="lede">
              Add the address to any AI app and sign in with this same account ({p.email}).
            </p>
          </div>
          <Connect />
        </section>
      ) : null}

      {p.providerKeys ? (
        <section className="cell" id="keys">
          <div className="head">
            <span className="label">Your sync. labs key</span>
            <p className="lede">
              Lip sync runs at sync. labs on your own key, and they bill you for each second sent.
              Get a key at sync.so (Settings, then API keys) and save it here once. It is stored
              encrypted and never shown again.
            </p>
          </div>
          <ProviderKeysPanel initial={p.providerKeys} />
        </section>
      ) : null}

      {p.keys ? (
        <section className="cell" id="api-keys">
          <div className="head">
            <span className="label">API keys</span>
            <p className="lede">
              For your own code or agent, with no browser to sign in. One key works with the REST
              API (<code>POST {p.server}/v1/&lt;tool&gt;</code>, every tool in the{' '}
              <a href={`${p.server}/openapi.json`}>OpenAPI spec</a>) and with MCP. It acts as this
              account, uses its credits, and works for a year or until you revoke it.{' '}
              <a href="/how-to-connect#builders">Ways to connect</a>
            </p>
          </div>
          <KeysPanel initial={p.keys} server={p.server} />
        </section>
      ) : null}

      <section className="cell">
        <p className="account-help">
          Questions about your credits or a charge? Write to{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. <a href="/terms">Terms</a> ·{' '}
          <a href="/refunds">Refunds</a> · <a href="/privacy">Privacy</a>
        </p>
      </section>
    </main>
  );
}

function headline(a: Account | undefined, refused?: string, name?: string | null): string {
  if (refused === 'email_unverified') return 'Check your inbox.';
  if (!a) return 'Your account.';
  if (a.plan === 'staff') return 'Staff account.';
  if (a.credits.renews) return `${a.plan_name}: free for good.`;
  const left = Math.max(0, a.credits.left ?? 0);
  if (left <= 0) return 'You’re out of credits.';
  if (a.plan === 'free' && a.credits.used === 0)
    return `You’re in. ${n(a.credits.free)} free credits are yours.`;
  return name ? `Welcome back, ${name}.` : 'Welcome back.';
}

function lede(a: Account | undefined, refused: string | undefined, email: string): string {
  if (refused === 'email_unverified')
    return `We sent a link to ${email}. Open it to confirm your email (check spam too), then reload this page.`;
  if (!a) return 'Your credits can’t be read just now. Reload in a minute.';
  if (a.plan === 'staff') return 'The team’s own account: no limits.';
  if (a.credits.renews)
    return `${n(a.credits.per_month ?? 0)} credits every month, renewing ${day(a.credits.renews)}. Nothing to pay.`;
  if ((a.credits.left ?? 0) <= 0)
    return 'Editing and previews still work. New exports, imports and transcripts start again once you add credits. Credits you buy never expire.';
  if (a.plan === 'free' && !a.credits.bought)
    return 'No card needed. Three steps to your first edit, about a minute.';
  return 'Credits you buy never expire. Editing and previews are always free.';
}

function Steps({ progress, email }: { progress: AccountProps['progress']; email: string }) {
  const steps = [
    {
      done: Boolean(progress.first_call_at),
      title: 'Add cuttingfloor to your AI',
      body: (
        <>
          <p>Pick your app and paste the address. When it asks you to sign in, use {email}.</p>
          <Connect />
          <TryKazi place="account" label="No AI app? Try it live in Kazi, free" />
        </>
      ),
    },
    {
      done: Boolean(progress.first_edit_at),
      title: 'Ask for an edit',
      body: (
        <>
          <p>
            Paste this to try it on a sample interview, or ask for the edit you want with your own
            video: drop it under <a href="#files">Your files</a> and say its name.
          </p>
          <Prompt text={FIRST_PROMPT} />
        </>
      ),
    },
    {
      done: Boolean(progress.first_export_at),
      title: 'Get your video',
      body: (
        <p>
          Your AI hands back a link to watch and download the finished MP4. Download it to keep it:
          links last a day.
        </p>
      ),
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <ol className="acct-steps" id="connect">
      {steps.map((s, i) => (
        <li key={s.title} className={s.done ? 'done' : i === next ? 'now' : undefined}>
          <span className="acct-step-n" aria-hidden="true">
            {s.done ? <Check /> : i + 1}
          </span>
          <div>
            <h2>
              {s.title}
              {s.done ? <span className="acct-done">Done</span> : null}
            </h2>
            {i === next ? s.body : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Balance({ account: a }: { account: Account }) {
  const c = a.credits;
  if (c.left === null)
    return (
      <aside className="acct-card">
        <span className="label">Credits</span>
        <p className="acct-big">No limit</p>
      </aside>
    );
  const total = c.per_month ?? c.free + c.bought;
  const share = total ? Math.min(1, c.used / total) : 1;
  const low = a.warnings.find((w) => w.kind === 'low')?.at_credits ?? 0;
  const left = Math.max(0, c.left);
  const paid = PLANS.credits.limits;
  return (
    <aside className="acct-card" aria-label="Credits">
      <span className="label">Credits</span>
      <p className="acct-big">
        {n(left)} <small>left</small>
      </p>
      <div
        className={`meter-bar${left <= 0 ? ' full' : left < low ? ' high' : ''}`}
        aria-hidden="true"
      >
        <span style={{ width: `${(1 - share) * 100}%` }} />
      </div>
      <p className="acct-split">
        {c.per_month
          ? `${n(c.used)} of ${n(c.per_month)} used this month`
          : c.bought
            ? `${n(c.free)} free + ${n(c.bought)} bought · ${n(c.used)} used`
            : `${n(c.free)} free, on us · ${n(c.used)} used`}
      </p>
      <dl className="acct-facts">
        <div>
          <dt>A credit</dt>
          <dd>One minute of exporting, importing or transcribing. A short video takes less.</dd>
        </div>
        <div>
          <dt>Free</dt>
          <dd>Editing and previews, always.</dd>
        </div>
        {a.plan === 'free' && a.limits.export_short_side !== paid.shortSide ? (
          <div>
            <dt>Limits</dt>
            <dd>
              Exports up to {height(a.limits.export_short_side)}. Any pack unlocks{' '}
              {height(paid.shortSide)}.
            </dd>
          </div>
        ) : null}
      </dl>
      {a.top_up ? (
        <a className="acct-more" href="#buy">
          Get more credits ↓
        </a>
      ) : null}
    </aside>
  );
}

function Buy({ account: a }: { account: Account }) {
  const top = a.top_up;
  if (!top) return null;
  const saved = top.card_saved;
  const nonce = crypto.randomUUID();
  const cheapest = Math.min(...PACKS.map((p) => p.price / p.credits));
  return (
    <section className="cell" id="buy">
      <div className="head">
        <span className="label">Credits</span>
        <div>
          <h2 className="display">Buy once. Use them whenever.</h2>
          <p className="lede">
            No subscription. Credits never expire. Bigger packs cost less each.
          </p>
        </div>
      </div>
      <div className="acct-packs">
        {PACKS.map((p) => {
          const each = p.price / p.credits;
          const best = each === cheapest;
          return (
            <form
              key={p.id}
              action="/api/checkout"
              method="post"
              className={best ? 'acct-pack best' : 'acct-pack'}
            >
              {best ? <span className="acct-badge">Best value</span> : null}
              <input type="hidden" name="pack" value={p.id} />
              <input type="hidden" name="nonce" value={`${nonce}-${p.id}`} />
              {saved ? <input type="hidden" name="saved" value="1" /> : null}
              <p className="acct-pack-credits">
                {p.credits} <small>credits</small>
              </p>
              <p className="acct-pack-price">${p.price}</p>
              <p className="acct-pack-each">${each.toFixed(2)} a credit</p>
              <button type="submit" className="buy acct-pack-buy" data-track={`Buy: ${p.credits}`}>
                {saved ? `Buy now · $${p.price}` : `Buy ${p.credits} credits`}
              </button>
            </form>
          );
        })}
      </div>
      <ul className="acct-trust">
        <li>
          <Lock />{' '}
          {saved
            ? 'Charged at once to the card you saved with Stripe.'
            : 'Secure checkout by Stripe. We never see your card number.'}
        </li>
        <li>
          <Check /> Unused credits from a pack bought in the last 14 days are refundable.{' '}
          <a href="/refunds">Refund policy</a>
        </li>
        <li>
          <Check />{' '}
          {saved
            ? 'Your card is saved, so buying again is one click.'
            : 'Stripe saves your card at checkout, so next time is one click.'}
        </li>
      </ul>

      {saved ? (
        <div className="acct-auto">
          <form action="/api/top-up" method="post" className="actions top-up">
            {top.automatic && top.pack ? (
              <>
                <p>
                  Automatic top-up is on: when you have fewer than {top.below} credits left, we buy{' '}
                  {top.pack.credits} credits for ${top.pack.price_usd} on your saved card and email
                  you.
                </p>
                <input type="hidden" name="pack" value="" />
                <button type="submit" className="buy quiet">
                  Turn off
                </button>
              </>
            ) : (
              <>
                <label>
                  Never run out: when I have fewer than {top.below} credits, buy{' '}
                  <select name="pack" defaultValue={PACKS[1]?.id}>
                    {PACKS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.credits} credits for ${p.price}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="buy quiet">
                  Turn on automatic top-up
                </button>
              </>
            )}
          </form>
          <form action="/api/portal" method="post" className="actions">
            <button type="submit" className="buy quiet">
              Change card
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function Check() {
  return (
    <svg className="acct-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 8.5l3 3 7-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Lock() {
  return (
    <svg className="acct-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="3"
        y="7"
        width="10"
        height="7"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
