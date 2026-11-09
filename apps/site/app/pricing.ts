import {
  PLANS as ALL,
  FREE_CREDITS,
  FREE_FOOTAGE_MINUTES,
  LOW_CREDITS,
  PACKS,
  type PlanId,
  SUPPORT_EMAIL,
} from '@cuttingfloor/plans';
import { KAZI_CREDITS } from '../content/clients.ts';
import { KEYS, LICENCE, LOCAL_ADDRESS } from '../content/facts.ts';
import { TOOL_COUNT } from '../content/tools.ts';

// The pricing, worded from the one plans file the server enforces (packages/plans). The billable
// unit is a credit: one minute of a job running (export, import, transcript, motion graphics,
// voiceover, cutout). Editing the timeline is free. There are no subscriptions: an account starts
// with free credits and buys packs when it wants more (pay as you go); bought credits never
// expire. At zero new jobs don't start; nothing is billed but the packs bought. Every account has every tool.

/** The ways to use the hosted service, in order. */
const SOLD: PlanId[] = ['free', 'credits', 'enterprise'];

export type Plan = {
  id: PlanId;
  name: string;
  price: string;
  per: string;
  /** Dollars, for structured data: the smallest pack, or $0; absent when agreed with us. */
  amount?: number;
  included: string;
  limits: string;
  note: string;
  pick?: boolean;
  /** Where the plan is started or asked for. */
  href: string;
};

const resolution = (side: number | null) =>
  side === null ? 'any size' : side >= 2160 ? '4K' : `${side}p`;
const storage = (gb: number | null) =>
  gb === null ? 'unlimited storage' : gb >= 1000 ? `${gb / 1000} TB storage` : `${gb} GB storage`;
const jobs = (n: number | null) =>
  n === null ? 'no job limit' : n === 1 ? 'one job at a time' : `${n} jobs at once`;
const num = (n: number) => n.toLocaleString('en-US');
/** "$0.20", "$0.14": a pack's price a credit. */
export const perCredit = (price: number, credits: number) => `$${(price / credits).toFixed(2)}`;

const SMALLEST = PACKS[0];
const LARGEST = PACKS.at(-1);
/** "$5 for 25 credits". */
export const FROM_PACK = SMALLEST ? `$${SMALLEST.price} for ${SMALLEST.credits} credits` : '';

/** The packs on sale, with each one's price a credit. */
export const PACK_ROWS = PACKS.map((p) => ({
  ...p,
  per_credit: perCredit(p.price, p.credits),
}));

export const PLANS: Plan[] = SOLD.map((id) => {
  const p = ALL[id];
  const l = p.limits;
  const common = {
    id,
    name: p.name,
    note: p.note,
    limits: `${jobs(l.jobs)[0]?.toUpperCase()}${jobs(l.jobs).slice(1)}, ${resolution(l.shortSide)}, ${storage(l.storageGb)}`,
  };
  if (id === 'free')
    return {
      ...common,
      price: '$0',
      per: 'no card',
      amount: 0,
      included: `${FREE_CREDITS} free credits`,
      href: '/start',
    };
  if (p.sold === 'contact')
    return {
      ...common,
      price: 'Talk to us',
      per: '',
      included: 'Credits and limits agreed on a call',
      limits: 'Start free now; move up when we have talked',
      href: `mailto:${SUPPORT_EMAIL}?subject=cuttingfloor%20Enterprise`,
    };
  return {
    ...common,
    price: `From $${SMALLEST?.price}`,
    per: `for ${SMALLEST?.credits} credits`,
    ...(SMALLEST ? { amount: SMALLEST.price } : {}),
    included: `Packs of ${PACKS.map((k) => num(k.credits)).join(', ')} credits, never expire`,
    pick: true,
    href: '/start',
  };
});

// ---------- the /pricing page, /pricing.md and /pricing.json ----------
// One set of facts for the three, from the plans file and content/facts.ts, so they never disagree.

/** A column of the comparison: running it yourself, or one of the hosted plans. */
export type Option = {
  id: 'self-hosted' | PlanId;
  name: string;
  price: string;
  per: string;
  /** Dollars, for structured data: the smallest pack, or $0. Absent when agreed with us. */
  amount?: number;
  hosted: boolean;
  note: string;
  href: string;
  cta: string;
  pick?: boolean;
};

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
  ...PLANS.map(
    (p): Option => ({
      id: p.id,
      name: p.name,
      price: p.price,
      per: p.per,
      ...(p.amount !== undefined ? { amount: p.amount } : {}),
      hosted: true,
      note: p.note,
      href: p.href,
      cta: p.id === 'enterprise' ? 'Email us' : 'Start free',
      ...(p.pick ? { pick: true } : {}),
    }),
  ),
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
type Limits = (typeof ALL)[PlanId]['limits'];

/** One row of hosted cells, from a plan's limits. */
function hosted(cell: (l: Limits, id: PlanId) => Cell) {
  return Object.fromEntries(SOLD.map((id) => [id, cell(ALL[id].limits, id)])) as Record<
    PlanId,
    Cell
  >;
}

/** A limit row: Enterprise limits are agreed on a call, so the table shows no number for them. */
function limit(cell: (l: Limits, id: PlanId) => Cell) {
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
        if (id === 'free') return val('$0, no card');
        if (id === 'enterprise') return val('Agreed with us');
        return val(
          `Packs from ${FROM_PACK}${LARGEST ? ` to $${LARGEST.price} for ${num(LARGEST.credits)}` : ''}. No subscription`,
        );
      }),
    },
  },
  {
    label: 'Credits',
    cells: {
      'self-hosted': val('No limit: it runs on your machine'),
      ...hosted((_, id) => {
        if (id === 'free') return val(`${FREE_CREDITS} to start, no time limit`);
        if (id === 'enterprise') return val('Agreed with us');
        return val('As many as you buy; they never expire');
      }),
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
export const EVERY_PLAN_LEAD = `Every account, free included, has all ${TOOL_COUNT} tools. You pay only for the credits you use.`;

/** What the free credits come to, said conservatively: a 30-second export took 23.5 s (plans/pricing.md). */
export const FREE_GOES =
  'Enough to edit and export several short videos: a 30-second export takes well under one credit.';

/** What a credit is: the pricing page's ledger, said as separate facts. */
export const CREDIT = [
  'A credit is one minute of our servers working for you: an export, an import, a transcript, graphics, a voiceover or a cutout.',
  'Planning and editing the timeline cost nothing, and so do previews.',
  `A new account gets ${FREE_CREDITS} free credits, with no card and no time limit. ${FREE_GOES}`,
  `After that, buy credits in packs when you need them, from ${FROM_PACK}. They never expire, and there is no subscription.`,
  `When credits run out, new jobs (exports, imports, analysis) won’t start until you have credits again; editing and previews keep working. Ask again after. We email you when you have fewer than ${LOW_CREDITS} left, and you can turn on automatic top-up so a pack is bought for you.`,
  'Self-hosted has no credits at all: it runs on your own machine.',
] as const;

/** Hosted: how long things are kept (the server's media TTL, and a timeline's after last use). */
export const KEPT_DAYS = 7;
export const TIMELINE_HOURS = 24;
/** Where people export or keep files: the deletion rule, said plainly. */
export const KEEP_FILES = `Download what you want to keep: download links last a day, and files are kept ${KEPT_DAYS} days after you last use them.`;
export const KEPT = `On the hosted server, media and exports are kept ${KEPT_DAYS} days, timelines ${TIMELINE_HOURS} hours after last use.`;

const free = ALL.free.limits;

export const PRICING_FAQS = [
  {
    q: 'Is it free through Kazi?',
    a: `Yes. An account you connect from Kazi is free for good, with ${KAZI_CREDITS.toLocaleString('en-US')} credits a month instead of packs. If that account has already bought credits, it keeps them and stays pay as you go.`,
  },
  {
    q: 'Can I self-host for free?',
    a: `Yes. cuttingfloor is open source under ${LICENCE} and runs in one Docker image, the same image the hosted service runs. Clone the repository and run docker compose up -d; your agent connects to ${LOCAL_ADDRESS}. There are no credit limits on your own machine. Lip-sync needs your own sync. labs key and visual judgment needs a TypeSafe key; everything else runs in the image with no key.`,
  },
  {
    q: 'Do I need my own AI keys?',
    a: 'Hosted, only for lip-sync (create.lipsync), which uses your own sync. labs key: save it on your account page, where only its last four characters are shown, and sync. labs bills you per second. Transcripts, voiceover, cutouts, graphics and visual judgment are included. Self-hosted, lip-sync needs SYNC_API_KEY and visual judgment (judge.ask, media.analyze look, media.seek) needs TYPESAFE_API_KEY.',
  },
  {
    q: 'What happens when credits run out?',
    a: `Editing and previews keep working. New jobs such as exports, imports and analysis won’t start until you have credits again; buy more on your account page, then ask again. You are never charged for anything but the packs you buy. We email you when you have fewer than ${LOW_CREDITS} credits left; turn on automatic top-up and a pack of your choice is bought for you instead.`,
  },
  {
    q: 'How much do credits cost?',
    a: `${PACK_ROWS.map((p) => `$${p.price} for ${num(p.credits)} credits (${p.per_credit} each)`).join(', ')}. Bigger packs cost less a credit. Bought credits never expire.`,
  },
  {
    q: 'What is a credit?',
    a: 'One minute of our servers working for you: an export, an import, a transcript, graphics, a voiceover or a cutout. Editing the timeline and previews are free.',
  },
  {
    q: 'Is there a subscription to cancel?',
    a: 'No. You buy credits in packs when you want them, and nothing renews. Automatic top-up is off unless you turn it on, and you can turn it off any time on your account page. Unused credits from a pack bought in the last 14 days are refunded on request. Payments are by Stripe.',
  },
  {
    q: 'Is it free to try?',
    a: `Yes. Every new account gets ${FREE_CREDITS} free credits, with no card and no time limit: enough to edit about ${FREE_FOOTAGE_MINUTES} minutes of footage, since editing is free and a minute of exported video takes under one credit. It has every tool, one job at a time, exports up to ${free.shortSide}p and ${free.storageGb} GB of storage. Or watch the live demo first, with no sign-up.`,
  },
];
