import { PACKS } from '@cuttingfloor/plans';
import { notFound } from 'next/navigation';
import type { Account } from '../../lib/billing.ts';
import { type AccountProps, AccountView } from '../view.tsx';

// The account page in each state, from fixtures, to look at while changing it: development only
// (production answers 404). /account/preview?state=new | used | out | bought | auto | lifetime |
// staff | unverified | down.

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false } };

const packs = PACKS.map((p) => ({ price_usd: p.price, credits: p.credits }));

function free(over: Partial<Account['credits']> = {}): Account {
  return {
    plan: 'free',
    plan_name: 'Free',
    credits: { left: 10, used: 0, free: 10, bought: 0, per_month: null, renews: null, ...over },
    warnings: [{ at_credits: 5, kind: 'low', emailed: false }],
    top_up: { automatic: false, pack: null, below: 5, card_saved: false },
    packs,
    limits: { jobs: 1, export_short_side: 1080, judgments_per_day: 300, storage_gb: 5 },
    account_url: 'https://cuttingfloor.ai/account',
  };
}

function paid(automatic: boolean): Account {
  return {
    ...free({ left: 31.5, used: 3.5, bought: 25 }),
    plan: 'credits',
    plan_name: 'Credits',
    top_up: {
      automatic,
      pack: automatic ? { price_usd: 10, credits: 55 } : null,
      below: 5,
      card_saved: true,
    },
    limits: { jobs: 2, export_short_side: 2160, judgments_per_day: 5000, storage_gb: 50 },
  };
}

const T = '2026-11-08T10:00:00Z';

const STATES: Record<string, Partial<AccountProps>> = {
  new: { account: free(), progress: {} },
  connected: { account: free({ left: 9.6, used: 0.4 }), progress: { first_call_at: T } },
  used: {
    account: free({ left: 6.2, used: 3.8 }),
    progress: { first_call_at: T, first_edit_at: T, first_export_at: T },
  },
  out: {
    account: free({ left: 0, used: 10 }),
    progress: { first_call_at: T, first_edit_at: T, first_export_at: T },
  },
  bought: {
    account: paid(false),
    bought: '25',
    progress: { first_call_at: T, first_edit_at: T, first_export_at: T },
  },
  auto: {
    account: paid(true),
    progress: { first_call_at: T, first_edit_at: T, first_export_at: T },
  },
  lifetime: {
    account: {
      ...free({ left: 880, used: 20, free: 0, per_month: 900, renews: '2026-12-01T00:00:00Z' }),
      plan: 'lifetime',
      plan_name: 'Lifetime',
      top_up: null,
      packs: [],
    },
    progress: { first_call_at: T, first_edit_at: T, first_export_at: T },
  },
  staff: {
    account: {
      ...free({ left: null }),
      plan: 'staff',
      plan_name: 'Staff',
      top_up: null,
      packs: [],
    },
    progress: { first_call_at: T, first_edit_at: T, first_export_at: T },
  },
  unverified: { refused: 'email_unverified', progress: {} },
  down: { progress: {} },
};

export default async function Preview({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { state = 'new' } = await searchParams;
  const s = STATES[state] ?? STATES.new;
  return (
    <AccountView
      email="maya@example.com"
      firstName="Maya"
      progress={{}}
      files={{
        media: [],
        media_count: 0,
        uploads: [],
        upload_count: 0,
        storage: { used_bytes: 0, max_bytes: 5e9 },
      }}
      server="https://api.cuttingfloor.ai"
      {...s}
    />
  );
}
