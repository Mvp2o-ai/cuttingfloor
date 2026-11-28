import { ADMIN_SORTS } from '@cuttingfloor/schema';
import type { ReactNode } from 'react';
import { AppPage, Badge, Card, Details } from '../app-ui.tsx';
import {
  type AdminAccount,
  type AdminAccountList,
  type AdminLedger,
  type AdminSort,
  clients,
  exportsOf,
  kaziFact,
} from '../lib/admin.ts';
import { AdjustForm } from './adjust-form.tsx';

// The staff pages' views, given what they show (page.tsx files read it from the admin API;
// preview/ renders fixtures), in the app look: a card per part, plain tables inside.

const SORT_NAMES: Record<AdminSort, string> = {
  newest: 'Newest',
  last_active: 'Last active',
  credits: 'Credits',
  exports: 'Exports',
};

const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      })
    : '—';

const day = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '—';

const n = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 3 });

const signed = (v: number) => `${v > 0 ? '+' : ''}${n(v)}`;

function href(q: string, sort: AdminSort, page = 1) {
  const p = new URLSearchParams({
    ...(q ? { q } : {}),
    ...(sort !== 'newest' ? { sort } : {}),
    ...(page > 1 ? { page: String(page) } : {}),
  });
  const s = p.toString();
  return s ? `/admin?${s}` : '/admin';
}

export function AccountsView({
  nav,
  list,
  q,
  sort,
  error,
}: {
  nav: ReactNode;
  list?: AdminAccountList;
  q: string;
  sort: AdminSort;
  error?: string;
}) {
  return (
    <AppPage
      nav={nav}
      title="Accounts"
      sub={
        list
          ? `${n(list.total)} account${list.total === 1 ? '' : 's'}${q ? ` matching “${q}”` : ''} · page ${list.page} of ${list.pages}`
          : undefined
      }
    >
      <Card>
        <form className="adm-search" action="/admin" method="get">
          <input
            name="q"
            defaultValue={q}
            placeholder="Search email or account id"
            aria-label="Search email or account id"
          />
          {sort !== 'newest' ? <input type="hidden" name="sort" value={sort} /> : null}
          <button type="submit" className="buy quiet">
            Search
          </button>
          {q ? <a href={href('', sort)}>Clear</a> : null}
        </form>
        <nav className="adm-sorts" aria-label="Sort">
          Sort:
          {ADMIN_SORTS.map((s) => (
            <a key={s} href={href(q, s)} aria-current={s === sort ? 'true' : undefined}>
              {SORT_NAMES[s]}
            </a>
          ))}
        </nav>
        {error ? <p className="adm-error">The accounts could not be read: {error}</p> : null}
        {list ? (
          <>
            <div className="adm-scroll">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Signed up</th>
                    <th>Last active</th>
                    <th className="num">Credits</th>
                    <th className="num">Exports</th>
                    <th className="num">Calls · failed</th>
                    <th>Clients</th>
                    <th>Kazi</th>
                    <th>Referral</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <a href={`/admin/${a.id}`}>{a.email}</a>
                        {a.email_verified ? null : (
                          <>
                            {' '}
                            <Badge tone="warn">unverified</Badge>
                          </>
                        )}
                      </td>
                      <td>{day(a.created_at)}</td>
                      <td>{day(a.last_used_at)}</td>
                      <td className="num">{n(a.credits?.left)}</td>
                      <td className="num">{n(exportsOf(a))}</td>
                      <td className="num">
                        {n(a.activity.calls)} · {n(a.activity.failed)}
                      </td>
                      <td>{clients(a).join(', ') || '—'}</td>
                      <td>{kaziFact(a) ?? '—'}</td>
                      <td>
                        {a.referral.referred_by ? `via ${a.referral.referred_by}` : ''}
                        {a.referral.referred.signed_up
                          ? `${a.referral.referred_by ? ' · ' : ''}brought ${a.referral.referred.signed_up}`
                          : ''}
                        {!a.referral.referred_by && !a.referral.referred.signed_up ? '—' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="adm-pages" aria-label="Pages">
              {list.page > 1 ? <a href={href(q, sort, list.page - 1)}>← Previous</a> : <span />}
              {list.has_more ? <a href={href(q, sort, list.page + 1)}>Next →</a> : null}
            </nav>
          </>
        ) : null}
      </Card>
    </AppPage>
  );
}

const Facts = Details;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Card title={title}>{children}</Card>;
}

function None({ children }: { children: ReactNode }) {
  return <p className="adm-none">{children}</p>;
}

export function AccountDetail({
  nav,
  account: a,
  ledger,
  ledgerError,
}: {
  nav: ReactNode;
  account: AdminAccount;
  ledger?: AdminLedger;
  ledgerError?: string;
}) {
  const exportFiles = a.files.filter((f) => f.kind === 'export');
  return (
    <AppPage
      nav={nav}
      back={{ href: '/admin', label: 'All accounts' }}
      title={a.email}
      sub={`Signed up ${day(a.created_at)} · last active ${day(a.last_used_at)}`}
    >
      <Card title="Profile">
        <Facts
          rows={[
            ['Account', <code key="id">{a.id}</code>],
            ['Signed up', `${when(a.created_at)}${a.email_verified ? '' : ' (email unverified)'}`],
            ['Last active', when(a.last_used_at)],
            [
              'First tool · edit · export',
              `${day(a.first_tool_at)} · ${day(a.first_edit_at)} · ${day(a.first_export_at)}`,
            ],
            ['Clients', clients(a).join(', ') || '—'],
            ['Kazi', kaziFact(a) ?? 'Not seen (Kazi’s own users are not read)'],
            ['Made by', a.made_by ?? 'Signed up here'],
            [
              'Referral',
              <>
                {a.referral.referred_by
                  ? `Came via ${a.referral.referred_by}${a.referral.referred_by_account ? ` (${a.referral.referred_by_account})` : ''}. `
                  : 'Came on their own. '}
                Their link <code>{a.referral.code}</code> brought {a.referral.referred.signed_up}{' '}
                (used a tool {a.referral.referred.used_a_tool}, exported{' '}
                {a.referral.referred.exported}).
              </>,
            ],
            [
              'Use cases',
              a.use_cases.length ? a.use_cases.map((u) => u.use_case).join(' · ') : '—',
            ],
          ]}
        />
      </Card>

      <Section title="Credits">
        <Facts
          rows={[
            ['Balance', a.credits ? n(a.credits.left) : 'No ledger account yet'],
            ['Plan', a.credits?.plan ?? '—'],
            [
              'Given · bought · used',
              a.credits
                ? `${n(a.credits.free)} · ${n(a.credits.bought)} · ${n(a.credits.used)}`
                : '—',
            ],
          ]}
        />
        <AdjustForm account={a.id} balance={ledger?.balance ?? a.credits?.left ?? null} />
      </Section>

      <Section title="Ledger">
        {ledgerError ? (
          <p className="adm-error">The ledger could not be read: {ledgerError}</p>
        ) : null}
        {ledger && !ledger.opened ? (
          <None>No ledger account yet: it opens on first use.</None>
        ) : null}
        {ledger?.entries.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th className="num">Credits</th>
                  <th className="num">Balance</th>
                  <th>Entry</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {ledger.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{when(e.at)}</td>
                    <td>{e.kind}</td>
                    <td className={`num ${e.credits < 0 ? 'neg' : 'pos'}`}>{signed(e.credits)}</td>
                    <td className="num">{n(e.balance)}</td>
                    <td>
                      <code>{e.id}</code>
                    </td>
                    <td>
                      {[e.reason, e.tool, e.pack, e.by ? `by ${e.by}` : undefined]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>

      <Section title="Purchases">
        {a.purchases === null ? (
          <None>Stripe did not answer.</None>
        ) : a.purchases.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th className="num">Credits</th>
                  <th className="num">Paid</th>
                  <th className="num">Refunded</th>
                </tr>
              </thead>
              <tbody>
                {a.purchases.map((p) => (
                  <tr key={`${p.at}-${p.credits}-${p.amount}`}>
                    <td>{when(p.at)}</td>
                    <td className="num">{n(p.credits)}</td>
                    <td className="num">
                      {n(p.amount)} {p.currency.toUpperCase()}
                    </td>
                    <td className="num">{p.refunded ? n(p.refunded) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <None>None.</None>
        )}
      </Section>

      <Section title="Exports and releases">
        <Facts
          rows={[
            ['Video exports run', n(exportsOf(a))],
            ['Watermarks removed', n(a.releases.length)],
            ['Downloads', n(a.downloads.reduce((t, d) => t + d.downloads, 0))],
          ]}
        />
        {a.releases.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Released</th>
                  <th>File</th>
                  <th className="num">Credits</th>
                  <th>Via</th>
                </tr>
              </thead>
              <tbody>
                {a.releases.map((r) => (
                  <tr key={r.id}>
                    <td>{when(r.released_at)}</td>
                    <td>
                      <code>{r.id}</code>
                    </td>
                    <td className="num">{n(r.credits)}</td>
                    <td>{r.via}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {exportFiles.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Export kept</th>
                  <th>Goes</th>
                  <th>Watermark</th>
                  <th>Links</th>
                </tr>
              </thead>
              <tbody>
                {exportFiles.map((f) => (
                  <tr key={f.id}>
                    <td>{f.name}</td>
                    <td>{when(f.expires_at)}</td>
                    <td>{f.watermarked ? `yes (${n(f.release_credits)} to remove)` : 'clean'}</td>
                    <td>
                      {f.page_url ? <a href={f.page_url}>watch</a> : null}
                      {f.download_url ? (
                        <>
                          {' · '}
                          <a href={f.download_url}>download</a>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <None>No exports kept now.</None>
        )}
      </Section>

      <Section title="Tool activity, 30 days">
        <Facts
          rows={[
            [
              'Calls · failed · jobs',
              `${n(a.activity.calls)} · ${n(a.activity.failed)} · ${n(a.activity.jobs)}`,
            ],
            ['Last call', when(a.activity.last_call_at)],
            [
              'Active days · longest streak',
              `${a.activity.active_days} · ${a.activity.longest_streak}`,
            ],
            [
              'Out of credits',
              a.out_of_credits
                ? `${a.out_of_credits.refusals} refused, last ${when(a.out_of_credits.last_at)}`
                : '—',
            ],
          ]}
        />
        {a.activity.tools.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th className="num">Calls</th>
                  <th className="num">Failed</th>
                  <th className="num">Jobs</th>
                </tr>
              </thead>
              <tbody>
                {a.activity.tools.map((t) => (
                  <tr key={t.tool}>
                    <td>
                      <code>{t.tool}</code>
                    </td>
                    <td className="num">{t.calls}</td>
                    <td className={`num ${t.failed ? 'neg' : ''}`}>{t.failed}</td>
                    <td className="num">{t.jobs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <None>No calls in the last 30 days.</None>
        )}
        {a.activity.recent_errors.length ? (
          <div className="adm-scroll">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Error at</th>
                  <th>Tool</th>
                  <th>Code</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {a.activity.recent_errors.map((e) => (
                  <tr key={`${e.at}-${e.tool}-${e.code}`}>
                    <td>{when(e.at)}</td>
                    <td>
                      <code>{e.tool}</code>
                    </td>
                    <td>
                      <code>{e.code}</code>
                    </td>
                    <td className="adm-msg">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>

      {a.support_messages.length ? (
        <Section title="Support messages">
          <ul className="adm-list">
            {a.support_messages.map((m) => (
              <li key={`${m.at}-${m.message.slice(0, 40)}`}>
                <span className="adm-when">{when(m.at)}</span> {m.message}
                {m.improvement ? <em> Would help: {m.improvement}</em> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </AppPage>
  );
}
