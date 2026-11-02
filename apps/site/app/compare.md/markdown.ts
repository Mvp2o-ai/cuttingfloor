import {
  ALSO,
  APP_COLUMNS,
  APPS,
  AS_OF,
  COMPARED_ON,
  MARKS,
  OUR_NOTES,
  SERVER_COLUMNS,
  SERVERS,
} from '../../content/compare.ts';
import { cell } from '../lib/markdown.ts';
import { SITE_URL } from '../seo.ts';

// /compare as Markdown, for agents deciding between tools: the same data as the page.

const row = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
const table = (head: string[], rows: string[][]) => [
  row(head),
  row(head.map(() => '---')),
  ...rows.map(row),
];

export function markdown(): string {
  const body = [
    '# Compare AI video editing: MCP servers, APIs and editing apps',
    '',
    `> cuttingfloor is editing tools for your agent, not an editor with an agent inside. ${AS_OF}, checked ${COMPARED_ON}. "?" means not confirmed in the product's own docs.`,
    '',
    `Canonical page: ${SITE_URL}/compare`,
    '',
    '## Two kinds of AI video editing',
    '',
    '- An editor with an AI inside: Descript (Underlord), CapCut, VEED, Kapwing, OpusClip, invideo. You open their app and their AI works in it, on their credits. Agent access, when offered, is often a way to send a request to that AI.',
    '- Editing tools for your agent: cuttingfloor. You stay in Claude, ChatGPT, Codex, Cursor or Kazi and connect one open-source MCP server, hosted or self-hosted. The agent makes each edit (cut, trim, caption, mix, effects, export) and sees the result after every edit.',
    '',
    'Forwarding a prompt: Descript\'s API and MCP have one editing call, a job that takes a written request ("remove the section from 1:30 to 2:15") and hands it to Underlord. There is no cut, trim, caption or render call, and no picture of the result is documented coming back. Import, search, publish and transcript export are direct calls. VideoDB\'s call_director works the same way.',
    '',
    'Why editing tools matter:',
    '',
    '1. Control: each tool does exactly what its arguments say.',
    '2. The edit stays editable: every edit is a new timeline version, earlier ones stay, and the edit exports as FCPXML, OTIO or EDL for Final Cut Pro, Premiere or Resolve.',
    '3. Your agent’s judgment: the agent you picked, with your instructions and context, decides the cuts.',
    '4. No lock-in: open source (AGPL-3.0); hosted and self-hosted are the same Docker image.',
    '',
    'Seeing the result: Frapea (contact sheets), Tella (frame checks) and the Resolve and Premiere bridges (still exports) also let an agent look. cuttingfloor returns a preview with every edit without asking (frames, or a waveform with measured loudness), plus qa.check (gaps, black frames, silences, loudness, cuts through words) and media.seek (find a moment in plain words).',
    '',
    '## Video servers and APIs an agent can call',
    '',
    ...table(
      ['Product', ...SERVER_COLUMNS.map((c) => c.label)],
      SERVERS.map((s) => [s.name, ...SERVER_COLUMNS.map((c) => s.cells[c.key])]),
    ),
    '',
    '## Editing apps, feature by feature',
    '',
    `Marks: ${Object.entries(MARKS)
      .map(([k, v]) => `${k} = ${v}`)
      .join(', ')}. "Higher plan or metered" means a paid tier or separate credits or minutes.`,
    '',
    ...table(
      ['App', ...APP_COLUMNS.map((c) => c.label), 'Agent access', 'Self-host'],
      APPS.map((a) => [a.name, ...APP_COLUMNS.map((c) => a.marks[c.key]), a.agent, a.selfHost]),
    ),
    '',
    'How cuttingfloor does each:',
    '',
    ...APP_COLUMNS.map((c) => `- ${c.label}: ${OUR_NOTES[c.key]}`),
    '',
    "None of these apps asks for your own AI provider key; cuttingfloor does for lip-sync only (sync. labs). Motion graphics are left out of the table: they could not be confirmed across the apps. cuttingfloor's create.motion renders animated HTML with transparency.",
    '',
    '## Pick it when',
    '',
    ...[...SERVERS, ...ALSO].map((s) => `- ${s.name}: ${s.is} Pick it when ${s.pick}`),
    '',
  ].join('\n');
  return body;
}
