import { CAPS } from '../../content/capabilities.ts';
import { DEMOS, lengths } from '../../content/demos.ts';
import { LICENCE } from '../../content/facts.ts';
import { AGENT_PAINS, EDITING_PAINS, type Pain } from '../../content/pains.ts';
import {
  DESKTOP_TOOLS,
  TOOLKIT_HEADLINE,
  TOOLKIT_LEDE,
  TOOLKIT_LINE,
} from '../../content/toolkit.ts';
import { connectMarkdown } from '../lib/connect-lines.ts';
import { CREDIT_TEXT, keysMarkdown, plansTable, selfHostMarkdown } from '../lib/facts-markdown.ts';
import { abs, doc, list, pageLink, table } from '../lib/markdown.ts';
import { PROMPTS } from '../prompts.tsx';
import { ALTERNATIVES, DESCRIPTION, FAQS, MCP_ADDRESS } from '../seo.ts';

// The home page as Markdown, built from the data its sections render: pains, prompts,
// capabilities, plans, keys, alternatives, demos and the FAQ.

const pains = (rows: Pain[]) =>
  table(
    ['The problem', 'What your agent does with cuttingfloor', 'Tools'],
    rows.map((r) => [r.pain, r.answer, r.tools.map((t) => `\`${t}\``).join(', ') || '—']),
  );

export function markdown(): string {
  return doc({
    path: '/',
    title: 'cuttingfloor: editing tools for the agent you already use',
    summary: DESCRIPTION,
    body: `
## What it is

cuttingfloor is an open-source MCP server of video editing tools. Connect the agent you already use (Kazi, Claude, Claude Cowork, Claude Code, ChatGPT, ChatGPT Work, Codex or Cursor) and say what you want cut. It imports your footage, reads the transcript, trims, captions, mixes, makes the graphics and hands back a finished file.

## ${TOOLKIT_HEADLINE}

${TOOLKIT_LEDE} ${TOOLKIT_LINE}

${table(
  ['In a desktop editor', 'The tools your agent calls'],
  DESKTOP_TOOLS.map((r) => [r.does, r.tools.map((t) => `\`${t}\``).join(', ')]),
)}

How the other hosted video MCPs compare (most are editor apps with their own AI inside): ${pageLink('Compare', '/compare')}

- **Real editing verbs.** Cut, trim, split, speed, caption, mix, grade, animate: each a tool your agent calls.
- **It checks its own work.** A preview comes back with every edit, plus exact checks for gaps, black frames, clipping and sync.
- **The edit stays yours.** Every edit is a timeline you can step back to, or open in your own editor as FCPXML, OTIO or EDL. Open source (${LICENCE}): run it yourself, or let us host it.

## Connect your agent

Hosted MCP server: \`${MCP_ADDRESS}\` (Streamable HTTP, OAuth sign-in).

${connectMarkdown()}

Full setup: ${pageLink('Connect', '/connect')}

## Run it yourself

${selfHostMarkdown()}

## The jobs it solves

### The ten slowest editing jobs

${pains(EDITING_PAINS)}

### Where AI editing goes wrong, and what is different

${pains(AGENT_PAINS)}

Every tool: ${pageLink('Features', '/features')}

## Things to ask for

${list(PROMPTS)}

## What it does

${CAPS.map(
  (c) =>
    `### ${c.title}\n\n${c.body}\n\n\`\`\`\n${c.code.map(([fn, args]) => `${fn} ${args}`).join('\n\n')}\n\`\`\`\n\n${c.note}.`,
).join('\n\n')}

## Pricing

${plansTable()}

${CREDIT_TEXT} Payments by Stripe; nothing renews.

Full pricing: ${pageLink('Pricing', '/pricing')}

## What needs your own key

${keysMarkdown()}

## Compared with alternatives

${table(
  ['Tool', 'What it is', 'Pick it when'],
  ALTERNATIVES.map((a) => [a.name, a.is, a.when]),
)}

Full comparison: ${pageLink('Compare', '/compare')}

## Demos

${list(DEMOS.map((d) => `${pageLink(d.title, `/demos/${d.slug}`)}: ${d.description} (${d.agent}, ${lengths(d)})`))}

## Questions

${FAQS.map((f) => `### ${f.q}\n\n${f.a}`).join('\n\n')}

## More

- ${pageLink('Skills', '/skills')}: step-by-step methods your agent follows with these tools
- ${pageLink('Walkthroughs', '/walkthroughs')}: real prompts and every tool call
- [Everything as one file](${abs('/llms-full.txt')})
`,
  });
}
