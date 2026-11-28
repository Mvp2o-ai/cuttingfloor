import { FREE_CREDITS, PACKS } from '@cuttingfloor/plans';
import { notFound } from 'next/navigation';
import { AppNav, accountLinks } from '../../app-ui.tsx';
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
    credits: {
      left: FREE_CREDITS,
      used: 0,
      free: FREE_CREDITS,
      bought: 0,
      per_month: null,
      renews: null,
      ...over,
    },
    warnings: [{ at_credits: 5, kind: 'low', emailed: false }],
    top_up: { automatic: false, pack: null, below: 5, card_saved: false },
    packs,
    limits: { export_short_side: 2160, storage_gb: 5 },
    account_url: 'https://cuttingfloor.ai/account',
  };
}

function paid(automatic: boolean): Account {
  return {
    ...free({ left: 27.25, used: 0.75, bought: 25 }),
    plan: 'credits',
    plan_name: 'Credits',
    top_up: {
      automatic,
      pack: automatic ? { price_usd: 10, credits: 55 } : null,
      below: 5,
      card_saved: true,
    },
    limits: { export_short_side: 2160, storage_gb: 50 },
  };
}

const T = '2026-11-08T10:00:00Z';

const STATES: Record<string, Partial<AccountProps>> = {
  new: { account: free(), progress: {} },
  connected: { account: free(), progress: { first_call_at: T } },
  used: {
    account: free({ left: 2.25, used: 0.75 }),
    progress: { first_call_at: T, first_edit_at: T, first_export_at: T },
  },
  out: {
    account: free({ left: 0, used: FREE_CREDITS }),
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
      nav={<AppNav email="maya@example.com" links={accountLinks(false)} current="/account" />}
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
      expiryEmails
      server="https://api.cuttingfloor.ai"
      {...s}
    />
  );
}
