import { readFileSync } from 'node:fs';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { ServerDeps } from './server.ts';
import { SERVER_VERSION } from './version.ts';

/**
 * The player an MCP Apps host (io.modelcontextprotocol/ui) shows with media.get results: it plays
 * the signed file in the chat. While an import still runs it says so; it also follows a job
 * handle with job.get and plays the result when it lands. export.video shows the editor instead.
 */
/** The Download control the player and the editor share, inlined into each page. */
export const FINAL_COPY_JS = readFileSync(new URL('./final-copy.js', import.meta.url), 'utf8');

export const PLAYER_URI = 'ui://cuttingfloor/player';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

// The 2026-07-28 protocol names the client in every request's _meta; on a stateless 2025 request
// only its User-Agent does.
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';

/**
 * A view's `_meta.ui` for the host reading it. `domain` is the view's sandbox origin, which each
 * host spells its own way: ChatGPT requires this server's origin, while Claude refuses the view
 * unless it is a hash under claudemcpcontent.com. Views fetch with CORS open to any origin, so only
 * ChatGPT is given one.
 */
export function viewUi<T extends object>(
  server: McpServer,
  ctx: ServerContext,
  ui: T,
  domain: string,
): T | (T & { domain: string }) {
  const envelope = ctx.mcpReq.envelope as
    | Record<string, { name?: unknown } | undefined>
    | undefined;
  const name = envelope?.[CLIENT_INFO_META]?.name ?? server.server.getClientVersion()?.name;
  const agent = ctx.http?.req?.headers.get('user-agent') ?? '';
  const chatgpt =
    /^openai-mcp\b/i.test(agent) || (typeof name === 'string' && /^openai-mcp\b/i.test(name));
  return chatgpt ? { ...ui, domain } : ui;
}

/**
 * The origins a view loads media from: this server, and, where files are kept in a bucket, the
 * bucket too (this server's links to a file redirect there).
 */
export function mediaOrigins(runtime: ServerDeps['runtime']): string[] {
  const origin = new URL(runtime.config.publicUrl).origin;
  const bucket = runtime.bucketOrigin;
  return bucket && bucket !== origin ? [origin, bucket] : [origin];
}

/** `_meta` for a tool whose results the player shows. */
export const PLAYER_TOOL_META = { ui: { resourceUri: PLAYER_URI } };

export function registerPlayer(server: McpServer, deps: ServerDeps): void {
  // The page loads the file from this server, so the host lets the sandbox fetch media from it;
  // clipboard-write backs its Copy link button.
  const origin = new URL(deps.runtime.config.publicUrl).origin;
  const ui = {
    csp: { resourceDomains: mediaOrigins(deps.runtime) },
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
    async (uri, ctx) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME,
          text: PLAYER_HTML,
          _meta: { ui: viewUi(server, ctx, ui, origin) },
        },
      ],
    }),
  );
}

// The page is player.html next to this file, with the version and the shared Download control
// (final-copy.js) filled in.
const PLAYER_HTML = readFileSync(new URL('./player.html', import.meta.url), 'utf8')
  .replace('__VERSION__', SERVER_VERSION)
  .replace('__FINAL_COPY__', () => FINAL_COPY_JS);
