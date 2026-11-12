import { SUPPORT_EMAIL } from '@cuttingfloor/plans';
import {
  IMAGE,
  KEYS,
  LICENCE,
  LOCAL_ADDRESS,
  NO_KEY,
  REPO_URL,
  SELF_HOST_STEPS,
} from '../../content/facts.ts';
import { cell } from '../lib/markdown.ts';
import {
  CREDIT,
  EVERY_PLAN,
  EVERY_PLAN_LEAD,
  KEEP_FILES,
  KEPT,
  markWord,
  OPTIONS,
  PACK_ROWS,
  PRICING_FAQS,
  ROWS,
} from '../pricing.ts';
import { SITE_URL } from '../seo.ts';

// /pricing as Markdown, for agents and AI search, built from the same data as the page.

export function markdown(): string {
  const body = [
    '# cuttingfloor pricing',
    '',
    `> Free to self-host: open source under ${LICENCE}, the same Docker image the hosted service runs, on your own machine with no credit limits. Hosted: pay as you go. Start with free credits, no card, then buy credit packs that never expire; no subscription. Everyone has every tool. A credit is a minute of a job running; editing and previews are free. Prices in US dollars.`,
    '',
    `Page: ${SITE_URL}/pricing · JSON: ${SITE_URL}/pricing.json`,
    '',
    '## Credit packs',
    '',
    '| Pack | Credits | A credit |',
    '|---|---|---|',
    ...PACK_ROWS.map(
      (p) => `| $${p.price} | ${p.credits.toLocaleString('en-US')} | ${p.per_credit} |`,
    ),
    '',
    '## Ways to run it',
    '',
    ...OPTIONS.map(
      (o) =>
        `- **${o.name}**: ${[o.price, o.per].filter(Boolean).join(' ')}. ${o.note} ${new URL(o.href, SITE_URL).toString()}`,
    ),
    '',
    '## Everyone gets',
    '',
    EVERY_PLAN_LEAD,
    '',
    ...EVERY_PLAN.map((f) => `- ${f}`),
    '',
    KEEP_FILES,
    '',
    '## What differs',
    '',
    `| | ${OPTIONS.map((o) => o.name).join(' | ')} |`,
    `|---|${OPTIONS.map(() => '---').join('|')}|`,
    ...ROWS.map(
      (r) =>
        `| ${cell(r.label)} | ${OPTIONS.map((o) => {
          const c = r.cells[o.id];
          return cell(c.mark === 'value' ? c.text : `${markWord(c.mark)}: ${c.text}`);
        }).join(' | ')} |`,
    ),
    '',
    KEPT,
    '',
    '## What a credit is',
    '',
    ...CREDIT.map((l) => `- ${l}`),
    '',
    '## What needs your own key',
    '',
    '| Feature | Tools | Hosted | Self-hosted |',
    '|---|---|---|---|',
    ...KEYS.map(
      (k) =>
        `| ${cell(k.feature)} | ${k.tools.map((t) => `\`${t}\``).join(', ')} | ${cell(k.hosted)} | ${cell(k.selfHosted)} |`,
    ),
    '',
    'No key needed, hosted or self-hosted (built into the image and run on the server):',
    '',
    ...NO_KEY.map((n) => `- ${n}`),
    '',
    '## Self-hosted · Free',
    '',
    `Open source under ${LICENCE}. One Docker image (${IMAGE}), the same image the hosted service runs. You run it on your own machine, with no credit limits, and bring your own keys for lip-sync and visual judgment.`,
    '',
    '```sh',
    ...SELF_HOST_STEPS,
    '```',
    '',
    `Your agent then connects to ${LOCAL_ADDRESS}. Setup: ${SITE_URL}/self-host · Source: ${REPO_URL}`,
    '',
    '## FAQ',
    '',
    ...PRICING_FAQS.flatMap((f) => [`### ${f.q}`, '', f.a, '']),
    `Questions: ${SUPPORT_EMAIL}`,
    '',
  ].join('\n');
  return body;
}
