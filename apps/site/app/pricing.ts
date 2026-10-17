// Plans shown on the landing page. The billable unit is a render minute: one minute of a heavy
// job (export, transcript, motion graphics, voiceover, cutout) on a 4-vCPU slot. Editing the
// timeline is free. Costs and margins behind these numbers: plans/pricing.md.
export type Plan = {
  name: string;
  price: string;
  per: string;
  included: string;
  overage: string;
  note: string;
  pick?: boolean;
};

export const PLANS: Plan[] = [
  {
    name: 'Trial',
    price: '$0',
    per: '3 days',
    included: '60 render min',
    overage: '—',
    note: 'Everything, no card. About six hours of an agent editing.',
  },
  {
    name: 'Creator',
    price: '$49',
    per: '/ month',
    included: '300 render min',
    overage: '$0.08 / min',
    note: 'About 30 hours of editing a month. One job at a time, up to 1080p.',
  },
  {
    name: 'Pro',
    price: '$99',
    per: '/ month',
    included: '900 render min',
    overage: '$0.06 / min',
    note: 'Agents editing most days. Two jobs at once, 4K.',
    pick: true,
  },
  {
    name: 'Enterprise',
    price: '$499',
    per: '/ seat / month',
    included: '5,000 min a seat',
    overage: '$0.05 / min',
    note: 'Agents editing all day. Priority queue, SSO, an SLA. Dedicated servers from $1,500.',
  },
];
