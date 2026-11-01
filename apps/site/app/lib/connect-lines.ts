import { CLIENTS } from '../../content/clients.ts';

// How each agent adds the hosted server, one line each, for the Markdown versions and llms.txt.
// Read from the same clients file as /connect and the home page's Connect box, so they agree.

export type ConnectLine = { agent: string; how: string; line?: string };

export const CONNECT_LINES: ConnectLine[] = CLIENTS.map((c) => ({
  agent: c.name,
  how: c.home?.how ?? c.steps.join(' '),
  ...(c.home ? { line: c.home.line } : {}),
}));

export const connectMarkdown = () =>
  CONNECT_LINES.map((c) => `- **${c.agent}**: ${c.how}${c.line ? ` \`${c.line}\`` : ''}`).join(
    '\n',
  );
