'use client';

import { useState } from 'react';
import { MCP_URL } from '../content/clients.ts';

// The server address in the hero, with a copy button: the one thing a visitor pastes into their app.
export function McpAddress({ track = 'Copy: MCP address (hero)' }: { track?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-line mcp-address">
      <code>{MCP_URL}</code>
      <button
        type="button"
        data-track={track}
        onClick={() => {
          navigator.clipboard.writeText(MCP_URL).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
