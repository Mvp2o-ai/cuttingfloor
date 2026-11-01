import { MCP_ADDRESS } from '../seo.ts';

// How each agent adds the hosted server, one line each, for the Markdown versions and llms.txt.
// The same steps as the connect tabs and the FAQ. Kazi is ours, so it leads.

export type ConnectLine = { agent: string; how: string; line?: string };

export const CONNECT_LINES: ConnectLine[] = [
  {
    agent: 'Kazi',
    how: 'In Kazi (app.apifunnel.ai), open Servers, add your own server, paste the address, Connect, then sign in.',
    line: MCP_ADDRESS,
  },
  {
    agent: 'Claude',
    how: 'Settings → Connectors → Add custom connector. Paste the address, then sign in.',
    line: MCP_ADDRESS,
  },
  {
    agent: 'Claude Cowork',
    how: 'Cowork uses Claude’s connectors: add cuttingfloor as a custom connector in Claude once, then ask for the edit in a Cowork task.',
  },
  {
    agent: 'Claude Code',
    how: 'Run this, then /mcp to sign in.',
    line: `claude mcp add --transport http cuttingfloor ${MCP_ADDRESS}`,
  },
  {
    agent: 'ChatGPT',
    how: 'Open Plugins, choose Add custom MCP server, paste the address and sign in.',
    line: MCP_ADDRESS,
  },
  {
    agent: 'ChatGPT Work',
    how: 'Add the custom MCP plugin in ChatGPT as above, then ask for the edit in a Work task.',
  },
  {
    agent: 'Codex',
    how: 'Run this, then `codex mcp login cuttingfloor` to sign in. Works in the CLI, the IDE extension and the desktop app.',
    line: `codex mcp add cuttingfloor --url ${MCP_ADDRESS}`,
  },
  {
    agent: 'Cursor',
    how: 'Add to ~/.cursor/mcp.json. Cursor opens the sign-in when a tool first runs.',
    line: `{ "mcpServers": { "cuttingfloor": { "url": "${MCP_ADDRESS}" } } }`,
  },
];

/** `- **Claude Code**: Run this, then /mcp to sign in. `claude mcp add …`` */
export const connectMarkdown = () =>
  CONNECT_LINES.map((c) => `- **${c.agent}**: ${c.how}${c.line ? ` \`${c.line}\`` : ''}`).join(
    '\n',
  );
