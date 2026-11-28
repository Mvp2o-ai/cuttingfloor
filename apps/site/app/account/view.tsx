import { PACKS, PLANS, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import type { ReactNode } from 'react';
import { AppPage, Badge, Card, Details } from '../app-ui.tsx';
import { Connect } from '../connect.tsx';
import { TryKazi } from '../kazi.tsx';
import type { Account } from '../lib/billing.ts';
import type { Files } from '../lib/files.ts';
import type { ScriptKey } from '../lib/keys.ts';
import type { SavedKey } from '../lib/provider-keys.ts';
import { SHORT_CREDITS, SHORT_SECONDS } from '../pricing.ts';
import { Prompt } from '../welcome/live.tsx';
import { FilesPanel } from './files.tsx';
import { KeysPanel } from './keys.tsx';
import { ProviderKeysPanel } from './provider-keys.tsx';

// The account page, given everything it shows (page.tsx reads it; preview/ renders fixtures).
// It reads in the order a new person needs it: what they have (free making, and the credits for
// removing the watermark, said plainly),
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
  /** Only for an admin (the server's rights table): keys for the admin API. */
  adminKeys?: ScriptKey[];
  providerKeys?: SavedKey[];
  /** Whether the account gets an email before its files go (on unless turned off). */
  expiryEmails: boolean;
  server: string;
};

const FIRST_PROMPT =
  'Use cuttingfloor: import https://cuttingfloor.ai/demo/interview/raw.mp4, cut out the pauses and ums, add captions, and export it as a 9:16 Short.';

const n = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

const height = (shortSide: number | null) =>
  shortSide === null ? 'any size' : shortSide >= 2160 ? '4K' : `${shortSide}p`;

export function AccountView(p: AccountProps & { nav: ReactNode }) {
  const a = p.account;
  const started = Boolean(p.progress.first_export_at);
  return (
    <AppPage nav={p.nav} title="Account" sub={p.email}>
      {p.bought ? (
        <Card tone="key">
          <p className="app-notice" role="status">
            <Check /> Payment received: {p.bought} credits added. Thank you.
          </p>
        </Card>
      ) : null}

      <Card tone={p.refused || !a || (a.credits.left ?? 1) <= 0 ? undefined : 'key'}>
        <div className="app-card-head">
          <h2>{headline(a, p.refused, p.firstName)}</h2>
          {a?.top_up ? (
            <a className="app-btn" href="#buy">
              Buy credits
            </a>
          ) : null}
        </div>
        <p className="app-card-desc">{lede(a, p.refused, p.email)}</p>
        {a ? <Balance account={a} /> : null}
      </Card>

      {a && !started ? (
        <Card
          id="connect"
          title="Get started"
          desc="Three steps to your first edit, about a minute."
        >
          <Steps progress={p.progress} email={p.email} />
        </Card>
      ) : null}

      {a?.top_up ? <Buy account={a} /> : null}

      {p.files && !p.refused ? (
        <Card
          id="files"
          title="Your files"
          desc="Your footage, music, logos and photos: drop them here and your AI can use them. Tell it the file’s name, for example “cut the pauses out of interview.mp4”."
        >
          <FilesPanel initial={p.files} />
        </Card>
      ) : null}

      {started ? (
        <Card
          id="connect"
          title="Connect another app"
          desc={`Add the address to any AI app and sign in with this same account (${p.email}).`}
        >
          <Connect />
        </Card>
      ) : null}

      {p.keys ? (
        <Card
          id="api-keys"
          title="API keys"
          desc={
            <>
              For your own code or agent, with no browser to sign in. One key works with the REST
              API (<code>POST {p.server}/v1/&lt;tool&gt;</code>, every tool in the{' '}
              <a href={`${p.server}/openapi.json`}>OpenAPI spec</a>) and with MCP. It acts as this
              account, uses its credits, and works for a year or until you revoke it.{' '}
              <a href="/how-to-connect#builders">Ways to connect</a>
            </>
          }
        >
          <KeysPanel initial={p.keys} />
        </Card>
      ) : null}

      {p.providerKeys ? (
        <Card
          id="keys"
          title="Your sync. labs key"
          desc="Lip sync runs at sync. labs on your own key, and they bill you for each second sent. Get a key at sync.so (Settings, then API keys) and save it here once. It is stored encrypted and never shown again."
        >
          <ProviderKeysPanel initial={p.providerKeys} />
        </Card>
      ) : null}

      {p.adminKeys ? (
        <Card
          id="admin-api"
          title="Admin API"
          action={
            <a className="app-btn" href="/admin">
              Open staff pages
            </a>
          }
          desc={
            <>
              You are a cuttingfloor admin. An admin key reads every account through the admin API (
              <code>GET {p.server}/admin/v1/accounts</code>, described in its{' '}
              <a href={`${p.server}/admin/v1/openapi.json`}>OpenAPI spec</a>), for a CRM or your own
              scripts. It works for a year, until you revoke it, or until you are no longer an
              admin.
            </>
          }
        >
          <KeysPanel initial={p.adminKeys} kind="admin" />
        </Card>
      ) : null}

      <Card id="notifications" title="Email">
        <ul className="app-rows">
          <li>
            <div>
              <div className="app-row-title">File reminders</div>
              <div className="app-row-meta">
                {p.expiryEmails
                  ? 'We email you 3 days and 1 day before your files and exports are deleted.'
                  : 'We don’t email you before your files and exports are deleted.'}
              </div>
            </div>
            <div className="app-row-end">
              {p.expiryEmails ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
              <form action="/api/notifications" method="post">
                <input type="hidden" name="on" value={p.expiryEmails ? '' : '1'} />
                <button type="submit" className="app-btn">
                  {p.expiryEmails ? 'Turn off' : 'Turn on'}
                </button>
              </form>
            </div>
          </li>
        </ul>
      </Card>

      <p className="account-help">
        Questions about your credits or a charge? Write to{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. <a href="/terms">Terms</a> ·{' '}
        <a href="/refunds">Refunds</a> · <a href="/privacy">Privacy</a>
      </p>
    </AppPage>
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
    return 'Making still works, and every export downloads free with a cuttingfloor watermark. Removing watermarks waits until you add credits. Credits you buy never expire.';
  if (a.plan === 'free' && !a.credits.bought)
    return 'Making is free, no card needed. Three steps to your first edit, about a minute.';
  return 'Making is always free. Credits remove the cuttingfloor watermark from finished files, and never expire.';
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
          links last 7 days.
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
            <h3>
              {s.title}
              {s.done ? <Badge tone="ok">Done</Badge> : null}
            </h3>
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
      <div className="app-balance">
        <strong>No limit</strong>
      </div>
    );
  const total = c.per_month ?? c.free + c.bought;
  const share = total ? Math.min(1, c.used / total) : 1;
  const low = a.warnings.find((w) => w.kind === 'low')?.at_credits ?? 0;
  const left = Math.max(0, c.left);
  const paid = PLANS.credits.limits;
  return (
    <div>
      <div className="app-balance">
        <strong>{n(left)}</strong>
        <span>credits left</span>
      </div>
      <div
        className={`meter-bar${left <= 0 ? ' full' : left < low ? ' high' : ''}`}
        aria-hidden="true"
      >
        <span style={{ width: `${(1 - share) * 100}%` }} />
      </div>
      <p className="app-split">
        {c.per_month
          ? `${n(c.used)} of ${n(c.per_month)} used this month`
          : c.bought
            ? `${n(c.free)} free + ${n(c.bought)} bought · ${n(c.used)} used`
            : `${n(c.free)} free, on us · ${n(c.used)} used`}
      </p>
      <Details
        rows={[
          [
            'What a credit does',
            `Removes the watermark, priced by each video's length. A ${SHORT_SECONDS}-second Short is ${SHORT_CREDITS}.`,
          ],
          [
            'Free',
            'Making: editing, exports, graphics and voiceovers, and downloads with the watermark.',
          ],
          ...(a.plan === 'free' && a.limits.export_short_side !== paid.shortSide
            ? ([
                [
                  'Limits',
                  `Exports up to ${height(a.limits.export_short_side)}. Any pack unlocks ${height(paid.shortSide)}.`,
                ],
              ] as Array<[string, string]>)
            : []),
        ]}
      />
    </div>
  );
}

function Buy({ account: a }: { account: Account }) {
  const top = a.top_up;
  if (!top) return null;
  const saved = top.card_saved;
  const nonce = crypto.randomUUID();
  const cheapest = Math.min(...PACKS.map((p) => p.price / p.credits));
  return (
    <Card
      id="buy"
      title="Buy credits"
      desc="No subscription. Credits never expire. Bigger packs cost less each."
    >
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
    </Card>
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
