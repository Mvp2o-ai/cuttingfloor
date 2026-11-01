import {
  IMAGE,
  KEYS,
  LICENCE,
  LOCAL_ADDRESS,
  NO_KEY,
  REPO_URL,
  SELF_HOST_STEPS,
} from '../../content/facts.ts';
import { PLANS, type Plan } from '../pricing.ts';
import { list, table } from './markdown.ts';

// The product facts as Markdown, for every twin and llms.txt that states them.

export const RENDER_MINUTE =
  'A render minute is one minute of a job running on the hosted servers (export, import, transcript, motion graphics, voiceover, cutout). Planning and editing the timeline are free. When a plan’s minutes are used, new jobs wait for the renewal or a bigger plan; nothing is ever billed past the plan price.';

/** "$49 / month", "$0 for 3 days", "Talk to us". */
export const priceText = (p: Plan) =>
  !p.per ? p.price : p.per.startsWith('/') ? `${p.price} ${p.per}` : `${p.price} for ${p.per}`;

/** One row per plan, self-hosted first. */
export function plansTable(): string {
  return table(
    ['Plan', 'Price', 'Included', 'Runs', 'For'],
    [
      [
        'Self-hosted',
        'Free',
        'No minute limits',
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
