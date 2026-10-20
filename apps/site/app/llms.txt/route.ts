import { DEMOS } from '../../content/demos.ts';
import { SKILLS } from '../../content/skills.ts';
import { PLANS } from '../pricing.ts';
import { ALTERNATIVES, DESCRIPTION, DOCS_URL, FAQS, MCP_ADDRESS, SITE_URL } from '../seo.ts';

// llms.txt (llmstxt.org): the page in plain Markdown for language models, built from the same data.
export const dynamic = 'force-static';

export function GET() {
  const body = [
    '# cuttingfloor',
    '',
    `> ${DESCRIPTION}`,
    '',
    'cuttingfloor is a headless video editor and video editing MCP server. Connect an AI agent (Kazi, Claude, Claude Code, Cursor, ChatGPT in developer mode, VS Code) and it becomes a video editing agent: it imports footage, transcribes it, cuts on words, adds captions, mixes audio to a loudness target, makes graphics and voiceovers, checks its work and exports an MP4.',
    '',
    '## Connect',
    '',
    `- MCP server: ${MCP_ADDRESS} (Streamable HTTP, OAuth sign-in)`,
    `- Claude Code: \`claude mcp add --transport http cuttingfloor ${MCP_ADDRESS}\``,
    `- Cursor: \`{ "mcpServers": { "cuttingfloor": { "url": "${MCP_ADDRESS}" } } }\` in ~/.cursor/mcp.json`,
    '- Claude: Settings → Connectors → Add custom connector',
    '- ChatGPT: Settings → Apps → Create (developer mode), auth OAuth',
    '',
    '## Links',
    '',
    `- [Home](${SITE_URL}): overview, pricing and sign-up`,
    `- [Source and docs](${DOCS_URL}): open source, runs in one Docker image`,
    `- [Skills](${SITE_URL}/skills): step-by-step instructions an agent follows with cuttingfloor's tools`,
    `- [Demos](${SITE_URL}/demos): real clips edited by an agent with cuttingfloor connected, before and after`,
    '',
    '## Demos',
    '',
    ...DEMOS.map((d) => `- [${d.title}](${SITE_URL}/demos/${d.slug}): ${d.description}`),
    '',
    '## Skills',
    '',
    "A connected agent finds these itself: skills.search {query} in the user's words, then skills.get {slug} for the whole skill.",
    '',
    ...SKILLS.map((s) => `- [${s.title}](${SITE_URL}/skills/${s.slug}): ${s.description}`),
    '',
    '## Pricing',
    '',
    ...PLANS.map(
      (p) =>
        `- ${p.name}: ${[p.price, p.per].filter(Boolean).join(' ')}, ${p.included}. ${p.limits}. ${p.note}`,
    ),
    '',
    "A render minute is one minute of a job running (export, import, transcript, graphics, voiceover, cutout). Editing the timeline is free. At a plan's minutes new jobs wait for the renewal; nothing is billed past the price.",
    '',
    '## Compared with alternatives',
    '',
    ...ALTERNATIVES.map((a) => `- ${a.name}: ${a.is} Pick it when ${a.when}`),
    '',
    '## FAQ',
    '',
    ...FAQS.flatMap((f) => [`### ${f.q}`, '', f.a, '']),
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
