import { PLANS as ALL, type PlanId, PRICED, SUPPORT_EMAIL, TRIAL_DAYS } from '@cuttingfloor/plans';
import { KEYS, LICENCE, LOCAL_ADDRESS } from '../content/facts.ts';

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

// ---------- the /pricing page, /pricing.md and /pricing.json ----------
// One set of facts for the three, from the plans file and content/facts.ts, so they never disagree.

/** A column of the comparison: running it yourself, or one of the hosted plans. */
export type Option = {
  id: 'self-hosted' | PlanId;
  name: string;
  price: string;
  per: string;
  /** Dollars, for structured data: a month, or the trial's whole length. Absent when agreed with us. */
  amount?: number;
  /** Dollars a year, for plans sold by the year too. */
  yearly?: number;
  hosted: boolean;
  note: string;
  href: string;
  cta: string;
  pick?: boolean;
};

const sold = (id: PlanId) => PLANS.find((p) => p.id === id);

export const SELF_HOSTED: Option = {
  id: 'self-hosted',
  name: 'Self-hosted',
  price: 'Free',
  per: '',
  amount: 0,
  hosted: false,
  note: `Open source under ${LICENCE}. The same Docker image the hosted service runs, on your own machine, with no render-minute limits. Bring your own keys where a feature needs one.`,
  href: '/self-host',
  cta: 'Run it yourself',
};

export const OPTIONS: Option[] = [
  SELF_HOSTED,
  ...PRICED.map((p): Option => {
    const shown = sold(p.id);
    const base = {
      id: p.id,
      name: p.name,
      hosted: true,
      note: p.note,
      href: shown?.href ?? '/start',
      ...(p.id === 'pro' ? { pick: true } : {}),
    };
    if (p.id === 'trial')
      return { ...base, price: '$0', per: `for ${TRIAL_DAYS} days`, amount: 0, cta: 'Start free' };
    if (!p.price) return { ...base, price: 'Talk to us', per: '', cta: 'Email us' };
    return {
      ...base,
      price: `$${p.price.month}`,
      per: 'a month',
      amount: p.price.month,
      yearly: p.price.year,
      cta: 'Start free',
    };
  }),
];

/** included: the plan has it; not: it doesn't; key: it works with a key of your own; value: a number. */
export type Mark = 'included' | 'not' | 'key' | 'value';
export type Cell = { mark: Mark; text: string };
export type Row = { label: string; cells: Record<Option['id'], Cell> };

const MARK_WORDS: Record<Mark, string> = {
  included: 'Included',
  not: 'Not included',
  key: 'Your own key',
  value: '',
};
export const markWord = (m: Mark) => MARK_WORDS[m];

const yes = (text: string): Cell => ({ mark: 'included', text });
const no = (text: string): Cell => ({ mark: 'not', text });
const key = (text: string): Cell => ({ mark: 'key', text });
const val = (text: string): Cell => ({ mark: 'value', text });
const per = (id: PlanId) => (id === 'trial' ? `in ${TRIAL_DAYS} days` : 'a month');
const num = (n: number) => n.toLocaleString('en-US');

/** One row of hosted cells, from a plan's limits. */
function hosted(cell: (l: (typeof PRICED)[number]['limits'], id: PlanId) => Cell) {
  return Object.fromEntries(PRICED.map((p) => [p.id, cell(p.limits, p.id)])) as Record<
    PlanId,
    Cell
  >;
}

const lipsync = KEYS.find((k) => k.tools.includes('create.lipsync'));
const judgment = KEYS.find((k) => k.tools.includes('judge.ask'));
/** The judgment tools, as the key table names them, for the daily-limit row. */
export const JUDGMENT_TOOLS = judgment?.tools ?? [];

export const ROWS: Row[] = [
  {
    label: 'Price',
    cells: {
      'self-hosted': val('Free'),
      ...hosted((_, id) => {
        const p = ALL[id];
        if (id === 'trial') return val(`$0 for ${TRIAL_DAYS} days, no card`);
        if (!p.price) return val('Agreed with us');
        return val(`$${p.price.month} a month, or $${p.price.year} a year`);
      }),
    },
  },
  {
    label: 'Render minutes included',
    cells: {
      'self-hosted': val('No limit: it runs on your machine'),
      ...hosted((l, id) =>
        l.renderMinutes === null
          ? val('No limit')
          : id === 'enterprise'
            ? val(`From ${num(l.renderMinutes)} a month, per seat`)
            : val(`${num(l.renderMinutes)} ${per(id)}`),
      ),
    },
  },
  {
    label: 'Jobs at once',
    cells: {
      'self-hosted': val('As many as your machine runs (you set it)'),
      ...hosted((l) =>
        val(l.jobs === null ? 'No limit' : l.jobs === 1 ? '1 at a time' : `${l.jobs} at once`),
      ),
    },
  },
  {
    label: 'Largest export',
    cells: {
      'self-hosted': yes('Any size, including 4K'),
      ...hosted((l) =>
        l.shortSide === null
          ? yes('Any size')
          : l.shortSide >= 2160
            ? yes('4K (2160p)')
            : no(`${l.shortSide}p; 4K not included`),
      ),
    },
  },
  {
    label: 'Storage held at once',
    cells: {
      'self-hosted': val('Your own disk'),
      ...hosted((l) =>
        val(
          l.storageGb === null
            ? 'No limit'
            : l.storageGb >= 1000
              ? `${l.storageGb / 1000} TB`
              : `${l.storageGb} GB`,
        ),
      ),
    },
  },
  {
    label: `Visual judgments a day (${JUDGMENT_TOOLS.join(', ')})`,
    cells: {
      'self-hosted': key(judgment?.selfHosted ?? ''),
      ...hosted((l) =>
        yes(
          l.judgmentsPerDay === null ? 'No daily limit' : `${num(l.judgmentsPerDay)} a day, no key`,
        ),
      ),
    },
  },
  {
    label: `Lip-sync (${lipsync?.tools.join(', ')})`,
    cells: {
      'self-hosted': key(lipsync?.selfHosted ?? ''),
      ...hosted(() => key('Your own sync. labs key')),
    },
  },
  {
    label: 'Transcripts, voiceover, cutouts, graphics, every edit and export',
    cells: {
      'self-hosted': yes('Runs in the image, no key'),
      ...hosted(() => yes('No key')),
    },
  },
  {
    label: 'Who runs the server',
    cells: {
      'self-hosted': val('You, with Docker'),
      ...hosted((_, id) =>
        id === 'enterprise' ? val('We do, with dedicated servers to suit') : val('We do'),
      ),
    },
  },
];

/** What a render minute is: the home page's price-foot, said as separate facts. */
export const RENDER_MINUTE = [
  'A render minute is one minute of a job running on our servers: an export, an import, a transcript, graphics, a voiceover or a cutout.',
  'Planning and editing the timeline cost nothing, and so do previews.',
  'When a plan’s minutes are used, new jobs wait until they renew or you move up. There is no overage charge: you are never charged more than the price. We email you at 80% and at 100%.',
  'Yearly plans get two months free: a year costs ten months.',
  'Self-hosted has no render minutes at all: it runs on your own machine.',
] as const;

/** Hosted: how long things are kept (the server's media TTL, and a timeline's after last use). */
export const KEPT_DAYS = 7;
export const TIMELINE_HOURS = 24;
export const KEPT = `On the hosted server, media and exports are kept ${KEPT_DAYS} days, timelines ${TIMELINE_HOURS} hours after last use.`;

const trial = ALL.trial.limits;

export const PRICING_FAQS = [
  {
    q: 'Can I self-host for free?',
    a: `Yes. cuttingfloor is open source under ${LICENCE} and runs in one Docker image, the same image the hosted service runs. Clone the repository and run docker compose up -d; your agent connects to ${LOCAL_ADDRESS}. There are no render-minute limits on your own machine. Lip-sync needs your own sync. labs key and visual judgment needs a TypeSafe key; everything else runs in the image with no key.`,
  },
  {
    q: 'Do I need my own AI keys?',
    a: 'On the hosted plans, only for lip-sync (create.lipsync), which uses your own sync. labs key: save it on your account page, where only its last four characters are shown, and sync. labs bills you per second. Transcripts, voiceover, cutouts, graphics and visual judgment are included. Self-hosted, lip-sync needs SYNC_API_KEY and visual judgment (judge.ask, media.analyze look, media.seek) needs TYPESAFE_API_KEY.',
  },
  {
    q: 'What happens when minutes run out?',
    a: 'Editing and previews keep working. New jobs such as exports and imports wait until your minutes renew, or until you move to a bigger plan. There is no overage charge: you are never charged more than the plan price. We email you at 80% and at 100%.',
  },
  {
    q: 'Can I cancel?',
    a: 'Yes, any time, from your account page. A monthly plan stops at the end of the month you paid for. Within 14 days of buying or renewing a yearly plan you can ask for a refund of the months you haven’t started. Payments are by Stripe.',
  },
  {
    q: 'Is there a free trial?',
    a: `Yes. ${TRIAL_DAYS} days with ${trial.renderMinutes} render minutes, no card. It has every tool, one job at a time, exports up to ${trial.shortSide}p and ${trial.storageGb} GB of storage.`,
  },
];
