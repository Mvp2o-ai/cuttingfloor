// The hosted plans, in one place: the site's pricing, checkout and account pages and the hosted
// server's access checks read this file. The billable unit is a credit: one minute of a job
// running (export, import, transcript, motion graphics, voiceover, cutout, code), which the meter
// counts as a render minute. Editing the timeline and inline previews are free.
//
// There are no subscriptions. Every account starts with free credits and buys more in packs when
// it wants them (pay as you go); bought credits never expire. At zero new jobs wait; editing and
// previews keep working. A few accounts are given a plan instead (staff, lifetime, enterprise),
// with credits that renew each month. Costs behind the numbers: plans/pricing.md.

export type PlanId = 'free' | 'credits' | 'enterprise' | 'lifetime' | 'staff';

export interface Limits {
  /** Jobs that run at once for one account; more wait their turn. null for no cap. */
  jobs: number | null;
  /** Largest export, as its short side in pixels (1080 is 1080p, 2160 is 4K); null for any. */
  shortSide: number | null;
  /** judge.ask and media.analyze look judgments a day; null for the server's own limit. */
  judgmentsPerDay: number | null;
  /**
   * Gigabytes the account may keep on the server at once: uploads, imported media and its proxies,
   * exports. Everything still expires on its own clock; this caps what is held meanwhile. null
   * for no cap.
   */
  storageGb: number | null;
}

/**
 * How an account's credits work: a balance (free credits plus packs bought, less what was used),
 * an allowance that renews each calendar month, or no cap.
 */
export type Credits =
  | { kind: 'balance' }
  | { kind: 'monthly'; perMonth: number }
  | { kind: 'none' };

export interface Plan {
  id: PlanId;
  name: string;
  credits: Credits;
  limits: Limits;
  /** self: credits bought on the account page. contact: through support. none: given, not sold. */
  sold: 'self' | 'contact' | 'none';
  /** One line for the pricing page. */
  note: string;
}

export const SUPPORT_EMAIL = 'support@cuttingfloor.ai';
export const LEGAL_NAME = 'mvp2o';

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    sold: 'none',
    credits: { kind: 'balance' },
    limits: { jobs: 1, shortSide: 1080, judgmentsPerDay: 300, storageGb: 5 },
    note: 'Every tool, no card. Exports up to 1080p until your first pack.',
  },
  credits: {
    id: 'credits',
    name: 'Pay as you go',
    sold: 'self',
    credits: { kind: 'balance' },
    limits: { jobs: 2, shortSide: 2160, judgmentsPerDay: 5000, storageGb: 50 },
    note: 'Buy credits when you need them. They never expire.',
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    sold: 'contact',
    credits: { kind: 'monthly', perMonth: 5000 },
    limits: { jobs: 4, shortSide: 2160, judgmentsPerDay: 20000, storageGb: 1000 },
    note: 'Agents editing all day, for a team. Credits, seats and dedicated servers to suit.',
  },
  lifetime: {
    id: 'lifetime',
    name: 'Lifetime',
    sold: 'none',
    credits: { kind: 'monthly', perMonth: 900 },
    limits: { jobs: 2, shortSide: 2160, judgmentsPerDay: 5000, storageGb: 200 },
    note: 'Given for good.',
  },
  staff: {
    id: 'staff',
    name: 'Staff',
    sold: 'none',
    credits: { kind: 'none' },
    limits: { jobs: null, shortSide: null, judgmentsPerDay: null, storageGb: null },
    note: 'The team running cuttingfloor.',
  },
};

export interface Pack {
  /** The Stripe price lookup key, and the id the account page posts. */
  id: string;
  /** Dollars. */
  price: number;
  credits: number;
}

/** Credit packs, smallest first. Bigger packs cost less a credit. */
export const PACKS: Pack[] = [
  { id: 'cf_credits_5', price: 5, credits: 25 },
  { id: 'cf_credits_10', price: 10, credits: 55 },
  { id: 'cf_credits_25', price: 25, credits: 150 },
  { id: 'cf_credits_100', price: 100, credits: 700 },
];

/** The pack a lookup key or id names, if it is one of ours. */
export function packOf(id: string | null | undefined): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}

/** Credits a new account starts with: no card, no time limit. */
export const FREE_CREDITS = 10;

/** Accounts made before this kept the free credits they signed up with. */
export const GRANDFATHERED = { before: '2026-11-08T00:00:00Z', credits: 100 };

/** The free credits an account made at `createdAt` starts with. */
export function freeCreditsFor(createdAt: string): number {
  return Date.parse(createdAt) < Date.parse(GRANDFATHERED.before)
    ? GRANDFATHERED.credits
    : FREE_CREDITS;
}

/**
 * Below this many credits left the account is told it is running low, and an account that turned
 * on automatic top-up buys its pack.
 */
export const LOW_CREDITS = 5;

/**
 * The plan an account is given rather than buys, from its WorkOS `plan` metadata: `admin` is the
 * team's own accounts (shown as Staff), `lifetime` a customer given it for good, `enterprise` a
 * team on a contract arranged through support.
 */
export function taggedPlan(tag: string | null | undefined): PlanId | undefined {
  if (tag === 'admin' || tag === 'staff') return 'staff';
  if (tag === 'lifetime') return 'lifetime';
  if (tag === 'enterprise') return 'enterprise';
  return undefined;
}
