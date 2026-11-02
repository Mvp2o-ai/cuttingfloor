import { CLIENTS, CLIENTS_CHECKED, MCP_URL } from '../../content/clients.ts';
import {
  CONNECT_DESCRIPTION,
  CONNECT_FAQS,
  CONNECT_LEAD,
  CONNECT_TITLE,
  HOW,
} from '../connect/copy.ts';
import { SITE_URL } from '../seo.ts';

// /connect in plain Markdown, for agents and people who'd rather read text. Built from the same
// data as the page.

export function markdown(): string {
  const body = [
    `# ${CONNECT_TITLE}`,
    '',
    `> ${CONNECT_DESCRIPTION}`,
    '',
    CONNECT_LEAD,
    '',
    `- MCP server: ${MCP_URL} (Streamable HTTP, OAuth sign-in)`,
    '- Scripts: a key from the account page, sent as `Authorization: Bearer cf_…`',
    `- Steps checked ${CLIENTS_CHECKED} against each app's own help pages`,
    `- Web page: ${SITE_URL}/connect`,
    '',
    '## How it works',
    '',
    ...HOW.map((h, i) => `${i + 1}. **${h.title}** ${h.text}`),
    '',
    ...CLIENTS.flatMap((c) => [
      `## ${c.name}`,
      '',
      `_${c.where}_`,
      '',
      ...c.steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      ...(c.install ? [`[${c.install.label}](${c.install.href})`, ''] : []),
      ...c.snippets.flatMap((s) => [`${s.label}:`, '', '```', s.code, '```', '']),
      ...(c.notes ? [...c.notes.map((n) => `- ${n}`), ''] : []),
      ...(c.docs ? [`${c.docsLabel ?? `${c.name}'s own help page`}: ${c.docs}`, ''] : []),
    ]),
    '## Questions',
    '',
    ...CONNECT_FAQS.flatMap((f) => [`### ${f.q}`, '', f.a, '']),
  ].join('\n');
  return body;
}
