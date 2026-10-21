// The hosted plans, in one place: the site's pricing table, checkout and account page, and the
// hosted server's access checks read this file. The billable unit is a render minute: one minute
// of a job running (export, import, transcript, motion graphics, voiceover, cutout, code). Editing
// the timeline and inline previews are free. Costs and margins behind the numbers: plans/pricing.md.

export type PlanId = 'trial' | 'creator' | 'pro' | 'enterprise' | 'lifetime' | 'staff';

export interface Limits {
  /** Render minutes in a period (the trial, or a month); null for no cap. */
  renderMinutes: number | null;
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

export interface Plan {
  id: PlanId;
  name: string;
  limits: Limits;
  /** Dollars. Annual is ten months. Absent for plans not sold at a list price. */
  price?: { month: number; year: number };
  /** self: bought on the account page. contact: through support. none: given, not sold. */
  sold: 'self' | 'contact' | 'none';
  /** One line for the pricing table. */
  note: string;
}

export const TRIAL_DAYS = 3;
/** Days a subscription whose payment failed keeps working while Stripe retries the card. */
export const GRACE_DAYS = 7;
export const SUPPORT_EMAIL = 'support@cuttingfloor.ai';
export const LEGAL_NAME = 'mvp2o';

export const PLANS: Record<PlanId, Plan> = {
  trial: {
    id: 'trial',
    name: 'Trial',
    sold: 'none',
    limits: { renderMinutes: 60, jobs: 1, shortSide: 1080, judgmentsPerDay: 300, storageGb: 5 },
    note: `Everything, no card, for ${TRIAL_DAYS} days. About six hours of an agent editing.`,
  },
  creator: {
    id: 'creator',
    name: 'Creator',
    sold: 'self',
    price: { month: 49, year: 490 },
    limits: { renderMinutes: 300, jobs: 1, shortSide: 1080, judgmentsPerDay: 1500, storageGb: 50 },
    note: 'About 30 hours of editing a month. One job at a time, up to 1080p.',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    sold: 'self',
    price: { month: 99, year: 990 },
    limits: { renderMinutes: 900, jobs: 2, shortSide: 2160, judgmentsPerDay: 5000, storageGb: 200 },
    note: 'Agents editing most days. Two jobs at once, up to 4K.',
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    sold: 'contact',
    limits: {
      renderMinutes: 5000,
      jobs: 4,
      shortSide: 2160,
      judgmentsPerDay: 20000,
      storageGb: 1000,
    },
    note: 'Agents editing all day, for a team. Minutes, seats and dedicated servers to suit.',
  },
  lifetime: {
    id: 'lifetime',
    name: 'Lifetime',
    sold: 'none',
    limits: { renderMinutes: 900, jobs: 2, shortSide: 2160, judgmentsPerDay: 5000, storageGb: 200 },
    note: 'Pro, for good.',
  },
  staff: {
    id: 'staff',
    name: 'Staff',
    sold: 'none',
    limits: {
      renderMinutes: null,
      jobs: null,
      shortSide: null,
      judgmentsPerDay: null,
      storageGb: null,
    },
    note: 'The team running cuttingfloor.',
  },
};

/** The plans on the pricing table, in order. */
export const PRICED: Plan[] = [PLANS.trial, PLANS.creator, PLANS.pro, PLANS.enterprise];

export type Interval = 'month' | 'year';

/** The Stripe price lookup key for a plan sold on the account page. */
export function lookupKey(plan: PlanId, interval: Interval): string {
  return `cf_${plan}_${interval}`;
}

/** The plan and interval a Stripe price lookup key names, if it is one of ours. */
export function fromLookupKey(
  key: string | null | undefined,
): { plan: PlanId; interval: Interval } | undefined {
  const m = /^cf_([a-z]+)_(month|year)$/.exec(key ?? '');
  const plan = m?.[1] as PlanId | undefined;
  if (!m || !plan || !(plan in PLANS) || PLANS[plan].sold === 'none') return undefined;
  return { plan, interval: m[2] as Interval };
}

/**
 * The plan an account is given rather than buys, from its WorkOS `plan` metadata: `admin` is the
 * team's own accounts (shown as Staff), `lifetime` a customer given Pro for good, `enterprise` a
 * team on a contract arranged through support.
 */
export function taggedPlan(tag: string | null | undefined): PlanId | undefined {
  if (tag === 'admin' || tag === 'staff') return 'staff';
  if (tag === 'lifetime') return 'lifetime';
  if (tag === 'enterprise') return 'enterprise';
  return undefined;
}
