import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { MCP_APP_MIME, mediaOrigins, viewUi } from './player.ts';
import type { RecordSession } from './record.ts';
import type { Runtime } from './runtime.ts';
import type { ServerDeps } from './server.ts';
import { SERVER_VERSION } from './version.ts';

/**
 * The play-along view an MCP Apps host shows with score.record results: pads (or a record
 * button) over a loop of the score, with a click, a count-in and a tempo slider. It talks to
 * POST /v1/record.session and POST /v1/record.take only, with the result's signed url as its
 * credential, and sends the recording to the result's upload. The same page is behind that url,
 * for hosts that show no views.
 */
export const RECORD_URI = 'ui://cuttingfloor/record';

/** `_meta` for a tool whose results the record view shows. */
export const RECORD_TOOL_META = { ui: { resourceUri: RECORD_URI } };

export function registerRecordView(server: McpServer, deps: ServerDeps): void {
  const origin = new URL(deps.runtime.config.publicUrl).origin;
  // The view calls this server and reads the loop's files from it (and its bucket, where files
  // are kept in one); the microphone records a take.
  const ui = {
    csp: { connectDomains: mediaOrigins(deps.runtime) },
    permissions: { microphone: {} },
    prefersBorder: false,
  };
  server.registerResource(
    'record',
    RECORD_URI,
    {
      title: 'Play along',
      description:
        'Pads or the microphone over a loop of a score, for score.record (MCP Apps view).',
      mimeType: MCP_APP_MIME,
      _meta: { ui },
    },
    async (uri, ctx) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME,
          text: recordHtml(),
          _meta: { ui: viewUi(server, ctx, ui, origin) },
        },
      ],
    }),
  );
}

const RECORD_HTML = readFileSync(new URL('./record.html', import.meta.url), 'utf8').replace(
  '__VERSION__',
  SERVER_VERSION,
);

/** The view, or the page behind a session's url with that session filled in. */
export function recordHtml(page?: { session: RecordSession; link: string }): string {
  if (!page) return RECORD_HTML.replace('__PAGE__', 'null');
  const s = page.session;
  const data = {
    job_id: s.job_id,
    input: s.input,
    url: page.link,
    expires_at: s.expires_at,
    ...(s.upload ? { upload: s.upload } : {}),
  };
  // As JSON inside a script: "<" escaped so no value can close the tag.
  return RECORD_HTML.replace('__PAGE__', () => JSON.stringify(data).replace(/</g, '\\u003c'));
}

/** The page's content policy: this server and its bucket, inline script, worklets from blobs. */
export function recordPageCsp(rt: Runtime): string {
  const connect = ["'self'", ...mediaOrigins(rt)].join(' ');
  return `default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; connect-src ${connect}; media-src blob: ${connect}; worker-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
