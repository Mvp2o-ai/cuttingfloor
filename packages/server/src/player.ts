import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from './server.ts';
import { SERVER_VERSION } from './version.ts';

/**
 * The player an MCP Apps host (io.modelcontextprotocol/ui) shows with export.video and media.get
 * results: it plays the signed file in the chat. While an export still runs (a client without
 * Tasks gets a job handle), it follows the job with job.get and plays the result when it lands.
 */
export const PLAYER_URI = 'ui://cuttingfloor/player';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

/** `_meta` for a tool whose results the player shows. */
export const PLAYER_TOOL_META = { ui: { resourceUri: PLAYER_URI } };

export function registerPlayer(server: McpServer, deps: ServerDeps): void {
  // The page loads the file from this server, so the host lets the sandbox fetch media from it;
  // clipboard-write backs its Copy link button.
  const ui = {
    csp: { resourceDomains: [new URL(deps.runtime.config.publicUrl).origin] },
    permissions: { clipboardWrite: {} },
    prefersBorder: false,
  };
  server.registerResource(
    'player',
    PLAYER_URI,
    {
      title: 'Player',
      description: 'Plays an export or a media file in the chat (MCP Apps view).',
      mimeType: MCP_APP_MIME,
      _meta: { ui },
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: PLAYER_HTML, _meta: { ui } }],
    }),
  );
}

// The page is player.html next to this file; only the version is filled in.
const PLAYER_HTML = readFileSync(new URL('./player.html', import.meta.url), 'utf8').replace(
  '__VERSION__',
  SERVER_VERSION,
);
