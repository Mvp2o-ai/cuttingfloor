import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { MCP_APP_MIME, viewUi } from './player.ts';
import type { ServerDeps } from './server.ts';
import { SERVER_VERSION } from './version.ts';

/**
 * The upload box an MCP Apps host (io.modelcontextprotocol/ui) shows with media.upload results:
 * the person picks a file in the chat and the view sends it to the staging url in the result, in
 * parts, so nobody has to leave the chat for the upload page. When it is in, the view says so as
 * the person with ui/message, where the host offers it. The url stays the way in everywhere else.
 */
export const UPLOAD_URI = 'ui://cuttingfloor/upload';

/** `_meta` for a tool whose results the upload box shows. */
export const UPLOAD_TOOL_META = { ui: { resourceUri: UPLOAD_URI } };

export function registerUpload(server: McpServer, deps: ServerDeps): void {
  // The view sends the file to this server, so the host lets the sandbox connect to it.
  const origin = new URL(deps.runtime.config.publicUrl).origin;
  const ui = {
    csp: { connectDomains: [origin] },
    prefersBorder: false,
  };
  server.registerResource(
    'upload',
    UPLOAD_URI,
    {
      title: 'Upload',
      description: 'Takes a file the user picks in the chat and stages it (MCP Apps view).',
      mimeType: MCP_APP_MIME,
      _meta: { ui },
    },
    async (uri, ctx) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME,
          text: UPLOAD_HTML,
          _meta: { ui: viewUi(server, ctx, ui, origin) },
        },
      ],
    }),
  );
}

// The page is upload.html next to this file; only the version is filled in.
const UPLOAD_HTML = readFileSync(new URL('./upload.html', import.meta.url), 'utf8').replace(
  '__VERSION__',
  SERVER_VERSION,
);
