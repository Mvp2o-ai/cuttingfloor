import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { MCP_APP_MIME, viewUi } from './player.ts';
import type { ServerDeps } from './server.ts';
import { SOUND_FILES } from './sound-library.ts';
import { SERVER_VERSION } from './version.ts';

/**
 * The sound library an MCP Apps host (io.modelcontextprotocol/ui) shows with sounds.list results:
 * each sound to play in the chat, drawn as its waveform, with a search and the categories. Sounds
 * listed by id come up as large cards to play. Use sends the person's pick to the agent with
 * ui/message when the host offers it.
 */
export const SOUNDS_URI = 'ui://cuttingfloor/sounds';

/** `_meta` for a tool whose results the sound library shows. */
export const SOUNDS_TOOL_META = { ui: { resourceUri: SOUNDS_URI } };

export function registerSoundsView(server: McpServer, deps: ServerDeps): void {
  // It plays and draws the files from where the library keeps them; clipboard-write backs Link.
  const origin = new URL(deps.runtime.config.publicUrl).origin;
  const files = new URL(deps.runtime.config.soundFiles ?? SOUND_FILES).origin;
  const ui = {
    csp: { resourceDomains: [files], connectDomains: [files] },
    permissions: { clipboardWrite: {} },
    prefersBorder: false,
  };
  server.registerResource(
    'sounds',
    SOUNDS_URI,
    {
      title: 'Sound effects',
      description: 'Plays sound library sounds in the chat, with a search (MCP Apps view).',
      mimeType: MCP_APP_MIME,
      _meta: { ui },
    },
    async (uri, ctx) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME,
          text: SOUNDS_HTML,
          _meta: { ui: viewUi(server, ctx, ui, origin) },
        },
      ],
    }),
  );
}

// The page is sounds.html next to this file; only the version is filled in.
const SOUNDS_HTML = readFileSync(new URL('./sounds.html', import.meta.url), 'utf8').replace(
  '__VERSION__',
  SERVER_VERSION,
);
