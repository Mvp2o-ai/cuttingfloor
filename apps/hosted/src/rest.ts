import type { IncomingMessage, ServerResponse } from 'node:http';
import { ErrorCode, type ToolError } from '@cuttingfloor/schema';
import { type Runtime, SERVER_VERSION } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';

// The tools as plain HTTP for code that doesn't speak MCP: POST /v1/<tool> with the arguments as
// the JSON body answers the tool's result, and /openapi.json describes every tool from the same
// schemas tools/list gives. Each call runs through the same MCP server /mcp builds for that caller
// (same checks, metering, jobs and results), over an in-memory connection, so the two can't drift.

type Caller = { owner: string; via: string };
type ToolInfo = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

/** How long one call may run; long work answers at once with a job_id (job.get waits on it). */
const CALL_TIMEOUT_MS = 15 * 60_000;

/** What each domain error is as an HTTP status. */
const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  no_audio: 422,
  not_found: 404,
  expired: 410,
  media_not_ready: 409,
  media_offline: 409,
  engine_error: 500,
  render_failed: 500,
  interrupted: 503,
  stalled: 500,
  cancelled: 409,
  credential_required: 422,
  credential_invalid: 422,
  output_exists: 409,
  path_not_allowed: 403,
  limit_exceeded: 422,
  quota_exceeded: 402,
  subscription_required: 402,
  email_unverified: 403,
  service_unavailable: 503,
  server_busy: 503,
};

// Code in a browser page (a sandbox, a notebook) calls with a bearer key and no cookies.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-cuttingfloor-key-*',
  'access-control-max-age': '86400',
};

export class RestApi {
  readonly #runtime: Runtime;
  readonly #serverFor: (owner: string, via: string, headers?: Headers) => McpServer;
  #tools: Promise<ToolInfo[]> | undefined;

  constructor(
    runtime: Runtime,
    serverFor: (owner: string, via: string, headers?: Headers) => McpServer,
  ) {
    this.#runtime = runtime;
    this.#serverFor = serverFor;
  }

  handles(url: URL): boolean {
    return (
      url.pathname === '/openapi.json' || url.pathname === '/v1' || url.pathname.startsWith('/v1/')
    );
  }

  /**
   * Answers a /v1 or /openapi.json request. `authenticate` signs a tool call in as /mcp does
   * (undefined once it has answered a refusal); the description and the tool list need no sign-in,
   * as tools/list doesn't.
   */
  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    authenticate: (request: Request) => Promise<Caller | undefined>,
  ): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    if (url.pathname === '/openapi.json' || url.pathname === '/v1/tools') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(req, res, 'GET');
      const tools = await this.#listTools();
      const body = JSON.stringify(
        url.pathname === '/openapi.json'
          ? openApi(tools, this.#runtime.config.publicUrl)
          : {
              tools: tools.map((t) => ({
                name: t.name,
                title: t.title ?? t.name,
                path: `/v1/${t.name}`,
                description: t.description ?? '',
              })),
            },
      );
      res.writeHead(200, {
        ...CORS,
        'content-type': 'application/json',
        'cache-control': 'public, max-age=300',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const name = decodeURIComponent(url.pathname.slice('/v1/'.length));
    const tool = (await this.#listTools()).find((t) => t.name === name);
    if (!tool) {
      req.resume();
      return send(res, 404, {
        code: 'not_found',
        message: name ? `No tool ${name}` : 'Name a tool: POST /v1/<tool>',
        hint: 'GET /v1/tools lists them; /openapi.json describes each one',
      });
    }
    if (req.method !== 'POST') return refuse(req, res, 'POST');
    // Sign-in reads only the headers; the body is read after.
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    const caller = await authenticate(
      new Request(new URL(url.pathname, this.#runtime.config.publicUrl), {
        method: 'POST',
        headers,
      }),
    );
    if (!caller) {
      req.resume();
      return;
    }
    let args: unknown;
    try {
      const text = await readBody(req, this.#bodyLimit());
      args = text.trim() ? JSON.parse(text) : {};
    } catch (error) {
      return send(res, error instanceof TooLarge ? 413 : 400, {
        code: 'bad_request',
        message:
          error instanceof TooLarge
            ? `The body is over ${this.#bodyLimit()} bytes`
            : 'The body must be JSON: the tool’s arguments as one object',
        ...(error instanceof TooLarge
          ? { hint: 'Send a large file with media.upload, then media.import its upload_id' }
          : {}),
      });
    }
    if (!args || typeof args !== 'object' || Array.isArray(args))
      return send(res, 400, {
        code: 'bad_request',
        message: 'The body must be one JSON object: the tool’s arguments',
      });
    const result = await this.#call(
      this.#serverFor(caller.owner, caller.via, headers),
      name,
      args as Record<string, unknown>,
    );
    if (!result.isError) return send(res, 200, result.structuredContent ?? result);
    const error = (result.structuredContent as ToolError | undefined) ?? {
      code: 'bad_request' as const,
      message: textOf(result) || 'The call was refused',
    };
    const status = STATUS[error.code] ?? 500;
    const retry = Number(error.detail?.retry_after_seconds);
    send(res, status, error, retry > 0 ? { 'retry-after': String(retry) } : {});
  }

  /** A data: URI import is the largest body a call takes. */
  #bodyLimit(): number {
    return Math.ceil(this.#runtime.config.inlineMaxBytes * 1.4) + 1024 ** 2;
  }

  /** Every tool, as tools/list gives it (the same for every account). */
  #listTools(): Promise<ToolInfo[]> {
    this.#tools ??= this.#connect(this.#serverFor('anonymous', 'anonymous'))
      .then(async (client) => {
        try {
          const tools: ToolInfo[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : {});
            tools.push(...(page.tools as ToolInfo[]));
            cursor = page.nextCursor;
          } while (cursor);
          return tools;
        } finally {
          await client.close();
        }
      })
      .catch((error: unknown) => {
        this.#tools = undefined;
        throw error;
      });
    return this.#tools;
  }

  async #call(server: McpServer, name: string, args: Record<string, unknown>) {
    const client = await this.#connect(server);
    try {
      return (await client.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: Array<{ type: string; text?: string }>;
      };
    } catch (error) {
      // A protocol refusal (arguments that don't parse as the tool's input) rather than a result.
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    } finally {
      await client.close();
    }
  }

  async #connect(server: McpServer): Promise<Client> {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'cuttingfloor-rest', version: SERVER_VERSION });
    await client.connect(clientSide);
    return client;
  }
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        reject(new TooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...CORS,
    ...headers,
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function refuse(req: IncomingMessage, res: ServerResponse, allow: string): void {
  req.resume();
  res.writeHead(405, { ...CORS, allow, 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'bad_request', message: `Use ${allow}` }));
}

/**
 * The OpenAPI 3.1 document: one POST operation per tool, its input and output schemas from
 * tools/list. Each tool schema's own `$defs` move into components, named after the tool.
 */
export function openApi(tools: ToolInfo[], publicUrl: string): Record<string, unknown> {
  const schemas: Record<string, unknown> = { Error: ERROR_SCHEMA };
  const paths: Record<string, unknown> = {};
  for (const tool of tools) {
    const op = tool.name.replaceAll('.', '_');
    const output = tool.outputSchema ? hoist(tool.outputSchema, `${op}_result`, schemas) : {};
    paths[`/v1/${tool.name}`] = {
      post: {
        operationId: op,
        summary: tool.title ?? tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        tags: [tool.name.split('.')[0]],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: hoist(tool.inputSchema, `${op}_args`, schemas) },
          },
        },
        responses: {
          '200': { description: 'The result', content: { 'application/json': { schema: output } } },
          '4XX': { $ref: '#/components/responses/Error' },
          '5XX': { $ref: '#/components/responses/Error' },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'cuttingfloor',
      version: SERVER_VERSION,
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
      description: `A headless video editor: the same tools as its MCP server (${publicUrl}/mcp), as plain HTTP. POST /v1/<tool> with the tool's arguments as a JSON object; the response is its result. Sign in with an API key from your account page: Authorization: Bearer cf_…

Long work (imports, analysis, renders, exports) answers at once with a job_id: POST /v1/job.get {"job_id": "…", "wait_seconds": 30} answers when it moves, and a finished job gives its result and signed download links. Every edit returns a new timeline_id; keep using the latest. A refused call answers with an HTTP error status and {code, message, hint}: the hint says what to do instead.`,
    },
    servers: [{ url: publicUrl }],
    security: [{ apiKey: [] }],
    tags: [...new Set(tools.map((t) => t.name.split('.')[0]))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'An API key from your account page (cf_…), or a cuttingfloor sign-in token',
        },
      },
      responses: {
        Error: {
          description: 'The call was refused: what went wrong, and what to do instead',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
      schemas,
    },
  };
}

const ERROR_SCHEMA = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', enum: ErrorCode.options },
    message: { type: 'string' },
    detail: { type: 'object', additionalProperties: true },
    hint: { type: 'string', description: 'What to do instead: the next call, valid values' },
  },
};

/** Moves a tool schema into components under `id` (its `$defs` beside it) and refers to it. */
function hoist(schema: Record<string, unknown>, id: string, schemas: Record<string, unknown>) {
  const { $defs, ...rest } = schema as { $defs?: Record<string, unknown> };
  const ref = (to: string) => {
    if (to === '#') return `#/components/schemas/${id}`;
    const def = /^#\/\$defs\/([^/]+)(.*)$/.exec(to);
    return def ? `#/components/schemas/${id}_${def[1]}${def[2]}` : to;
  };
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [
        k,
        k === '$ref' && typeof v === 'string' ? ref(v) : rewrite(v),
      ]),
    );
  };
  for (const [name, def] of Object.entries($defs ?? {})) schemas[`${id}_${name}`] = rewrite(def);
  schemas[id] = rewrite(rest);
  return { $ref: `#/components/schemas/${id}` };
}
