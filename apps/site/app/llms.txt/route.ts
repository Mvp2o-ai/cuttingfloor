import { TRIAL_DAYS } from '@cuttingfloor/plans';
import { IMAGE, LICENCE, LOCAL_ADDRESS, REPO_URL, SELF_HOST_STEPS } from '../../content/facts.ts';
import { connectMarkdown } from '../lib/connect-lines.ts';
import { keysMarkdown, priceText, RENDER_MINUTE } from '../lib/facts-markdown.ts';
import { abs, pageLink } from '../lib/markdown.ts';
import { PLANS } from '../pricing.ts';
import { ROUTES } from '../routes.ts';
import { DESCRIPTION, MCP_ADDRESS } from '../seo.ts';

// llms.txt (llmstxt.org), written for an agent deciding whether and how to use cuttingfloor: what it
// is, how to run it, what it costs, what needs a key, how to connect, and every page with its
// Markdown twin. Pages come from ROUTES, so a new page is listed once it is added there.
export const dynamic = 'force-static';

export function GET() {
  const body = `# cuttingfloor

> ${DESCRIPTION}

cuttingfloor is video editing tools for your agent, not an editor with an AI inside. It is an open-source MCP server: your own agent (Kazi, Claude, ChatGPT, Codex, Cursor or any MCP client) calls its granular tools to import footage, transcribe it, cut on words, caption, mix to a loudness target, make graphics and voiceovers, check its work with previews and export an MP4, FCPXML, OTIO or EDL. The judgment is the agent's; cuttingfloor makes the edits and reports facts (transcripts, speech edges, frames, loudness). Connected agents find step-by-step methods with \`skills.search\` and \`skills.get\`.

## Run it

- Hosted: \`${MCP_ADDRESS}\` (Streamable HTTP, OAuth sign-in). Free ${TRIAL_DAYS}-day trial, no card.
- Self-hosted: free and open source (${LICENCE}), one Docker image (\`${IMAGE}\`): \`${SELF_HOST_STEPS.join(' && ')}\`, then connect to \`${LOCAL_ADDRESS}\`. ${pageLink('Self-host', '/self-host')}

## Pricing

${PLANS.map((p) => `- ${p.name}: ${priceText(p)}, ${p.included}. ${p.limits}.`).join('\n')}
- Self-hosted: free (${LICENCE}), no minute limits.

${RENDER_MINUTE} Details: ${pageLink('Pricing', '/pricing')}, [pricing.json](${abs('/pricing.json')})

## What needs your own key

${keysMarkdown()}

## Connect

${connectMarkdown()}

Self-hosted, use the local address instead of the hosted one. Server card: ${MCP_ADDRESS}/server-card · Catalog: ${abs('/.well-known/ai-catalog.json')}

## Pages

Every page has a Markdown twin at its path plus \`.md\` (home: /index.md), also served for \`Accept: text/markdown\`. All key pages in one file: [llms-full.txt](${abs('/llms-full.txt')})

${ROUTES.map((r) => `- ${pageLink(r.title, r.path)}`).join('\n')}
- [Source and docs](${REPO_URL})
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
