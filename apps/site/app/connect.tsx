'use client';

import { useState } from 'react';
import { ALLOW_ACCESS, allowAccessNote, HOME_CLIENTS, MCP_URL } from '../content/clients.ts';
import { SendToSelf } from './agents/send.tsx';

export { MCP_URL };

// The short version of /connect: the main apps, one line each. Steps live in content/clients.ts.
// Kazi is ours, so it leads, in the accent.
export function Connect() {
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const client = HOME_CLIENTS[tab] ?? HOME_CLIENTS[0];
  if (!client) return null;

  return (
    <div className="connect">
      <div className="connect-tabs" role="tablist">
        {HOME_CLIENTS.map((c, i) => (
          <button
            key={c.slug}
            type="button"
            role="tab"
            aria-selected={i === tab}
            className={c.ours ? `ours${c.slug === 'kazi' ? ' kazi-word' : ''}` : undefined}
            data-track={`Connect tab: ${c.name}`}
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
        <p>{client.home.how}</p>
        <div className="code-line">
          <code>{client.home.line}</code>
          <button
            type="button"
            data-track={`Copy connect: ${client.name}`}
            onClick={() => {
              navigator.clipboard.writeText(client.home.line).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {client.localSignIn && (
          <p className="connect-more">
            {allowAccessNote(client.name)} <a href={ALLOW_ACCESS}>What does this mean?</a>
          </p>
        )}
        {/* Every app here but Kazi is added on a computer: a phone gets Kazi or the setup for later. */}
        {!client.ours && <SendToSelf app={client.name} />}
        <p className="connect-more">
          <a href={`/connect#${client.slug}`}>Full steps for {client.name}</a> ·{' '}
          <a href="/connect">Every app: Cowork, ChatGPT Work, VS Code, Zed, Goose and more</a>
        </p>
      </div>
    </div>
  );
}
