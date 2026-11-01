import { KEYS, NO_KEY } from '../../content/facts.ts';
import { TOOL_COUNT } from '../../content/tools.ts';
import {
  DESCRIPTION,
  GROUPS,
  keyNeed,
  runs,
  TITLE,
  TOOL_ROWS,
  UPDATED,
} from '../features/content.ts';
import { cell } from '../lib/markdown.ts';
import { SITE_URL } from '../seo.ts';

// /features as Markdown, for agents: the same data as the page.

const code = (tools: string[]) => tools.map((t) => `\`${t}\``).join(', ');

export function markdown(): string {
  const body = [
    `# ${TITLE}`,
    '',
    `> ${DESCRIPTION}`,
    '',
    `Canonical: ${SITE_URL}/features · Updated ${UPDATED}`,
    '',
    `cuttingfloor is an open-source video editing MCP server: connect Claude, ChatGPT, Cursor or Kazi and your agent gets ${TOOL_COUNT} editing tools. It cuts by what was said, captions, mixes and levels the sound, makes graphics and voiceovers, checks its own work and exports an MP4 or the edit for your editing app.`,
    '',
    ...GROUPS.flatMap((g) => [
      `## ${g.name}`,
      '',
      g.intro,
      '',
      ...g.items.map((i) => `- ${i.say} (${code(i.tools)})`),
      '',
    ]),
    '## What needs your own key',
    '',
    '| Feature | Tools | Hosted | Self-hosted |',
    '| --- | --- | --- | --- |',
    ...KEYS.map(
      (k) =>
        `| ${cell(k.feature)} | ${code(k.tools)} | ${cell(k.hosted)} | ${cell(k.selfHosted)} |`,
    ),
    '',
    'No key, hosted or self-hosted:',
    '',
    ...NO_KEY.map((n) => `- ${n}`),
    '',
    `Plans and what they include: ${SITE_URL}/pricing`,
    '',
    `## All ${TOOL_COUNT} tools`,
    '',
    '| Tool | What it does | Group | Runs | Your key |',
    '| --- | --- | --- | --- | --- |',
    ...TOOL_ROWS.map(
      (t) =>
        `| \`${t.name}\` | ${cell(t.say)} | ${t.group} | ${runs(t)} | ${keyNeed(t.name) || 'None'} |`,
    ),
    '',
  ].join('\n');
  return body;
}
