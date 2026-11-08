import { PACKS, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { Connect } from '../connect.tsx';
import { TryKazi } from '../kazi.tsx';
import { type Account, accountOf } from '../lib/billing.ts';
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

const credits = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ bought?: string }>;
}) {
  const { user } = await withAuth({ ensureSignedIn: true });
  const { bought } = await searchParams;
  const [account, files, keys, providerKeys] = await Promise.all([
    accountOf(user.id, Boolean(bought)),
    filesOf(user.id),
    keysOf(user.id),
    providerKeysOf(user.id),
  ]);

  return (
    <>
      <AccountNav email={user.email} />
      <main className="frame">
        <section className="cell marks" id="credits">
          <span className="mark-b" />
          <span className="label">Account</span>
          <h1 className="display account-head">{headline(account)}</h1>
          <p className="lede">{explain(account, bought)}</p>
          {account ? <Meter account={account} /> : null}
          {account?.top_up ? <TopUp account={account} /> : null}
        </section>

        {files ? (
          <section className="cell" id="files">
            <div className="head">
              <span className="label">Upload your files</span>
              <p className="lede">
                Your footage, music, logos and photos: drop them here and your agent can use them.
                Tell it the file’s name, for example “cut the pauses out of interview.mp4”.
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
                It acts as this account, uses its credits, and works for a year or until you revoke
                it.
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
            Questions about your credits or a charge? Write to{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. <a href="/terms">Terms</a> ·{' '}
            <a href="/refunds">Refunds</a> · <a href="/privacy">Privacy</a>
          </p>
        </section>
      </main>
    </>
  );
}

function headline(a: Account | undefined): string {
  if (!a) return 'Your account.';
  if (a.credits.left === null) return `${a.plan_name}.`;
  return `${credits(Math.max(0, a.credits.left))} credits left.`;
}

function explain(a: Account | undefined, bought: string | undefined): string {
  if (!a) return 'Your credits can’t be read just now. Reload in a minute.';
  const thanks = bought ? `Thank you: ${bought} credits added. ` : '';
  if (a.plan === 'staff') return 'The team’s own account: no limits.';
  if (a.credits.renews)
    return `${a.plan_name}: ${credits(a.credits.per_month ?? 0)} credits a month, renewing ${day(a.credits.renews)}. Nothing to pay.`;
  const left = a.credits.left ?? 0;
  if (left <= 0)
    return `${thanks}Your credits are used up. New jobs wait until you top up; editing and previews still work. Credits never expire.`;
  return `${thanks}A credit is one minute of our servers working: an export, an import, a transcript. Editing and previews are free. A short video takes less than one.`;
}

function Meter({ account: a }: { account: Account }) {
  const c = a.credits;
  if (c.left === null) return null;
  const total = c.per_month ?? c.free + c.bought;
  const share = total ? Math.min(1, c.used / total) : 1;
  const low = a.warnings.find((w) => w.kind === 'low')?.at_credits ?? 0;
  return (
    <div className="meter">
      <p className="meter-line">
        <span>
          <strong>{credits(Math.min(c.used, total))}</strong> of {credits(total)} credits used
          {c.per_month
            ? ' this month'
            : c.bought
              ? ` (${credits(c.free)} free, ${credits(c.bought)} bought)`
              : ' (free)'}
        </span>
        {c.renews ? <span className="meter-renews">Renews {day(c.renews)}</span> : null}
      </p>
      <div
        className={`meter-bar${c.left <= 0 ? ' full' : c.left < low ? ' high' : ''}`}
        aria-hidden="true"
      >
        <span style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

function TopUp({ account: a }: { account: Account }) {
  const top = a.top_up;
  if (!top) return null;
  const saved = top.card_saved;
  const nonce = crypto.randomUUID();
  return (
    <>
      <div className="plans">
        {PACKS.map((p) => (
          <div className="plan" key={p.id}>
            <h2 className="tier">{p.credits} credits</h2>
            <p>${(p.price / p.credits).toFixed(2)} a credit. Never expire.</p>
            <div className="plan-buttons">
              <form action="/api/checkout" method="post">
                <input type="hidden" name="pack" value={p.id} />
                <input type="hidden" name="nonce" value={`${nonce}-${p.id}`} />
                {saved ? <input type="hidden" name="saved" value="1" /> : null}
                <button type="submit" className="buy">
                  {saved ? `Buy for $${p.price}` : `$${p.price}`}
                </button>
              </form>
            </div>
          </div>
        ))}
      </div>
      <p className="meter-note">
        {saved
          ? 'One click: your saved card is charged at once and the credits are yours.'
          : 'Your card is saved at checkout, so the next top-up is one click.'}
      </p>
      <form action="/api/top-up" method="post" className="actions top-up">
        {top.automatic && top.pack ? (
          <>
            <p>
              Automatic top-up is on: when you have fewer than {top.below} credits left, we buy{' '}
              {top.pack.credits} credits for ${top.pack.price_usd} on your saved card and email you
              the receipt.
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
              <select name="pack" defaultValue={PACKS[1]?.id} disabled={!saved}>
                {PACKS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.credits} credits for ${p.price}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="buy quiet" disabled={!saved}>
              Turn on automatic top-up
            </button>
            {saved ? null : <p className="meter-note">Buy a pack once to save your card first.</p>}
          </>
        )}
      </form>
      {saved ? (
        <form action="/api/portal" method="post" className="actions">
          <button type="submit" className="link-big as-button">
            Change card or see receipts
          </button>
        </form>
      ) : null}
    </>
  );
}
