// The hosted plans, in one place: the site's pricing, checkout and account pages and the hosted
// server's access checks read this file. Making is free: imports, edits, analysis, exports and
// create.* spend nothing; only the server's protective limits apply. Every export of a picture
// (video, GIF, image, a generated clip) downloads free carrying the cuttingfloor mark, and the
// billable unit is a credit: one finished minute of a clean copy (cleanCopyCredits), taken once
// per export when the user releases it. Audio, text and project files are never marked.
//
// There are no subscriptions. Every account starts with a few free credits and buys more in packs
// when it wants them (pay as you go); bought credits never expire. At zero, making and marked
// downloads still work; clean copies wait for credits. A few accounts are given a plan instead
// (staff, lifetime, enterprise), never marked. Costs behind the numbers: plans/pricing.md.

export type PlanId = 'free' | 'credits' | 'enterprise' | 'lifetime' | 'staff';

export interface Limits {
  /** Largest export, as its short side in pixels (1080 is 1080p, 2160 is 4K); null for any. */
  shortSide: number | null;
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
    limits: { shortSide: 2160, storageGb: 5 },
    note: 'Every tool, no card.',
  },
  credits: {
    id: 'credits',
    name: 'Pay as you go',
    sold: 'self',
    credits: { kind: 'balance' },
    limits: { shortSide: 2160, storageGb: 50 },
    note: 'Buy credits when you need them. They never expire.',
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    sold: 'contact',
    credits: { kind: 'monthly', perMonth: 5000 },
    limits: { shortSide: 2160, storageGb: 1000 },
    note: 'Agents editing all day, for a team. Credits, seats and dedicated servers to suit.',
  },
  lifetime: {
    id: 'lifetime',
    name: 'Lifetime',
    sold: 'none',
    credits: { kind: 'monthly', perMonth: 900 },
    limits: { shortSide: 2160, storageGb: 200 },
    note: 'Given for good.',
  },
  staff: {
    id: 'staff',
    name: 'Staff',
    sold: 'none',
    credits: { kind: 'none' },
    limits: { shortSide: null, storageGb: null },
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

/**
 * Credits a new account starts with, granted when it is first linked to the ledger (its first
 * signed-in call, in practice credits.claim): no card, no time limit. The ledger grants the same
 * amount for an account cuttingfloor opens.
 */
export const FREE_CREDITS = 3;

/**
 * When the download gate began: exports finished before it keep clean links, and accounts made
 * before it started with the free credits of their time.
 */
export const GATE_FROM = '2026-11-23T11:30:00Z';

/** Accounts made before this kept the free credits they signed up with. */
export const GRANDFATHERED = { before: '2026-11-08T00:00:00Z', credits: 100 };

/** Free credits accounts made from GRANDFATHERED.before until GATE_FROM started with. */
export const PRE_GATE_FREE_CREDITS = 25;

/** The free credits an account made at `createdAt` starts with. */
export function freeCreditsFor(createdAt: string): number {
  const at = Date.parse(createdAt);
  if (at < Date.parse(GRANDFATHERED.before)) return GRANDFATHERED.credits;
  if (at < Date.parse(GATE_FROM)) return PRE_GATE_FREE_CREDITS;
  return FREE_CREDITS;
}

/**
 * How the meter weighs judgments (judge.ask, media.seek, look) against running time: 200 make a
 * credit's minute. Before the gate both were billed; the meter still counts them this way, for
 * what an account used before it was linked to the ledger, and for analytics.
 */
export const JUDGMENTS_PER_CREDIT = 200;

/** A clean copy's price is its finished length in these steps of a minute. */
export const CLEAN_COPY_STEP = 0.25;

/**
 * Credits a clean copy costs: one a finished minute, in quarter-minute steps (at least one step).
 * A still image, or a file with no length, is one step. 4K costs the same as HD.
 */
export function cleanCopyCredits(seconds: number | null | undefined): number {
  if (!seconds || !(seconds > 0)) return CLEAN_COPY_STEP;
  const steps = Math.max(1, Math.ceil(Math.round(seconds * 1000) / 1000 / (60 * CLEAN_COPY_STEP)));
  return steps * CLEAN_COPY_STEP;
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
