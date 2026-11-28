import { notFound } from 'next/navigation';
import type { AdminAccount, AdminLedger } from '../../lib/admin.ts';
import { AdminNav } from '../nav.tsx';
import { AccountDetail, AccountsView } from '../view.tsx';

// The staff pages from fixtures, to look at while changing them: development only (production
// answers 404). /admin/preview (the list) and /admin/preview?view=account.

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false } };

const base: AdminAccount = {
  id: 'user_01KAQ7Z3M4XJ0PNB8E2R6TYV5W',
  email: 'maya.okafor@example.com',
  email_verified: true,
  created_at: '2026-11-02T09:14:00.000Z',
  made_by: null,
  referral: {
    code: 'k7m2qd',
    link: 'https://cuttingfloor.ai/r/k7m2qd',
    referred_by: null,
    referred_by_account: null,
    referred: { signed_up: 2, used_a_tool: 1, exported: 1 },
  },
  first_call_at: '2026-11-02T09:20:00.000Z',
  first_tool_at: '2026-11-02T09:21:00.000Z',
  first_edit_at: '2026-11-02T09:40:00.000Z',
  first_export_at: '2026-11-02T09:52:00.000Z',
  first_client: 'claude-ai',
  use_case: 'cut a podcast into Shorts',
  use_case_at: '2026-11-02T09:20:00.000Z',
  use_cases: [{ use_case: 'cut a podcast into Shorts', at: '2026-11-02T09:20:00.000Z' }],
  sample: null,
  last_used_at: '2026-11-25T18:03:00.000Z',
  credits: {
    plan: 'credits',
    left: 21.5,
    used: 6.5,
    free: 3,
    bought: 25,
    per_month: null,
    renews: null,
  },
  support_messages: [
    {
      at: '2026-11-19T10:00:00.000Z',
      message: 'Wanted rounded caption boxes; could not do them.',
      improvement: 'a radius on caption boxes',
    },
  ],
  activity: {
    calls: 214,
    failed: 6,
    jobs: 31,
    last_call_at: '2026-11-25T18:03:00.000Z',
    active_days: 9,
    longest_streak: 4,
    tools: [
      { tool: 'clip.add', calls: 61, failed: 0, jobs: 0 },
      { tool: 'caption.add', calls: 22, failed: 3, jobs: 0 },
      { tool: 'export.video', calls: 14, failed: 1, jobs: 14 },
      { tool: 'media.import', calls: 9, failed: 2, jobs: 9 },
    ],
    recent_errors: [
      {
        at: '2026-11-25T17:58:00.000Z',
        tool: 'caption.add',
        code: 'invalid_call',
        message: 'box.radius is not allowed',
      },
      {
        at: '2026-11-21T11:02:00.000Z',
        tool: 'media.import',
        code: 'fetch_failed',
        message: 'The URL answered 403',
      },
    ],
  },
  out_of_credits: null,
  spend: [
    { tool: 'export.video', credits: 4.2, jobs: 14 },
    { tool: 'judge.ask', credits: 0.5, jobs: 3 },
  ],
  purchases: [
    { at: '2026-11-10T12:00:00.000Z', credits: 25, amount: 5, refunded: 0, currency: 'usd' },
  ],
  apps: [
    {
      name: 'claude-ai',
      first_seen_at: '2026-11-21T00:00:00.000Z',
      last_seen_at: '2026-11-25T00:00:00.000Z',
    },
    {
      name: 'openai-mcp',
      first_seen_at: '2026-11-22T00:00:00.000Z',
      last_seen_at: '2026-11-23T00:00:00.000Z',
    },
  ],
  files: [
    {
      kind: 'export',
      id: 'j_01KAQ8',
      name: 'episode-12-short.mp4',
      expires_at: '2026-12-01T10:00:00.000Z',
      download_url: 'https://api.cuttingfloor.ai/outputs/x/j_01KAQ8/episode-12-short.mp4',
      page_url: 'https://api.cuttingfloor.ai/watch/x/j_01KAQ8/episode-12-short.mp4',
      final_url: null,
      watermarked: true,
      release_credits: 1,
      released_at: null,
    },
  ],
  next_expiry_at: '2026-12-01T10:00:00.000Z',
  downloads: [],
  releases: [
    { id: 'j_01KAP2', released_at: '2026-11-24T16:00:00.000Z', credits: 1.5, via: 'tool' },
  ],
  email_prefs: { expiry_emails: true, unsubscribed: false, suppressed: null },
};

const kazi: AdminAccount = {
  ...base,
  id: 'user_01KAR1B6C9D2E5F8G1H4J7K0M3',
  email: 'dev.patel@example.com',
  created_at: '2026-11-24T08:00:00.000Z',
  last_used_at: '2026-11-24T09:00:00.000Z',
  made_by: 'Kazi',
  apps: [
    {
      name: 'Kazi',
      first_seen_at: '2026-11-24T00:00:00.000Z',
      last_seen_at: '2026-11-24T00:00:00.000Z',
    },
  ],
  credits: {
    plan: 'free',
    left: 3,
    used: 0,
    free: 3,
    bought: 0,
    per_month: null,
    renews: null,
  },
  spend: [],
  activity: { ...base.activity, calls: 12, failed: 0 },
  referral: { ...base.referral, referred: { signed_up: 0, used_a_tool: 0, exported: 0 } },
};

const fresh: AdminAccount = {
  ...base,
  id: 'user_01KAS2C7D0E3F6G9H2J5K8M1N4',
  email: 'sam.rivera@example.com',
  email_verified: false,
  created_at: '2026-11-25T20:00:00.000Z',
  last_used_at: null,
  apps: [],
  first_client: null,
  credits: null,
  spend: [],
  activity: { ...base.activity, calls: 0, failed: 0, tools: [], recent_errors: [] },
  referral: {
    ...base.referral,
    referred_by: 'k7m2qd',
    referred: { signed_up: 0, used_a_tool: 0, exported: 0 },
  },
};

const ledger: AdminLedger = {
  opened: true,
  balance: 21.5,
  entries: [
    {
      id: 'adjust:site-2f1c',
      kind: 'adjust',
      credits: 2,
      at: '2026-11-25T18:10:00.000Z',
      balance: 21.5,
      reason: 'caption export failed twice',
      by: 'user_01KADM1NABCDEFGHJKMNPQRST',
    },
    {
      id: 'j_01KAP2-release',
      kind: 'spend',
      credits: -1.5,
      at: '2026-11-24T16:00:00.000Z',
      balance: 19.5,
      tool: 'export.release',
    },
    {
      id: 'pi_3QX',
      kind: 'purchase',
      credits: 25,
      at: '2026-11-10T12:00:00.000Z',
      balance: 21,
      pack: 'p25',
    },
    {
      id: 'opening:acc_91',
      kind: 'opening',
      credits: -7,
      at: '2026-11-09T00:00:00.000Z',
      balance: -4,
      reason: "balance in Kazi's ledger at the split",
    },
    {
      id: 'grant:activation',
      kind: 'grant',
      credits: 3,
      at: '2026-11-02T09:20:00.000Z',
      balance: 3,
    },
  ],
};

export default async function AdminPreview({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { view } = await searchParams;
  const nav = <AdminNav email="ken@example.com" />;
  return (
    <>
      {view === 'account' ? (
        <AccountDetail nav={nav} account={base} ledger={ledger} />
      ) : (
        <AccountsView
          nav={nav}
          q=""
          sort="newest"
          list={{
            data: [fresh, kazi, base],
            total: 3,
            page: 1,
            pages: 1,
            has_more: false,
            next_cursor: null,
            next: null,
          }}
        />
      )}
    </>
  );
}
