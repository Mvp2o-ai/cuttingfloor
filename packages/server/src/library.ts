import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { MCP_APP_MIME } from './player.ts';
import type { ServerDeps } from './server.ts';
import { SERVER_VERSION } from './version.ts';

/**
 * The library an MCP Apps host (io.modelcontextprotocol/ui) shows with media.list results: what
 * is on the floor, in cuttingfloor's own colours so it reads as this server's and not the chat
 * app's file list. Picking a row previews it from media.get's signed file; Use in chat sends the
 * person's pick to the agent with ui/message when the host offers it.
 */
export const LIBRARY_URI = 'ui://cuttingfloor/library';

/** `_meta` for a tool whose results the library shows. */
export const LIBRARY_TOOL_META = { ui: { resourceUri: LIBRARY_URI } };

export function registerLibrary(server: McpServer, deps: ServerDeps): void {
  // Previews load the file (and a font's glyphs) from this server; clipboard-write backs Copy id.
  const ui = {
    csp: { resourceDomains: [new URL(deps.runtime.config.publicUrl).origin] },
    permissions: { clipboardWrite: {} },
    prefersBorder: false,
  };
  server.registerResource(
    'library',
    LIBRARY_URI,
    {
      title: 'Library',
      description:
        'Lists the media on the floor and previews each one in the chat (MCP Apps view).',
      mimeType: MCP_APP_MIME,
      _meta: { ui },
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: LIBRARY_HTML, _meta: { ui } }],
    }),
  );
}

// The page is library.html next to this file; only the version is filled in.
const LIBRARY_HTML = readFileSync(new URL('./library.html', import.meta.url), 'utf8').replace(
  '__VERSION__',
  SERVER_VERSION,
);
