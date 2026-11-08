import { FREE_CREDITS } from '@cuttingfloor/plans';
import { IMAGE, LICENCE, LOCAL_ADDRESS, REPO_URL, SELF_HOST_STEPS } from '../../content/facts.ts';
import {
  DESKTOP_TOOLS,
  TOOLKIT_HEADLINE,
  TOOLKIT_LEDE,
  TOOLKIT_LINE,
} from '../../content/toolkit.ts';
import { kaziUrl } from '../kazi.tsx';
import { connectMarkdown } from '../lib/connect-lines.ts';
import { CREDIT_TEXT, keysMarkdown, priceText } from '../lib/facts-markdown.ts';
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

## ${TOOLKIT_HEADLINE}

${TOOLKIT_LEDE} ${TOOLKIT_LINE}

${DESKTOP_TOOLS.map((r) => `- ${r.does}: ${r.tools.map((t) => `\`${t}\``).join(', ')}`).join('\n')}

Hosted video MCPs side by side, including which have their own AI inside: ${pageLink('Compare', '/compare')}

## Try it live

A free live demo, no sign-up: ${kaziUrl('demos')} opens Kazi in the browser, which gives Big Buck Bunny a happy ending on cuttingfloor and plays the finished video. ${pageLink('Demos', '/demos')}

## Run it

- Hosted: \`${MCP_ADDRESS}\` (Streamable HTTP, OAuth sign-in). Start with ${FREE_CREDITS} free credits: no card, no time limit, every tool. Then pay as you go.
- Self-hosted: free and open source (${LICENCE}), one Docker image (\`${IMAGE}\`): \`${SELF_HOST_STEPS.join(' && ')}\`, then connect to \`${LOCAL_ADDRESS}\`. ${pageLink('Self-host', '/self-host')}

## Pricing

${PLANS.map((p) => `- ${p.name}: ${priceText(p)}, ${p.included}. ${p.limits}.`).join('\n')}
- Self-hosted: free (${LICENCE}), no minute limits.

${CREDIT_TEXT} Details: ${pageLink('Pricing', '/pricing')}, [pricing.json](${abs('/pricing.json')})

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
