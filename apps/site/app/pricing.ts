import {
  PLANS as ALL,
  CLEAN_COPY_STEP,
  cleanCopyCredits,
  FREE_CREDITS,
  LOW_CREDITS,
  PACKS,
  type PlanId,
  SUPPORT_EMAIL,
} from '@cuttingfloor/plans';
import { KEYS, LICENCE, LOCAL_ADDRESS } from '../content/facts.ts';
import { TOOL_COUNT } from '../content/tools.ts';

// The pricing, worded from the one plans file the server enforces (packages/plans). Making is free:
// imports, edits, analysis, exports and generated graphics and voiceovers. Every exported video,
// GIF or image downloads free with a cuttingfloor watermark; the billable unit is a credit, one
// finished minute's watermark removed (cleanCopyCredits), paid once per export. There are no
// subscriptions: an account gets a few free credits when it is activated and buys packs when it
// wants more (pay as you go); bought credits never expire. Every account has every tool.

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
const num = (n: number) => n.toLocaleString('en-US');
/** "$0.20", "$0.14": a pack's price a credit. */
export const perCredit = (price: number, credits: number) => `$${(price / credits).toFixed(2)}`;

const SMALLEST = PACKS[0];
const LARGEST = PACKS.at(-1);
/** "0.75", "0.25", "1": a number of credits as the site writes it. */
export const credits = (n: number) => String(Number(n.toFixed(2)));
/** Removing the watermark from a 40-second Short, the worked example. */
export const SHORT_SECONDS = 40;
export const SHORT_CREDITS = credits(cleanCopyCredits(SHORT_SECONDS));
export const STEP_CREDITS = credits(CLEAN_COPY_STEP);
/** The clean-copy price in one line. */
export const CLEAN_PRICE = `1 credit per finished minute, in quarter-minute steps (a ${SHORT_SECONDS}-second Short is ${SHORT_CREDITS} credit)`;

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
    limits: `${resolution(l.shortSide)[0]?.toUpperCase()}${resolution(l.shortSide).slice(1)} exports, ${storage(l.storageGb)}`,
  };
  if (id === 'free')
    return {
      ...common,
      price: '$0',
      per: 'no card',
      amount: 0,
      included: `Making and watermarked downloads free; ${FREE_CREDITS} credits for removing watermarks`,
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
  note: `Open source under ${LICENCE}. The same Docker image the hosted service runs, on your own machine: no watermark, no limits, no credits. Bring your own keys where a feature needs one.`,
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
/** The judgment tools, as the key table names them, for the judgments row. */
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
    label: 'Making (edit, analyse, export, graphics, voiceover)',
    cells: {
      'self-hosted': yes('Free, no limits'),
      ...hosted(() => yes('Free, as much as you like')),
    },
  },
  {
    label: 'Downloads',
    cells: {
      'self-hosted': yes('Unmarked'),
      ...hosted(() => val('Free, with a cuttingfloor watermark')),
    },
  },
  {
    label: 'Removing the watermark',
    cells: {
      'self-hosted': yes('Every file, no credits'),
      ...hosted((_, id) =>
        id === 'enterprise' ? val('Agreed with us') : val(`${CLEAN_PRICE}, once per export`),
      ),
    },
  },
  {
    label: 'Credits',
    cells: {
      'self-hosted': val('None needed'),
      ...hosted((_, id) => {
        if (id === 'free') return val(`${FREE_CREDITS} when you activate your account`);
        if (id === 'enterprise') return val('Agreed with us');
        return val('As many as you buy; they never expire');
      }),
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
    label: `Visual judgments (${JUDGMENT_TOOLS.join(', ')})`,
    cells: {
      'self-hosted': key(judgment?.selfHosted ?? ''),
      ...hosted(() => yes('Included, no key')),
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
export const EVERY_PLAN_LEAD = `Every account, free included, has all ${TOOL_COUNT} tools, and making is free. You pay only to remove the watermark.`;

/** Making, in one line: what costs nothing. */
export const MAKING_FREE =
  'Making is free: import, edit, caption, analyse, export, and create motion graphics and voiceovers as much as you like. Retries cost nothing.';
/** Downloads, in one line: what has the watermark. */
export const MARKED =
  'Every video, GIF or image you export downloads free, at full quality, with a cuttingfloor watermark.';
/** What is never marked. */
export const NEVER_MARKED =
  'Audio (WAV, MP3, voiceovers), captions and transcripts, project files (SRT, VTT, FCPXML, OTIO, EDL) and your own uploads are never watermarked.';

/** What a credit is: the pricing page's ledger, said as separate facts. */
export const CREDIT = [
  MAKING_FREE,
  MARKED,
  `Removing the watermark costs ${CLEAN_PRICE}. The least is ${STEP_CREDITS} credit, a still image is ${STEP_CREDITS}, and 4K costs the same as HD. You pay once per export; every later download of it is clean.`,
  NEVER_MARKED,
  `A new account gets ${FREE_CREDITS} free credits when you activate it, with no card. After that, buy credits in packs when you need them, from ${FROM_PACK}. They never expire, and there is no subscription.`,
  `Out of credits, everything keeps working: making, previews and watermarked downloads. Removing watermarks waits until you have credits again. We email you when you have fewer than ${LOW_CREDITS} left, and you can turn on automatic top-up so a pack is bought for you.`,
  'Self-hosted has no credits and no watermark: no limits, on your own machine.',
] as const;

/** Hosted: how long things are kept (the server's media TTL, and a timeline's after last use). */
export const KEPT_DAYS = 7;
export const TIMELINE_HOURS = 24;
/** Where people export or keep files: the deletion rule, said plainly. */
export const KEEP_FILES = `Download what you want to keep: download links last ${KEPT_DAYS} days, and files are kept ${KEPT_DAYS} days after you last use them.`;
export const KEPT = `On the hosted server, media and exports are kept ${KEPT_DAYS} days, timelines ${TIMELINE_HOURS} hours after last use.`;

const free = ALL.free.limits;

export const PRICING_FAQS = [
  {
    q: 'Can I self-host for free?',
    a: `Yes. cuttingfloor is open source under ${LICENCE} and runs in one Docker image, the same image the hosted service runs. Clone the repository and run docker compose up -d; your agent connects to ${LOCAL_ADDRESS}. On your own machine there are no credits and no watermark, no limits. Lip-sync needs your own sync. labs key and visual judgment needs a TypeSafe key; everything else runs in the image with no key.`,
  },
  {
    q: 'Do I need my own AI keys?',
    a: 'Hosted, only for lip-sync (create.lipsync), which uses your own sync. labs key: save it on your account page, where only its last four characters are shown, and sync. labs bills you per second. Transcripts, voiceover, cutouts, graphics and visual judgment are included. Self-hosted, lip-sync needs SYNC_API_KEY and visual judgment (judge.ask, media.analyze look, media.seek) needs TYPESAFE_API_KEY.',
  },
  {
    q: 'What happens when credits run out?',
    a: `Nothing stops. Making, previews and downloads keep working, and your exports still download free with a cuttingfloor watermark. Removing watermarks waits until you have credits again; buy more on your account page. You are never charged for anything but the packs you buy. We email you when you have fewer than ${LOW_CREDITS} credits left; turn on automatic top-up and a pack of your choice is bought for you instead.`,
  },
  {
    q: 'How much do credits cost?',
    a: `${PACK_ROWS.map((p) => `$${p.price} for ${num(p.credits)} credits (${p.per_credit} each)`).join(', ')}. Bigger packs cost less a credit. Bought credits never expire.`,
  },
  {
    q: 'What is a credit?',
    a: `It removes the watermark from one finished minute of an export. It is counted in quarter-minute steps, so a ${SHORT_SECONDS}-second Short is ${SHORT_CREDITS} credit, a still image ${STEP_CREDITS}, and 4K costs the same as HD. You pay once per export; every later download of it is clean. Making the video costs nothing.`,
  },
  {
    q: 'What does the cuttingfloor watermark look like?',
    a: `${MARKED} The watermark is our name and shapes that fade in and out across the picture, so the video stays watchable to check and share. ${NEVER_MARKED}`,
  },
  {
    q: 'Is there a subscription to cancel?',
    a: 'No. You buy credits in packs when you want them, and nothing renews. Automatic top-up is off unless you turn it on, and you can turn it off any time on your account page. Unused credits from a pack bought in the last 14 days are refunded on request. Payments are by Stripe.',
  },
  {
    q: 'Is it free to try?',
    a: `Yes. Making is free on every account, with no card: every tool, exports up to ${free.shortSide}p and ${free.storageGb} GB of storage, and every export downloads free with a cuttingfloor watermark. A new account gets ${FREE_CREDITS} credits when you activate it, for removing watermarks. Or watch the live demo first, with no sign-up.`,
  },
];
