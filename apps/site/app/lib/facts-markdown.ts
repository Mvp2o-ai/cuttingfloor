import {
  IMAGE,
  KEYS,
  LICENCE,
  LOCAL_ADDRESS,
  NO_KEY,
  REPO_URL,
  SELF_HOST_STEPS,
} from '../../content/facts.ts';
import { CLEAN_PRICE, MAKING_FREE, MARKED, NEVER_MARKED, PLANS, type Plan } from '../pricing.ts';
import { list, table } from './markdown.ts';

// The product facts as Markdown, for every twin and llms.txt that states them.

export const CREDIT_TEXT = `${MAKING_FREE} Everyone has every tool. ${MARKED} Removing the watermark costs ${CLEAN_PRICE}; 4K costs the same, and you pay once per export. ${NEVER_MARKED} Pay as you go: buy credit packs when you need them; they never expire and nothing renews. At zero, making and watermarked downloads keep working; removing watermarks waits for credits. Nothing is ever billed but the packs you buy.`;

/** "From $5 for 25 credits", "$0, no card", "Talk to us". */
export const priceText = (p: Plan) =>
  !p.per ? p.price : p.per.startsWith('for') ? `${p.price} ${p.per}` : `${p.price}, ${p.per}`;

/** One row per plan, self-hosted first. */
export function plansTable(): string {
  return table(
    ['Option', 'Price', 'Included', 'Runs', 'For'],
    [
      [
        'Self-hosted',
        'Free',
        'Unmarked, no limits, no credits',
        'Your machine, the same image',
        `Open source (${LICENCE}). Bring your own keys where needed.`,
      ],
      ...PLANS.map((p) => [p.name, priceText(p), p.included, p.limits, p.note]),
    ],
  );
}

/** What needs a key of your own, hosted and self-hosted, then what never does. */
export function keysMarkdown(): string {
  return [
    table(
      ['Feature', 'Tools', 'Hosted', 'Self-hosted'],
      KEYS.map((k) => [
        k.feature,
        k.tools.map((t) => `\`${t}\``).join(', '),
        k.hosted,
        k.selfHosted,
      ]),
    ),
    '',
    'Everything else needs no key, hosted or self-hosted; it is built into the image and runs on the server:',
    '',
    list(NO_KEY),
  ].join('\n');
}

export function selfHostMarkdown(): string {
  return [
    `Free and open source (${LICENCE}), one Docker image (\`${IMAGE}\`). Source: ${REPO_URL}`,
    '',
    '```sh',
    ...SELF_HOST_STEPS,
    '```',
    '',
    `The local server listens on \`${LOCAL_ADDRESS}\` (loopback only); point your agent there.`,
  ].join('\n');
}
