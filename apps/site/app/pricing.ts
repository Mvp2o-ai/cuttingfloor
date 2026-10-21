import { PLANS as ALL, type PlanId, PRICED, SUPPORT_EMAIL, TRIAL_DAYS } from '@cuttingfloor/plans';

// The pricing table, worded from the one plans file the server enforces (packages/plans). The
// billable unit is a render minute: one minute of a job running (export, import, transcript,
// motion graphics, voiceover, cutout). Editing the timeline is free. At a plan's minutes new jobs
// wait for the renewal or a bigger plan; nothing is billed past the price.
export type Plan = {
  id: PlanId;
  name: string;
  price: string;
  per: string;
  /** Dollars a month, for structured data; absent when the price is agreed with us. */
  amount?: number;
  included: string;
  limits: string;
  note: string;
  pick?: boolean;
  /** Where the plan is bought or asked for. */
  href: string;
};

const resolution = (side: number | null) =>
  side === null ? 'any size' : side >= 2160 ? '4K' : `${side}p`;
const storage = (gb: number | null) =>
  gb === null ? 'unlimited storage' : gb >= 1000 ? `${gb / 1000} TB storage` : `${gb} GB storage`;
const jobs = (n: number | null) =>
  n === null ? 'no job limit' : n === 1 ? 'one job at a time' : `${n} jobs at once`;

export const PLANS: Plan[] = PRICED.map((p) => {
  const l = p.limits;
  const common = {
    id: p.id,
    name: p.name,
    note: p.note,
    limits: `${jobs(l.jobs)[0]?.toUpperCase()}${jobs(l.jobs).slice(1)}, ${resolution(l.shortSide)}, ${storage(l.storageGb)}`,
    ...(p.id === 'pro' ? { pick: true } : {}),
  };
  if (p.id === 'trial')
    return {
      ...common,
      price: '$0',
      per: `${TRIAL_DAYS} days`,
      amount: 0,
      included: `${l.renderMinutes} render min`,
      href: '/start',
    };
  if (p.sold === 'contact')
    return {
      ...common,
      price: 'Talk to us',
      per: '',
      included: `From ${l.renderMinutes?.toLocaleString('en-US')} min a seat`,
      limits: 'Priority, more jobs at once, 4K',
      href: `mailto:${SUPPORT_EMAIL}?subject=cuttingfloor%20Enterprise`,
    };
  return {
    ...common,
    price: `$${p.price?.month}`,
    per: '/ month',
    amount: p.price?.month ?? 0,
    included: `${l.renderMinutes} render min a month`,
    href: '/start',
  };
});

/** A plan's prices for the account page's buttons. */
export function prices(id: PlanId): { month: number; year: number } | undefined {
  return ALL[id].price;
}
