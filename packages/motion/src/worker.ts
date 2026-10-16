import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CfError,
  type CodeEvent,
  CodeRequest,
  MOTION_LIMITS,
  type MotionEvent,
  MotionRequest,
} from '@cuttingfloor/schema';
import { type CodeJob, deliverFile, dropCodeJob, newCodeJob, replyTo, runCode } from './code.ts';
import { pageDocument } from './document.ts';
import { reap } from './reap.ts';
import type { MotionJob } from './render.ts';

// cuttingfloor motion-worker: the sandbox. It renders motion graphics and HTML stills, and runs
// code.run scripts, for the main server. It runs in its own container with no route out, no data
// volume and no secrets (§8.1). One job at a time, each in a fresh process group (renders: a
// fresh browser profile; scripts: their own namespaces), killed when it ends or overruns.
// POST /render answers with NDJSON progress, then GET /jobs/<id> streams the file once and
// deletes it. POST /run streams a script's events; the main server answers its tool calls and
// file requests on /jobs/<id>/reply|files/<rid> and fetches out/ files, all with the job secret.

const JOB = fileURLToPath(new URL('./job.ts', import.meta.url));
const MAX_BODY = Math.ceil(MOTION_LIMITS.maxAssetBytes * 1.4) + MOTION_LIMITS.maxHtmlBytes + 65_536;
const KEEP_MS = 10 * 60_000;

export interface MotionWorkerOptions {
  port: number;
  host?: string;
  /** Scratch folder (a tmpfs in the container). */
  scratch?: string;
  /** Per-render limit; default scales with the work. */
  timeoutMs?: number;
}

/** Time allowed for a render: two minutes plus ten seconds per second of 1080p30. */
export function motionTimeout(job: MotionJob): number {
  if (job.kind === 'still') return 30_000;
  const work = (job.width * job.height * job.fps * job.duration) / (1920 * 1080 * 30);
  return Math.min(30 * 60_000, 120_000 + work * 10_000);
}

export function startMotionWorker(options: MotionWorkerOptions): Promise<Server> {
  const scratch = options.scratch ?? tmpdir();
  const outputs = new Map<
    string,
    { file: string; dir: string; type: string; timer: NodeJS.Timeout }
  >();
  const codeJobs = new Map<string, CodeJob>();
  let queue: Promise<void> = Promise.resolve();
  let waiting = 0;

  /** Runs work after everything queued before it, one job at a time. */
  function enqueue(work: () => Promise<void>): Promise<void> {
    waiting += 1;
    const run = queue.then(async () => {
      waiting -= 1;
      await work();
    });
    queue = run.catch(() => undefined);
    return run;
  }

  /** Nothing another owner made may be on disk while a script runs. */
  async function purge(): Promise<void> {
    for (const [id, entry] of outputs) {
      clearTimeout(entry.timer);
      outputs.delete(id);
      await rm(entry.dir, { recursive: true, force: true });
    }
    for (const [id, job] of codeJobs) {
      codeJobs.delete(id);
      await dropCodeJob(job);
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent)
        json(res, error instanceof CfError ? 400 : 500, { error: errorBody(error) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://worker');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, waiting });
    }
    const out = /^\/jobs\/([0-9a-f]{24})$/.exec(url.pathname);
    if (req.method === 'GET' && out) {
      const entry = outputs.get(out[1] as string);
      if (!entry)
        return json(res, 404, { error: { code: 'not_found', message: 'No such output' } });
      outputs.delete(out[1] as string);
      clearTimeout(entry.timer);
      const s = await stat(entry.file);
      res.writeHead(200, { 'content-type': entry.type, 'content-length': s.size });
      const stream = createReadStream(entry.file);
      stream.pipe(res);
      await new Promise<void>((resolve) => res.on('close', resolve));
      await rm(entry.dir, { recursive: true, force: true });
      return;
    }
    const code =
      /^\/jobs\/([0-9a-f]{24})(?:\/(reply|files|out|upload)\/([A-Za-z0-9._-]{1,128}))?$/.exec(
        url.pathname,
      );
    if (code) return codeRoute(req, res, code[1] as string, code[2], code[3]);
    if (req.method === 'POST' && url.pathname === '/run') return run(req, res);
    if (req.method !== 'POST' || url.pathname !== '/render') {
      return json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    }
    const body = await readBody(req, MAX_BODY);
    const parsed = MotionRequest.safeParse(body);
    if (!parsed.success) return badRequest(res, parsed.error.issues);
    const request = parsed.data;
    const bytes = request.assets.reduce((n, a) => n + Math.floor((a.data.length * 3) / 4), 0);
    if (bytes > MOTION_LIMITS.maxAssetBytes) {
      return json(res, 413, {
        error: {
          code: 'limit_exceeded',
          message: `Assets total ${bytes} bytes; the limit is ${MOTION_LIMITS.maxAssetBytes}`,
        },
      });
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const send = (e: MotionEvent) => res.write(`${JSON.stringify(e)}\n`);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    if (waiting > 0) send({ progress: 0, message: `waiting (${waiting} ahead)` });
    await enqueue(async () => {
      if (abort.signal.aborted) return;
      try {
        const done = await render(request, send, abort.signal);
        const id = randomBytes(12).toString('hex');
        const timer = setTimeout(() => {
          outputs.delete(id);
          void rm(done.dir, { recursive: true, force: true });
        }, KEEP_MS);
        timer.unref();
        outputs.set(id, { ...done, timer });
        send({ done: { id, type: done.type, bytes: (await stat(done.file)).size } });
      } catch (error) {
        send({ error: errorBody(error) });
      }
      res.end();
    });
  }

  async function run(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = CodeRequest.safeParse(await readBody(req, 1024 * 1024));
    if (!parsed.success) return badRequest(res, parsed.error.issues);
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    const send = (e: CodeEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(e)}\n`);
    };
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    if (waiting > 0) send({ progress: 0, message: `waiting (${waiting} ahead)` });
    await enqueue(async () => {
      if (abort.signal.aborted) return;
      await purge();
      const job = await newCodeJob(scratch);
      codeJobs.set(job.id, job);
      send({ job: { id: job.id, secret: job.secret } });
      try {
        send({ done: await runCode(job, parsed.data, send, abort.signal) });
        job.timer = setTimeout(() => {
          codeJobs.delete(job.id);
          void dropCodeJob(job);
        }, KEEP_MS);
        job.timer.unref();
      } catch (error) {
        codeJobs.delete(job.id);
        await dropCodeJob(job);
        send({ error: errorBody(error) });
      }
      res.end();
    });
  }

  async function codeRoute(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    what: string | undefined,
    rid: string | undefined,
  ): Promise<void> {
    const job = codeJobs.get(id);
    const given = Buffer.from(String(req.headers['x-cf-secret'] ?? ''));
    const secret = Buffer.from(job?.secret ?? '');
    if (!job || given.length !== secret.length || !timingSafeEqual(given, secret)) {
      return json(res, 404, { error: { code: 'not_found', message: 'No such job' } });
    }
    if (req.method === 'DELETE' && !what) {
      codeJobs.delete(id);
      await dropCodeJob(job);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && what === 'reply' && rid) {
      replyTo(job, rid, (await readBody(req, 64 * 1024 * 1024)) as never);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && what === 'files' && rid) {
      await deliverFile(job, rid, String(req.headers['x-cf-name'] ?? rid), req);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && what === 'out' && rid && job.outputs.has(rid)) {
      const file = join(job.dir, 'out', rid);
      const s = await stat(file);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': s.size,
      });
      createReadStream(file).pipe(res);
      await new Promise<void>((resolve) => res.on('close', resolve));
      return;
    }
    const upload = what === 'upload' && rid ? job.uploads.get(rid) : undefined;
    if (req.method === 'GET' && upload) {
      job.uploads.delete(rid as string);
      const s = await stat(upload);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': s.size });
      createReadStream(upload).pipe(res);
      await new Promise<void>((resolve) => res.on('close', resolve));
      return;
    }
    json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  }

  async function render(
    request: MotionRequest,
    send: (e: MotionEvent) => void,
    signal: AbortSignal,
  ): Promise<{ file: string; dir: string; type: string }> {
    const dir = await mkdtemp(join(scratch, 'cfm'));
    let keep = false;
    try {
      const job: MotionJob = {
        kind: request.kind,
        width: request.width,
        height: request.height,
        fps: request.fps,
        duration: request.duration,
        transparent: request.transparent,
      };
      await mkdir(join(dir, 'assets'));
      for (const a of request.assets) {
        await writeFile(join(dir, 'assets', a.name), Buffer.from(a.data, 'base64'));
      }
      await writeFile(join(dir, 'index.html'), pageDocument(request.html, job.width, job.height));
      await writeFile(join(dir, 'job.json'), JSON.stringify(job));
      const file = await runJob(dir, options.timeoutMs ?? motionTimeout(job), send, signal);
      keep = true;
      return {
        file,
        dir,
        type: file.endsWith('.png')
          ? 'image/png'
          : file.endsWith('.mov')
            ? 'video/quicktime'
            : 'video/mp4',
      };
    } finally {
      if (!keep) await rm(dir, { recursive: true, force: true });
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => resolve(server));
  });
}

/** Runs job.ts in its own process group and kills everything it started when it ends. */
function runJob(
  dir: string,
  timeoutMs: number,
  send: (e: MotionEvent) => void,
  signal: AbortSignal,
): Promise<string> {
  const marker = `CUTTINGFLOOR_MOTION_JOB=${randomBytes(8).toString('hex')}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JOB, dir], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: dir,
        TMPDIR: dir,
        XDG_CONFIG_HOME: dir,
        XDG_CACHE_HOME: dir,
        [marker.split('=')[0] as string]: marker.split('=')[1],
      },
    });
    let outcome: { done?: string; failed?: string; console?: string[] } = {};
    let stderr = '';
    let pending = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) {
        try {
          const msg = JSON.parse(l) as { progress?: number; message?: string } & typeof outcome;
          if (typeof msg.progress === 'number')
            send({ progress: msg.progress, message: msg.message ?? '' });
          else outcome = msg;
        } catch {
          // Not ours: log noise from the renderer.
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    let why: 'timeout' | 'cancelled' | undefined;
    const killGroup = () => {
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        // Already gone.
      }
      void reap(marker);
    };
    const timer = setTimeout(() => {
      why = 'timeout';
      killGroup();
    }, timeoutMs);
    const onAbort = () => {
      why = 'cancelled';
      killGroup();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) =>
      reject(new CfError('engine_error', `Could not start a render: ${e.message}`)),
    );
    child.on('close', async (code, sig) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // Whatever the page started dies with the job, whatever happened.
      killGroup();
      await reap(marker);
      if (why === 'timeout') {
        return reject(
          new CfError(
            'limit_exceeded',
            `The render took longer than ${Math.round(timeoutMs / 1000)} s`,
            {
              hint: 'Shorten it, lower the size or frame rate, or simplify the page (heavy filters, huge DOMs)',
            },
          ),
        );
      }
      if (why === 'cancelled') return reject(new CfError('cancelled', 'Cancelled'));
      if (code === 0 && outcome.done) return resolve(outcome.done);
      if (
        sig === 'SIGKILL' ||
        code === 137 ||
        /page crashed|Target crashed|out of memory|Cannot allocate|heap limit/i.test(
          stderr + (outcome.failed ?? ''),
        )
      ) {
        return reject(
          new CfError('limit_exceeded', 'The render ran out of memory or processes', {
            hint: 'The motion sandbox has fixed memory and process limits; simplify the page or lower the size',
          }),
        );
      }
      if (/No usable sandbox|zygote|Failed to launch the browser/i.test(outcome.failed ?? '')) {
        return reject(
          new CfError('engine_error', 'Chromium could not start its sandbox in this container', {
            hint: 'Run the motion service with tools/motion/seccomp.json as its seccomp profile, as compose.yaml does',
            detail: { stderr: (outcome.failed ?? '').split('\n').slice(0, 4).join('\n') },
          }),
        );
      }
      reject(
        new CfError(
          'render_failed',
          `The page did not render: ${outcome.failed ?? `exit ${code ?? sig}`}`,
          {
            hint: 'Check the HTML: scripts that throw, window.__seek or window.__ready failing, or assets that are missing',
            detail: {
              ...(outcome.console?.length ? { console: outcome.console.slice(-10) } : {}),
              ...(stderr.trim() ? { stderr: stderr.trim().split('\n').slice(-6).join('\n') } : {}),
            },
          },
        ),
      );
    });
  });
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new CfError('limit_exceeded', 'The request is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CfError('bad_request', 'The request is not JSON');
  }
}

function errorBody(error: unknown): NonNullable<Extract<MotionEvent, { error: unknown }>['error']> {
  if (error instanceof CfError) return error.toJSON();
  return { code: 'engine_error', message: (error as Error).message };
}

function badRequest(res: ServerResponse, issues: Array<{ path: PropertyKey[]; message: string }>) {
  json(res, 400, {
    error: {
      code: 'bad_request',
      message: issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '),
    },
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
