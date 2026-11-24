import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { FINAL_COPY_JS, MCP_APP_MIME, mediaOrigins, viewUi } from './player.ts';
import type { ServerDeps } from './server.ts';
import { SERVER_VERSION } from './version.ts';

/**
 * The editor an MCP Apps host (io.modelcontextprotocol/ui) shows with export.video results: the
 * export plays over the timeline it was rendered from (read with timeline.get on the call's
 * timeline_id), which scrubs frame by frame, even before the render lands. It is read-only. It
 * tells the agent where the person is looking with ui/update-model-context once the view
 * settles, and sends a note the person writes with ui/message.
 */
export const EDITOR_URI = 'ui://cuttingfloor/editor';

/** `_meta` for a tool whose results the editor shows. */
export const EDITOR_TOOL_META = { ui: { resourceUri: EDITOR_URI } };

export function registerEditor(server: McpServer, deps: ServerDeps): void {
  const origin = new URL(deps.runtime.config.publicUrl).origin;
  // The page plays the file from this server and reads its sound for the mix lane, so the host
  // lets the sandbox load and fetch from it (and from the bucket this server's links redirect
  // to, where files are kept in one); clipboard-write backs its copy buttons.
  const from = mediaOrigins(deps.runtime);
  const ui = {
    csp: { resourceDomains: from, connectDomains: from },
    permissions: { clipboardWrite: {} },
    prefersBorder: false,
  };
  server.registerResource(
    'editor',
    EDITOR_URI,
    {
      title: 'Editor',
      description:
        'Plays an export over its timeline in the chat, to scrub and inspect it (MCP Apps view).',
      mimeType: MCP_APP_MIME,
      _meta: { ui },
    },
    async (uri, ctx) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME,
          text: EDITOR_HTML,
          _meta: { ui: viewUi(server, ctx, ui, origin) },
        },
      ],
    }),
  );
}

// The page is editor.html next to this file, with the version and the shared Download control
// (final-copy.js) filled in.
const EDITOR_HTML = readFileSync(new URL('./editor.html', import.meta.url), 'utf8')
  .replace('__VERSION__', SERVER_VERSION)
  .replace('__FINAL_COPY__', () => FINAL_COPY_JS);
