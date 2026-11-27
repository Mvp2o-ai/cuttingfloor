import type { IncomingMessage, ServerResponse } from 'node:http';
import { ownerKey, waitForFloor } from '@cuttingfloor/core';
import {
  CfError,
  ErrorCode,
  RecordSessionInput,
  RecordSessionResult,
  RecordTakeInput,
  RecordTakeResult,
  type ToolError,
} from '@cuttingfloor/schema';
import {
  type RecordDeps,
  type RenderScoreDoc,
  type Runtime,
  recordSessionCall,
  recordTakeCall,
  SERVER_VERSION,
  verifyRecordLink,
} from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type AppCredits, AppleOtherAccount, AppleRejected } from './apple.ts';

// The tools as plain HTTP for code that doesn't speak MCP: POST /v1/<tool> with the arguments as
// the JSON body answers the tool's result, and /openapi.json describes every tool from the same
// schemas tools/list gives. Each call runs through the same MCP server /mcp builds for that caller
// (same checks, metering, jobs and results), over an in-memory connection, so the two can't drift.

type Caller = { owner: string; via: string };

/** The phone app's credits (apple.ts): not tools, but plain account routes on /v1. */
export interface AppCreditsRoutes {
  credits(owner: string): Promise<AppCredits>;
  purchase(
    owner: string,
    signed: string,
  ): Promise<{ credits_added: number; balance: number | null }>;
}
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

/** The longest POST /v1/floor.changes holds, inside the timeouts of the clients that forward it. */
const FLOOR_WAIT_MAX_SECONDS = 100;

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
  claim_required: 403,
  subscription_required: 402,
  email_unverified: 403,
  service_unavailable: 503,
  server_busy: 503,
};

// Code in a browser page (a sandbox, a notebook) calls with a bearer key and no cookies.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, x-cuttingfloor-key-*, x-cuttingfloor-record',
  'access-control-max-age': '86400',
};

export class RestApi {
  readonly #runtime: Runtime;
  readonly #serverFor: (
    owner: string,
    via: string,
    headers?: Headers,
  ) => McpServer | Promise<McpServer>;
  readonly #credits: AppCreditsRoutes | undefined;
  readonly #renderScoreDoc: RenderScoreDoc | undefined;
  #tools: Promise<ToolInfo[]> | undefined;

  constructor(
    runtime: Runtime,
    serverFor: (owner: string, via: string, headers?: Headers) => McpServer | Promise<McpServer>,
    credits?: AppCreditsRoutes,
    record: { renderScoreDoc?: RenderScoreDoc | undefined } = {},
  ) {
    this.#runtime = runtime;
    this.#serverFor = serverFor;
    this.#credits = credits;
    this.#renderScoreDoc = record.renderScoreDoc;
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
          ? openApi(tools, this.#runtime.config.publicUrl, Boolean(this.#credits))
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
    if (url.pathname === '/v1/floor.changes')
      return this.#floorChanges(req, res, url, authenticate);
    if (url.pathname === '/v1/credits.get' || url.pathname === '/v1/credits.apple')
      return this.#appCredits(req, res, url, authenticate);
    if (url.pathname === '/v1/record.session' || url.pathname === '/v1/record.take')
      return this.#record(req, res, url, authenticate);
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
      await this.#serverFor(caller.owner, caller.via, headers),
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

  /**
   * POST /v1/floor.changes {since, wait_seconds}: answers once the account's floor (media,
   * uploads, jobs) has changed since the cursor given, or when the wait ends, so an app lists
   * again only after a change. Not a tool: an app's signal, not an editing step. A dotted name
   * under /v1 like the tools', so a client that forwards tool calls carries it unchanged.
   */
  async #floorChanges(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    authenticate: (request: Request) => Promise<Caller | undefined>,
  ): Promise<void> {
    if (req.method !== 'POST') return refuse(req, res, 'POST');
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
    const refused = () =>
      send(res, 400, {
        code: 'bad_request',
        message: `The body is {"since"?: the last cursor, "wait_seconds"?: 0 to ${FLOOR_WAIT_MAX_SECONDS}}`,
      });
    let args: { since?: unknown; wait_seconds?: unknown } | null;
    try {
      const text = await readBody(req, 4096);
      args = text.trim() ? JSON.parse(text) : {};
    } catch {
      return refused();
    }
    if (!args || typeof args !== 'object') return refused();
    const { since, wait_seconds: wait = 0 } = args;
    if (
      (since !== undefined && typeof since !== 'string') ||
      typeof wait !== 'number' ||
      !(wait >= 0 && wait <= FLOOR_WAIT_MAX_SECONDS)
    )
      return refused();
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    const answer = await waitForFloor(this.#runtime.ws, caller.owner, since, wait * 1000, {
      signal: gone.signal,
    });
    if (!res.writableEnded && !res.destroyed) send(res, 200, answer);
  }

  /**
   * POST /v1/credits.get {}: the account's balance as the phone app shows it, the App Store packs
   * and the appAccountToken its purchases carry. POST /v1/credits.apple {signed_transaction}:
   * records one App Store purchase (StoreKit 2 jwsRepresentation) once, answering
   * {credits_added, balance}; another account's purchase answers 403 `forbidden`. POST and dotted
   * names, as floor.changes: the app reaches /v1 only through one-mcp's pass-through, which
   * forwards POST to dotted operation names with the user's key.
   */
  async #appCredits(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    authenticate: (request: Request) => Promise<Caller | undefined>,
  ): Promise<void> {
    const credits = this.#credits;
    const apple = url.pathname === '/v1/credits.apple';
    if (req.method !== 'POST') return refuse(req, res, 'POST');
    if (!credits) {
      req.resume();
      return send(res, 404, { code: 'not_found', message: 'No credits on this server' });
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    const caller = await authenticate(
      new Request(new URL(url.pathname, this.#runtime.config.publicUrl), {
        method: req.method,
        headers,
      }),
    );
    if (!caller) {
      req.resume();
      return;
    }
    try {
      if (!apple) {
        req.resume();
        return send(res, 200, await credits.credits(caller.owner));
      }
      let signed: unknown;
      try {
        signed = (JSON.parse(await readBody(req, 64 * 1024)) as { signed_transaction?: unknown })
          ?.signed_transaction;
      } catch {
        signed = undefined;
      }
      if (typeof signed !== 'string' || !signed)
        return send(res, 400, {
          code: 'bad_request',
          message: 'The body is {"signed_transaction": StoreKit\'s jwsRepresentation}',
        });
      return send(res, 200, await credits.purchase(caller.owner, signed));
    } catch (error) {
      if (error instanceof AppleOtherAccount)
        return send(res, 403, { code: 'forbidden', message: error.message });
      if (error instanceof AppleRejected)
        return send(res, 400, { code: 'bad_request', message: error.message });
      const e = error as { code?: ErrorCode; message?: string; hint?: string };
      if (e.code && e.code in STATUS)
        return send(res, STATUS[e.code], {
          code: e.code,
          message: e.message,
          ...(e.hint ? { hint: e.hint } : {}),
        });
      process.stderr.write(`rest: ${url.pathname}: ${(error as Error).message}\n`);
      return send(res, 503, {
        code: 'service_unavailable',
        message: 'Credits could not be read just now',
        hint: 'Try again in a minute',
      });
    }
  }

  /**
   * POST /v1/record.session {job_id, speed?} and POST /v1/record.take: the two calls a take of
   * score.record is played through (contract v1.1 with the phone app). Not tools: a view's or an
   * app's steps, not the agent's. Signed in as /v1 is, or with the session's own signed url in
   * X-Cuttingfloor-Record (the view and its page carry no sign-in), which reaches that session only.
   */
  async #record(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    authenticate: (request: Request) => Promise<Caller | undefined>,
  ): Promise<void> {
    if (req.method !== 'POST') return refuse(req, res, 'POST');
    const link = req.headers['x-cuttingfloor-record'];
    let key: string;
    let only: string | undefined;
    if (typeof link === 'string' && link) {
      const found = await verifyRecordLink(this.#runtime, link);
      if (!found) {
        req.resume();
        return send(res, 403, {
          code: 'bad_request',
          message: 'This record link is not valid, or the session has ended',
          hint: 'score.record opens a new session, with a new url',
        });
      }
      key = found.key;
      only = found.job_id;
    } else {
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
      key = ownerKey(caller.owner);
    }
    let body: unknown;
    try {
      const text = await readBody(req, RECORD_BODY_BYTES);
      body = text.trim() ? JSON.parse(text) : {};
    } catch (error) {
      return send(res, error instanceof TooLarge ? 413 : 400, {
        code: 'bad_request',
        message:
          error instanceof TooLarge
            ? `The body is over ${RECORD_BODY_BYTES} bytes`
            : 'The body must be JSON',
      });
    }
    const jobId = (body as { job_id?: unknown } | null)?.job_id;
    if (only && jobId !== only) {
      return send(res, 403, {
        code: 'bad_request',
        message: `This record link is for session ${only}, not ${String(jobId)}`,
      });
    }
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    const deps: RecordDeps = { runtime: this.#runtime, renderScoreDoc: this.#renderScoreDoc };
    try {
      const answer =
        url.pathname === '/v1/record.session'
          ? await recordSessionCall(deps, key, body, gone.signal)
          : await recordTakeCall(deps, key, body);
      if (!res.writableEnded && !res.destroyed) send(res, 200, answer);
    } catch (error) {
      if (!(error instanceof CfError)) {
        process.stderr.write(`rest: ${url.pathname}: ${(error as Error).stack ?? error}\n`);
      }
      const e =
        error instanceof CfError
          ? error
          : new CfError('engine_error', (error as Error).message ?? String(error));
      send(res, STATUS[e.code] ?? 500, e.toJSON());
    }
  }

  /** A data: URI import is the largest body a call takes. */
  #bodyLimit(): number {
    return Math.ceil(this.#runtime.config.inlineMaxBytes * 1.4) + 1024 ** 2;
  }

  /** Every tool, as tools/list gives it (the same for every account). */
  #listTools(): Promise<ToolInfo[]> {
    this.#tools ??= Promise.resolve(this.#serverFor('anonymous', 'anonymous'))
      .then((server) => this.#connect(server))
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

/** The largest record.take body: every tap a take may have, with room. */
const RECORD_BODY_BYTES = 1024 ** 2;

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
export function openApi(
  tools: ToolInfo[],
  publicUrl: string,
  credits = false,
): Record<string, unknown> {
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
  paths['/v1/floor.changes'] = {
    post: {
      operationId: 'floor_changes',
      summary: 'Wait for a change',
      description:
        "Not a tool: for apps that show an account's files. Answers once the account's media, uploads or jobs have changed since `since` (a media added, changing status or removed; an upload started or sent; a job started or ended; not progress), or when `wait_seconds` ends. Without `since` it answers at once with the cursor. List again on changed: true, then call again with the new cursor.",
      tags: ['floor'],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                since: { type: 'string', description: 'The cursor the last answer gave' },
                wait_seconds: {
                  type: 'number',
                  minimum: 0,
                  maximum: FLOOR_WAIT_MAX_SECONDS,
                  default: 0,
                  description: 'How long to hold for a change',
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Where the account stands',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  cursor: { type: 'string', description: 'Pass as since on the next call' },
                  changed: { type: 'boolean', description: 'Whether it moved past since' },
                },
                required: ['cursor', 'changed'],
                additionalProperties: false,
              },
            },
          },
        },
        '4XX': { $ref: '#/components/responses/Error' },
      },
    },
  };
  if (credits) Object.assign(paths, CREDITS_PATHS);
  Object.assign(paths, recordPaths(schemas));
  return {
    openapi: '3.1.0',
    info: {
      title: 'cuttingfloor',
      version: SERVER_VERSION,
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
      description: `A headless video editor: the same tools as its MCP server (${publicUrl}/mcp), as plain HTTP. POST /v1/<tool> with the tool's arguments as a JSON object; the response is its result. Sign in with an API key from your account page: Authorization: Bearer cf_…

Long work (imports, analysis, renders, exports) answers at once with a job_id: POST /v1/job.get {"job_id": "…", "wait_seconds": 30} waits up to 30 s for it to finish or fail, and a finished job gives its result and signed download links. Every edit returns a new timeline_id; keep using the latest. A refused call answers with an HTTP error status and {code, message, hint}: the hint says what to do instead.`,
    },
    servers: [{ url: publicUrl }],
    security: [{ apiKey: [] }],
    tags: [
      ...new Set([
        ...tools.map((t) => t.name.split('.')[0]),
        'floor',
        'record',
        ...(credits ? ['credits'] : []),
      ]),
    ].map((name) => ({
      name,
    })),
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

const APPLE_PACK = {
  type: 'object',
  properties: {
    product_id: {
      type: 'string',
      description: 'The App Store product (ai.cuttingfloor.app.<pack>)',
    },
    credits: { type: 'number', description: 'Credits it adds' },
  },
  required: ['product_id', 'credits'],
  additionalProperties: false,
};

/** The phone app's credit routes: account routes, not tools. */
const CREDITS_PATHS = {
  '/v1/credits.get': {
    post: {
      operationId: 'credits_get',
      summary: 'Credits, as the phone app shows them',
      description:
        "Not a tool: for the Cutting Floor AI app. The account's balance (null on a given plan, which has no cap), whether it is low or out, the App Store packs, and the appAccountToken to set on each StoreKit purchase so it lands on this account.",
      tags: ['credits'],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      },
      responses: {
        '200': {
          description: "The account's credits",
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  balance: { type: ['number', 'null'] },
                  unmetered: { type: 'boolean' },
                  low: { type: 'boolean' },
                  out: { type: 'boolean' },
                  apple_products: { type: 'array', items: APPLE_PACK },
                  apple_account_token: { type: 'string', format: 'uuid' },
                },
                required: [
                  'balance',
                  'unmetered',
                  'low',
                  'out',
                  'apple_products',
                  'apple_account_token',
                ],
                additionalProperties: false,
              },
            },
          },
        },
        '4XX': { $ref: '#/components/responses/Error' },
        '5XX': { $ref: '#/components/responses/Error' },
      },
    },
  },
  '/v1/credits.apple': {
    post: {
      operationId: 'credits_apple',
      summary: 'Record an App Store purchase',
      description:
        "Not a tool: for the Cutting Floor AI app. Checks one StoreKit transaction against Apple's certificates and adds its pack's credits once; the same transaction again adds 0. Finish the transaction only after a 200. A transaction made with another account's appAccountToken answers 403 with code forbidden; a payload Apple did not sign, a revoked transaction or a product cuttingfloor doesn't sell answers 400.",
      tags: ['credits'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                signed_transaction: {
                  type: 'string',
                  description: "StoreKit 2's Transaction.jwsRepresentation",
                },
              },
              required: ['signed_transaction'],
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Recorded',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  credits_added: { type: 'number', description: '0 when it was recorded before' },
                  balance: { type: ['number', 'null'] },
                },
                required: ['credits_added', 'balance'],
                additionalProperties: false,
              },
            },
          },
        },
        '403': {
          description: "Another account's purchase",
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { code: { const: 'forbidden' }, message: { type: 'string' } },
                required: ['code', 'message'],
              },
            },
          },
        },
        '4XX': { $ref: '#/components/responses/Error' },
        '5XX': { $ref: '#/components/responses/Error' },
      },
    },
  },
};

/** POST /v1/record.session and /v1/record.take, from their schemas (contract v1.1). */
function recordPaths(schemas: Record<string, unknown>): Record<string, unknown> {
  const json = (schema: z.ZodType, io: 'input' | 'output') =>
    z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  const op = (
    name: string,
    summary: string,
    description: string,
    input: z.ZodType,
    output: z.ZodType,
  ) => {
    const id = name.replaceAll('.', '_');
    return {
      post: {
        operationId: id,
        summary,
        description,
        tags: ['record'],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: hoist(json(input, 'input'), `${id}_args`, schemas) },
          },
        },
        responses: {
          '200': {
            description: 'The answer',
            content: {
              'application/json': {
                schema: hoist(json(output, 'output'), `${id}_result`, schemas),
              },
            },
          },
          '4XX': { $ref: '#/components/responses/Error' },
          '5XX': { $ref: '#/components/responses/Error' },
        },
      },
    };
  };
  const auth =
    'Signed in as every /v1 call is, or with the session’s url (score.record’s result) in the X-Cuttingfloor-Record header, which reaches that session only.';
  return {
    '/v1/record.session': op(
      'record.session',
      'What a take plays over',
      `Not a tool: for a view or an app playing a take of score.record (its job_id). The loop at tempo × speed (WAV, PCM 16-bit stereo, one pass, no click in it, its exact frames, and when each beat of the meter and each bar falls in it), the click and its accent, the count-in's click times (negative seconds before the loop) and one WAV per pad. Ask again at another speed for the tempo slider; the score's own tempo does not change. ${auth}`,
      RecordSessionInput,
      RecordSessionResult,
    ),
    '/v1/record.take': op(
      'record.take',
      'Send the take',
      `Not a tool: what the user played, in seconds of the loop as rendered at speed (record.session at that speed first). Pads: taps [{pitch, at_seconds, pass, velocity?}], at_seconds in [0, loop.seconds) and on pass 0 down to -count_in.seconds, velocity only where the device measured it. Microphone: the recording staged as an upload first (WAV, PCM), then {upload_id, starts_at_seconds, passes}. delay says what the device took off each position. Taps are stored where they were played: nothing is moved to a grid, dropped or wrapped. One take a session: the same body again answers {ok: true}; another body after a take answers 409. ${auth}`,
      RecordTakeInput,
      RecordTakeResult,
    ),
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
