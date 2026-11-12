import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { MOTION_LIMITS, type MotionEvent } from '@cuttingfloor/schema';

// cuttingfloor motion-launcher: a fresh sandbox for every render. It answers the main server
// exactly as one motion worker does (POST /render streams NDJSON progress, GET /jobs/<id> streams
// the file once), but behind each render it starts a new motion-worker container, sends the
// render there, and removes the container once the file is fetched. One render's crash, memory
// or leftovers never reach another's. How many run at once is the machine's: its cores and
// memory over what a render needs, never a plan's. Renders past that wait their turn, hearing
// their place. It is the only process that may start containers (it holds the Docker socket);
// the main server only talks to it over the internal motion network.

const MAX_BODY = Math.ceil(MOTION_LIMITS.maxAssetBytes * 1.4) + MOTION_LIMITS.maxHtmlBytes + 65_536;
/** A finished render's file waits this long to be fetched before its sandbox is removed. */
const KEEP_MS = 10 * 60_000;
const HEARTBEAT_MS = 20_000;
const READY_MS = 60_000;

/** One running sandbox: where it answers, and how to remove it. */
export interface Sandbox {
  url: string;
  stop: () => Promise<void>;
}

/** What starts sandboxes: Docker on a server, anything that serves a motion worker in tests. */
export interface SandboxEngine {
  /** The machine's cores and memory, which set how many sandboxes run at once. */
  capacity(): Promise<{ cpus: number; memoryBytes: number }>;
  start(): Promise<Sandbox>;
  /** Removes sandboxes an earlier launcher left behind (a restart mid-render). */
  sweep(): Promise<void>;
}

/** What one render is planned to take of the machine. */
export interface RenderShare {
  cpus: number;
  memoryBytes: number;
}

/** Share of the machine's memory sandboxes may hold; the rest is the main server's and exports'. */
const MEMORY_SHARE = 0.6;

/** Sandboxes at once on a machine: its cores and its memory, each over what a render takes. */
export function sandboxSlots(
  machine: { cpus: number; memoryBytes: number },
  share: RenderShare,
): number {
  const byCpu = Math.floor(machine.cpus / share.cpus);
  const byMemory = Math.floor((machine.memoryBytes * MEMORY_SHARE) / share.memoryBytes);
  return Math.max(1, Math.min(byCpu, byMemory));
}

export interface MotionLauncherOptions {
  port: number;
  host?: string;
  engine: SandboxEngine;
  share: RenderShare;
  /** Sandboxes at once, instead of what the machine allows. */
  max?: number;
  heartbeatMs?: number;
  /** How long a new sandbox may take to answer. */
  readyMs?: number;
  /** How long a finished file waits to be fetched. */
  keepMs?: number;
}

export async function startMotionLauncher(options: MotionLauncherOptions): Promise<Server> {
  const { engine } = options;
  await engine.sweep().catch((error: Error) => {
    process.stderr.write(`motion-launcher: sweep: ${error.message}\n`);
  });
  const max = options.max ?? sandboxSlots(await engine.capacity(), options.share);
  process.stderr.write(`motion-launcher: up to ${max} sandboxes at once\n`);
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  let running = 0;
  const queue: Array<() => void> = [];
  /** Finished renders whose file is not fetched yet, by the id the sandbox gave it; they hold no slot. */
  const finished = new Map<string, { sandbox: Sandbox; release: () => void }>();

  /** Waits for a slot; the returned release frees it once. */
  function slot(onPlace: (ahead: number) => void, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      let freed = false;
      const release = () => {
        if (freed) return;
        freed = true;
        running -= 1;
        queue.shift()?.();
      };
      if (running < max && queue.length === 0) {
        running += 1;
        resolve(release);
        return;
      }
      const take = () => {
        clearInterval(timer);
        running += 1;
        resolve(release);
      };
      queue.push(take);
      const tell = () => onPlace(queue.indexOf(take));
      tell();
      const timer = setInterval(tell, heartbeatMs);
      timer.unref();
      signal.addEventListener(
        'abort',
        () => {
          clearInterval(timer);
          const at = queue.indexOf(take);
          if (at >= 0) queue.splice(at, 1);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: Error) => {
      if (!res.headersSent)
        json(res, 500, { error: { code: 'engine_error', message: error.message } });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://launcher');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, running, waiting: queue.length, max });
    }
    const out = /^\/jobs\/([0-9a-f]{24})$/.exec(url.pathname);
    if (req.method === 'GET' && out) {
      const entry = finished.get(out[1] as string);
      if (!entry)
        return json(res, 404, { error: { code: 'not_found', message: 'No such output' } });
      finished.delete(out[1] as string);
      try {
        const file = await fetch(`${entry.sandbox.url}/jobs/${out[1]}`);
        if (!file.ok || !file.body)
          return json(res, 502, {
            error: { code: 'engine_error', message: `Sandbox: HTTP ${file.status}` },
          });
        res.writeHead(200, {
          'content-type': file.headers.get('content-type') ?? 'application/octet-stream',
          ...(file.headers.get('content-length')
            ? { 'content-length': file.headers.get('content-length') as string }
            : {}),
        });
        for await (const chunk of file.body as unknown as AsyncIterable<Uint8Array>) {
          if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
        }
        res.end();
      } finally {
        await remove(entry.sandbox, entry.release);
      }
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/render') {
      return json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    }
    const body = await readBody(req, MAX_BODY);
    if (!body) {
      return json(res, 413, {
        error: { code: 'limit_exceeded', message: 'The render request is too large' },
      });
    }
    const what = /"kind"\s*:\s*"still"/.test(body.subarray(0, 4096).toString())
      ? 'still'
      : 'motion render';
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const send = (e: MotionEvent) => res.write(`${JSON.stringify(e)}\n`);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    let release: () => void;
    try {
      release = await slot(
        (ahead) =>
          send({
            progress: 0,
            message: `queued: ${ahead} ${ahead === 1 ? 'render' : 'renders'} ahead of this ${what}; this server runs ${max} at once`,
          }),
        abort.signal,
      );
    } catch {
      return void res.end();
    }
    let sandbox: Sandbox | undefined;
    let kept = false;
    try {
      send({ progress: 0, message: 'starting a sandbox' });
      sandbox = await engine.start();
      await ready(sandbox.url, options.readyMs ?? READY_MS, abort.signal);
      const reply = await fetch(`${sandbox.url}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: abort.signal,
      });
      if (!reply.ok || !reply.body) {
        const parsed = (await reply.json().catch(() => ({}))) as { error?: unknown };
        send({
          error: (parsed.error as never) ?? {
            code: 'engine_error',
            message: `Motion sandbox: HTTP ${reply.status}`,
          },
        });
        return void res.end();
      }
      // Pass every line through as it comes, and keep the finished file's sandbox for the fetch.
      let pending = '';
      const decoder = new TextDecoder();
      for await (const chunk of reply.body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            const event = JSON.parse(line) as MotionEvent;
            if ('done' in event) {
              // Rendering is over: its slot goes to the next render now, while the sandbox
              // stays only to hand over the file.
              release();
              const finishedSandbox = sandbox as Sandbox;
              const keepFor = setTimeout(() => {
                if (finished.delete(event.done.id)) void remove(finishedSandbox, release);
              }, options.keepMs ?? KEEP_MS);
              keepFor.unref();
              finished.set(event.done.id, {
                sandbox: finishedSandbox,
                release: () => clearTimeout(keepFor),
              });
              kept = true;
            }
          }
          res.write(`${line}\n`);
        }
      }
      if (!kept && !abort.signal.aborted) {
        send({
          error: {
            code: 'server_busy',
            message: 'The render’s sandbox stopped without an answer',
            hint: 'Only this render was affected; call the tool again',
          },
        });
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        send({
          error: {
            code: 'server_busy',
            message: `The render’s sandbox failed (${(error as Error).message})`,
            hint: 'Only this render was affected; call the tool again',
          },
        });
      }
    } finally {
      if (!kept) await remove(sandbox, release);
      res.end();
    }
  }

  async function remove(sandbox: Sandbox | undefined, release: () => void): Promise<void> {
    try {
      await sandbox?.stop();
    } catch (error) {
      process.stderr.write(`motion-launcher: remove: ${(error as Error).message}\n`);
    } finally {
      release();
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => resolve(server));
  });
}

/** Waits until a new sandbox answers its health check. */
async function ready(url: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) throw new Error('aborted');
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > until) throw new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** How DockerEngine starts each sandbox: the security of the old long-running one, per render. */
export interface DockerSandboxOptions {
  /** The Docker socket. Default /var/run/docker.sock. */
  socket?: string;
  /** The image every sandbox runs: the one the launcher came from. */
  image: string;
  /** The internal network the sandboxes and the launcher share, with no route out. */
  network: string;
  /** Path to the seccomp profile (Docker's default plus namespace creation, for Chromium). */
  seccomp: string;
  /** gVisor on a server (runsc); omit for Docker's default runtime. */
  runtime?: string;
  /** Hard caps for one sandbox. */
  maxCpus: number;
  memoryBytes: number;
  /** Browsers per render. */
  browsers: number;
}

const LABEL = 'ai.cuttingfloor.sandbox';

/** Starts each sandbox as a container through the Docker Engine API. */
export class DockerEngine implements SandboxEngine {
  readonly #o: DockerSandboxOptions;
  #seccomp: string | undefined;

  constructor(options: DockerSandboxOptions) {
    this.#o = options;
  }

  async capacity(): Promise<{ cpus: number; memoryBytes: number }> {
    const info = (await this.#call('GET', '/info')) as { NCPU: number; MemTotal: number };
    return { cpus: info.NCPU, memoryBytes: info.MemTotal };
  }

  async sweep(): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL}=1`] }));
    const list = (await this.#call('GET', `/containers/json?all=1&filters=${filters}`)) as Array<{
      Id: string;
    }>;
    for (const c of list)
      await this.#call('DELETE', `/containers/${c.Id}?force=1`).catch(() => undefined);
  }

  async start(): Promise<Sandbox> {
    this.#seccomp ??= JSON.stringify(JSON.parse(await readFile(this.#o.seccomp, 'utf8')));
    const name = `cuttingfloor-sandbox-${randomBytes(6).toString('hex')}`;
    const o = this.#o;
    const created = (await this.#call('POST', `/containers/create?name=${name}`, {
      Image: o.image,
      Cmd: ['cuttingfloor', 'motion-worker'],
      User: 'node',
      Env: ['PORT=8790', 'HOME=/tmp', 'TMPDIR=/tmp', `CUTTINGFLOOR_MOTION_WORKERS=${o.browsers}`],
      Labels: { [LABEL]: '1' },
      HostConfig: {
        ...(o.runtime ? { Runtime: o.runtime } : {}),
        NetworkMode: o.network,
        ReadonlyRootfs: true,
        Tmpfs: {
          '/tmp': 'rw,nosuid,nodev,size=2g',
          // The image declares /data a volume; here it is an empty scrap, never the data volume.
          '/data': 'rw,noexec,nosuid,nodev,size=64k',
        },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true', `seccomp=${this.#seccomp}`],
        Init: true,
        NanoCpus: Math.round(o.maxCpus * 1e9),
        Memory: o.memoryBytes,
        MemorySwap: o.memoryBytes,
        // Under gVisor every guest thread costs host threads too; the real cap is nproc inside,
        // where a fork bomb fails its own render. A three-browser 1080x1920 render peaks near
        // 400 threads.
        PidsLimit: 8192,
        Ulimits: [{ Name: 'nproc', Soft: 1024, Hard: 1024 }],
        ShmSize: 1024 * 1024 * 1024,
        AutoRemove: true,
        LogConfig: { Type: 'journald', Config: {} },
      },
    })) as { Id: string };
    try {
      await this.#call('POST', `/containers/${created.Id}/start`);
    } catch (error) {
      await this.#call('DELETE', `/containers/${created.Id}?force=1`).catch(() => undefined);
      throw error;
    }
    return {
      url: `http://${name}:8790`,
      stop: async () => {
        await this.#call('DELETE', `/containers/${created.Id}?force=1`).catch((error: Error) => {
          // AutoRemove may have taken it already.
          if (
            !/404|no such container|removal of container .* is already in progress/i.test(
              error.message,
            )
          )
            throw error;
        });
      },
    };
  }

  #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.#o.socket ?? '/var/run/docker.sock',
          path,
          method,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => {
            text += d;
          });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              reject(new Error(`Docker ${method} ${path.split('?')[0]}: ${status} ${text.trim()}`));
              return;
            }
            try {
              resolve(text ? JSON.parse(text) : undefined);
            } catch {
              resolve(undefined);
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error(`Docker ${method} timed out`)));
      if (payload) req.write(payload);
      req.end();
    });
  }
}
