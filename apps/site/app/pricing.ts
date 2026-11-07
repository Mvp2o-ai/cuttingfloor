import { PLANS as ALL, type PlanId, PRICED, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import { KEYS, LICENCE, LOCAL_ADDRESS } from '../content/facts.ts';
import { TOOL_COUNT } from '../content/tools.ts';

// The pricing table, worded from the one plans file the server enforces (packages/plans). The
// billable unit is a credit: one minute of a job running (export, import, transcript, motion
// graphics, voiceover, cutout). Editing the timeline is free. At a plan's credits new jobs wait
// for the renewal or a bigger plan; nothing is billed past the price. Every plan has every tool.
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
  if (p.id === 'free')
    return {
      ...common,
      price: '$0',
      per: 'no time limit',
      amount: 0,
      included: `${l.renderMinutes} free credits`,
      href: '/start',
    };
  if (p.sold === 'contact')
    return {
      ...common,
      price: 'Talk to us',
      per: '',
      included: 'Credits and limits agreed on a call',
      limits: 'Start on any plan now; move up when we have talked',
      href: `mailto:${SUPPORT_EMAIL}?subject=cuttingfloor%20Enterprise`,
    };
  return {
    ...common,
    price: `$${p.price?.month}`,
    per: '/ month',
    amount: p.price?.month ?? 0,
    included: `${l.renderMinutes} credits a month`,
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
  /** Dollars, for structured data: a month, or $0 for the free plan. Absent when agreed with us. */
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
  note: `Open source under ${LICENCE}. The same Docker image the hosted service runs, on your own machine, with no credit limits. Bring your own keys where a feature needs one.`,
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
    if (p.id === 'free')
      return { ...base, price: '$0', per: 'no time limit', amount: 0, cta: 'Start free' };
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
const per = (id: PlanId) => (id === 'free' ? 'to start, no time limit' : 'a month');
const num = (n: number) => n.toLocaleString('en-US');

/** One row of hosted cells, from a plan's limits. */
function hosted(cell: (l: (typeof PRICED)[number]['limits'], id: PlanId) => Cell) {
  return Object.fromEntries(PRICED.map((p) => [p.id, cell(p.limits, p.id)])) as Record<
    PlanId,
    Cell
  >;
}

/** A limit row: Enterprise limits are agreed on a call, so the table shows no number for them. */
function limit(cell: (l: (typeof PRICED)[number]['limits'], id: PlanId) => Cell) {
  return hosted((l, id) => (id === 'enterprise' ? val('Agreed with us') : cell(l, id)));
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
        if (id === 'free') return val('$0, no card');
        if (!p.price) return val('Agreed with us');
        return val(`$${p.price.month} a month, or $${p.price.year} a year`);
      }),
    },
  },
  {
    label: 'Credits included',
    cells: {
      'self-hosted': val('No limit: it runs on your machine'),
      ...limit((l, id) =>
        l.renderMinutes === null ? val('No limit') : val(`${num(l.renderMinutes)} ${per(id)}`),
      ),
    },
  },
  {
    label: 'Jobs at once',
    cells: {
      'self-hosted': val('As many as your machine runs (you set it)'),
      ...limit((l) =>
        val(l.jobs === null ? 'No limit' : l.jobs === 1 ? '1 at a time' : `${l.jobs} at once`),
      ),
    },
  },
  {
    label: 'Largest export',
    cells: {
      'self-hosted': yes('Any size, including 4K'),
      ...limit((l) =>
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
      ...limit((l) =>
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
      ...limit((l) =>
        yes(
          l.judgmentsPerDay === null ? 'No daily limit' : `${num(l.judgmentsPerDay)} a day, no key`,
        ),
      ),
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

/** Every plan's tools, in plain words: no tool is kept for a bigger plan. */
export const EVERY_PLAN = [
  'Cut by what’s said: pauses, ums and retakes out, from the transcript',
  'Captions, with word-by-word highlights',
  'Voiceover with timed words',
  'Sound mixed to a loudness target, noise cleaned up, music under the voice',
  'Background removal and green screen',
  'Titles, animated text and motion graphics',
  'Vertical Shorts that follow faces',
  'Shaky footage stabilized, voice split from music',
  'Previews and frame checks, so your agent sees its own work',
  'Export to MP4, or hand off to Premiere, Final Cut or Resolve',
] as const;
export const EVERY_PLAN_LEAD = `Every plan, free included, has all ${TOOL_COUNT} tools. Plans differ only in credits, speed, video size and storage.`;

/** What a credit is: the pricing page's ledger, said as separate facts. */
export const CREDIT = [
  'A credit is one minute of our servers working for you: an export, an import, a transcript, graphics, a voiceover or a cutout.',
  'Planning and editing the timeline cost nothing, and so do previews.',
  `A new account gets ${ALL.free.limits.renderMinutes} free credits, with no card and no time limit. Paid plans add credits every month.`,
  'When credits are used, new jobs wait until they renew or you move up. There is no overage charge: you are never charged more than the price. We email you at 80% and at 100%.',
  'Self-hosted has no credits at all: it runs on your own machine.',
] as const;

/** Hosted: how long things are kept (the server's media TTL, and a timeline's after last use). */
export const KEPT_DAYS = 7;
export const TIMELINE_HOURS = 24;
export const KEPT = `On the hosted server, media and exports are kept ${KEPT_DAYS} days, timelines ${TIMELINE_HOURS} hours after last use.`;

const free = ALL.free.limits;

export const PRICING_FAQS = [
  {
    q: 'Can I self-host for free?',
    a: `Yes. cuttingfloor is open source under ${LICENCE} and runs in one Docker image, the same image the hosted service runs. Clone the repository and run docker compose up -d; your agent connects to ${LOCAL_ADDRESS}. There are no credit limits on your own machine. Lip-sync needs your own sync. labs key and visual judgment needs a TypeSafe key; everything else runs in the image with no key.`,
  },
  {
    q: 'Do I need my own AI keys?',
    a: 'On the hosted plans, only for lip-sync (create.lipsync), which uses your own sync. labs key: save it on your account page, where only its last four characters are shown, and sync. labs bills you per second. Transcripts, voiceover, cutouts, graphics and visual judgment are included. Self-hosted, lip-sync needs SYNC_API_KEY and visual judgment (judge.ask, media.analyze look, media.seek) needs TYPESAFE_API_KEY.',
  },
  {
    q: 'What happens when credits run out?',
    a: 'Editing and previews keep working. New jobs such as exports and imports wait until your credits renew, or until you move to a bigger plan. There is no overage charge: you are never charged more than the plan price. We email you at 80% and at 100%.',
  },
  {
    q: 'What is a credit?',
    a: 'One minute of our servers working for you: an export, an import, a transcript, graphics, a voiceover or a cutout. Editing the timeline and previews are free.',
  },
  {
    q: 'Can I cancel?',
    a: 'Yes, any time, from your account page. A monthly plan stops at the end of the month you paid for. Within 14 days of buying or renewing a yearly plan you can ask for a refund of the months you haven’t started. Payments are by Stripe.',
  },
  {
    q: 'Is it free to try?',
    a: `Yes. Every new account gets ${free.renderMinutes} free credits, with no card and no time limit: about 10 hours of your agent editing. It has every tool, one job at a time, exports up to ${free.shortSide}p and ${free.storageGb} GB of storage. Or watch the live demo first, with no sign-up.`,
  },
];
