'use client';

import { useState } from 'react';

export const MCP_URL = 'https://cuttingfloorai.apifunnel.ai/mcp';

// Kazi is ours, so it leads, in the accent.
const CLIENTS = [
  {
    name: 'Kazi',
    how: 'In Kazi (app.apifunnel.ai), open Servers and add your own server. Paste the address, Connect, then sign in.',
    line: MCP_URL,
    ours: true,
  },
  {
    name: 'Claude',
    how: 'Settings → Connectors → Add custom connector. Paste the address, then sign in.',
    line: MCP_URL,
  },
  {
    name: 'Claude Code',
    how: 'Run this, then /mcp to sign in.',
    line: `claude mcp add --transport http cuttingfloor ${MCP_URL}`,
  },
  {
    name: 'Cursor',
    how: 'Add to ~/.cursor/mcp.json. Cursor opens the sign-in when you first use it.',
    line: `{ "mcpServers": { "cuttingfloor": { "url": "${MCP_URL}" } } }`,
  },
  {
    name: 'Codex',
    how: 'Run this, then codex mcp login cuttingfloor to sign in.',
    line: `codex mcp add cuttingfloor --url ${MCP_URL}`,
  },
  {
    name: 'ChatGPT',
    how: 'Settings → Apps → Create (developer mode). Paste the address, auth: OAuth.',
    line: MCP_URL,
  },
] as const;

export function Connect() {
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const client = CLIENTS[tab] ?? CLIENTS[0];

  return (
    <div className="connect">
      <div className="connect-tabs" role="tablist">
        {CLIENTS.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="tab"
            aria-selected={i === tab}
            className={'ours' in c && c.ours ? 'ours' : undefined}
            onClick={() => {
              setTab(i);
              setCopied(false);
            }}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="connect-body">
        <p>{client.how}</p>
        <div className="code-line">
          <code>{client.line}</code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(client.line).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
