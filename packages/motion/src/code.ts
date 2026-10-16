import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  CfError,
  CODE_DENIED_TOOLS,
  CODE_LIMITS,
  type CodeDone,
  type CodeEvent,
  type CodeReply,
  type CodeRequest,
} from '@cuttingfloor/schema';
import { reap } from './reap.ts';

// A code.run job inside the sandbox worker. The script runs in its own user, PID, network, IPC
// and UTS namespaces (no network at all, not even the sandbox's internal one; it can't see or
// signal the worker), in a fresh folder with in/ and out/. Its only way out is a Unix socket in
// that folder, guarded by a per-job token, where the SDK sends tool calls and file requests. The
// worker relays them up the job's response stream; the main server answers as the job's owner.

/** The SDK package (a sibling workspace package; /app/packages/sdk in the image). */
const SDK = fileURLToPath(new URL('../../sdk/', import.meta.url));

export type Isolation = 'namespaces' | 'none';

/** How code jobs are isolated: namespaces unless CUTTINGFLOOR_CODE_ISOLATION=none (tests only). */
export const codeIsolation = (): Isolation =>
  process.env.CUTTINGFLOOR_CODE_ISOLATION === 'none' ? 'none' : 'namespaces';

export interface CodeJob {
  id: string;
  secret: string;
  dir: string;
  /** Requests waiting on the main server, by rid. */
  pending: Map<string, { resolve: (reply: CodeReply) => void; file?: boolean }>;
  /** Files delivered for a request: rid → path. */
  delivered: Map<string, string>;
  outputs: Set<string>;
  /** Files the script is importing now: rid → path. */
  uploads: Map<string, string>;
  timer?: NodeJS.Timeout;
}

const SCRIPT: Record<CodeRequest['language'], { file: string; run: string[] }> = {
  node: { file: 'main.mjs', run: [process.execPath, 'main.mjs'] },
  python: { file: 'main.py', run: ['python3', '-u', 'main.py'] },
  bash: { file: 'main.sh', run: ['bash', 'main.sh'] },
};

const deny = new Set<string>(CODE_DENIED_TOOLS);

export async function newCodeJob(scratch: string): Promise<CodeJob> {
  const id = randomBytes(12).toString('hex');
  const dir = join(scratch, `cfc${id}`);
  for (const d of ['in', 'out', 'tmp', '.cf/bin', 'node_modules']) {
    await mkdir(join(dir, d), { recursive: true });
  }
  // `import { cf } from 'cuttingfloor'` resolves here, to the SDK's real path; `cf` for bash.
  await symlink(SDK, join(dir, 'node_modules', 'cuttingfloor'));
  await symlink(join(SDK, 'bin', 'cf.ts'), join(dir, '.cf', 'bin', 'cf'));
  return {
    id,
    secret: randomBytes(24).toString('base64url'),
    dir,
    pending: new Map(),
    delivered: new Map(),
    outputs: new Set(),
    uploads: new Map(),
  };
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');

/** Stores a file the main server sent for a request and answers whoever asked for it. */
export async function deliverFile(
  job: CodeJob,
  rid: string,
  name: string,
  body: IncomingMessage,
): Promise<void> {
  const waiting = job.pending.get(rid);
  if (!waiting?.file) throw new CfError('not_found', 'No such file request');
  const path = join(job.dir, 'in', safeName(name));
  await pipeline(body, createWriteStream(path, { mode: 0o444 }));
  job.pending.delete(rid);
  waiting.resolve({ result: { path } });
}

export function replyTo(job: CodeJob, rid: string, reply: CodeReply): void {
  const waiting = job.pending.get(rid);
  if (!waiting) throw new CfError('not_found', 'No such request');
  job.pending.delete(rid);
  waiting.resolve(reply);
}

/** Runs the script to the end: its exit, log tails and out/ files. */
export async function runCode(
  job: CodeJob,
  request: CodeRequest,
  send: (e: CodeEvent) => void,
  signal: AbortSignal,
  isolation: Isolation = codeIsolation(),
): Promise<CodeDone> {
  const token = randomBytes(24).toString('base64url');
  const ask = (event: (rid: string) => CodeEvent, file = false): Promise<CodeReply> => {
    const rid = randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      job.pending.set(rid, { resolve, file });
      send(event(rid));
    });
  };
  const fileFor = new Map<string, Promise<CodeReply>>();
  const fetchFile = (ref: { media_id?: string; timeline_id?: string }) => {
    const key = ref.media_id ?? ref.timeline_id ?? '';
    let p = fileFor.get(key);
    if (!p) {
      p = ask((rid) => ({ file: { rid, ...ref } }), true);
      fileFor.set(key, p);
    }
    return p;
  };

  // The script's one door: HTTP over a Unix socket in its own folder.
  const socket = join(job.dir, '.cf', 'api.sock');
  const broker = createServer((req, res) => {
    void broke(req, res).catch((error) =>
      json(res, 500, { error: { code: 'engine_error', message: (error as Error).message } }),
    );
  });
  async function broke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return json(res, 401, { error: { code: 'bad_request', message: 'Missing or wrong token' } });
    }
    const body = (await readJson(req)) as Record<string, unknown>;
    if (req.method === 'POST' && req.url === '/call') {
      const tool = String(body.tool ?? '');
      if (deny.has(tool)) {
        return json(res, 200, {
          error: {
            code: 'bad_request',
            message: `${tool} can't be called from code.run`,
            hint:
              tool === 'code.run'
                ? 'Do the work in this script instead'
                : "Render pages right here: import { motion, still } from 'cuttingfloor' runs the same renderer",
          },
        });
      }
      const args = (body.args ?? {}) as Record<string, unknown>;
      return json(res, 200, await ask((rid) => ({ call: { rid, tool, args } })));
    }
    if (req.method === 'POST' && req.url === '/file') {
      const ref = body.media_id
        ? { media_id: String(body.media_id) }
        : { timeline_id: String(body.timeline_id ?? '') };
      return json(res, 200, await fetchFile(ref));
    }
    if (req.method === 'POST' && req.url === '/upload') {
      const path = await realpath(resolve(job.dir, String(body.path ?? ''))).catch(() => '');
      const s = path ? await stat(path) : undefined;
      if (!path.startsWith(`${job.dir}/`) || !s?.isFile()) {
        return json(res, 200, {
          error: { code: 'bad_request', message: `Not a file in the job folder: ${body.path}` },
        });
      }
      const name = safeName(String(body.name ?? basename(path))).slice(-128);
      return json(
        res,
        200,
        await ask((rid) => {
          job.uploads.set(rid, path);
          return { upload: { rid, name, bytes: s.size } };
        }),
      );
    }
    if (req.method === 'POST' && req.url === '/progress') {
      send({
        progress: Math.max(0, Math.min(1, Number(body.fraction) || 0)),
        message: String(body.message ?? '').slice(0, 200),
      });
      return json(res, 200, { result: {} });
    }
    json(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  }
  await new Promise<void>((resolve, reject) => {
    broker.once('error', reject);
    broker.listen(socket, resolve);
  });

  try {
    send({ progress: 0, message: 'fetching inputs' });
    for (const ref of request.inputs) {
      const reply = await fetchFile(ref);
      if ('error' in reply) {
        throw new CfError(reply.error.code, reply.error.message, {
          ...(reply.error.hint ? { hint: reply.error.hint } : {}),
          ...(reply.error.detail ? { detail: reply.error.detail } : {}),
        });
      }
    }
    const script = SCRIPT[request.language];
    await writeFile(join(job.dir, script.file), request.script);
    send({ progress: 0.05, message: 'running' });
    return await execute(job, script.run, token, request.timeout_seconds, isolation, signal);
  } finally {
    broker.close();
    for (const waiting of job.pending.values()) {
      waiting.resolve({ error: { code: 'cancelled', message: 'The script ended' } });
    }
    job.pending.clear();
  }
}

function execute(
  job: CodeJob,
  run: string[],
  token: string,
  timeoutSeconds: number,
  isolation: Isolation,
  signal: AbortSignal,
): Promise<CodeDone> {
  const marker = `CUTTINGFLOOR_CODE_JOB=${job.id}`;
  const [markerKey, markerValue] = marker.split('=') as [string, string];
  // The OOM killer takes the script, not the worker; namespaces keep it from everything else.
  const isolated =
    isolation === 'namespaces'
      ? [
          'unshare',
          '--user',
          '--map-current-user',
          '--pid',
          '--fork',
          '--kill-child',
          '--net',
          '--ipc',
          '--uts',
          '--',
          ...run,
        ]
      : run;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/bin/sh',
      ['-c', '{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null; exec "$@"', 'sh', ...isolated],
      {
        cwd: job.dir,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: [
            join(job.dir, '.cf', 'bin'),
            dirname(process.execPath),
            '/usr/local/bin:/usr/bin:/bin',
          ].join(':'),
          HOME: job.dir,
          TMPDIR: join(job.dir, 'tmp'),
          LANG: 'C.UTF-8',
          CF_SOCKET: join(job.dir, '.cf', 'api.sock'),
          CF_TOKEN: token,
          CF_IN: join(job.dir, 'in'),
          CF_OUT: join(job.dir, 'out'),
          PYTHONPATH: join(SDK, 'python'),
          QT_QPA_PLATFORM: 'offscreen',
          DISPLAY: ':0',
          ...(process.env.CUTTINGFLOOR_CHROMIUM
            ? { CUTTINGFLOOR_CHROMIUM: process.env.CUTTINGFLOOR_CHROMIUM }
            : {}),
          [markerKey]: markerValue,
        },
      },
    );
    const tail = { stdout: '', stderr: '' };
    const keep = (k: 'stdout' | 'stderr') => (d: Buffer) => {
      tail[k] = (tail[k] + d.toString()).slice(-CODE_LIMITS.logTail);
    };
    child.stdout.on('data', keep('stdout'));
    child.stderr.on('data', keep('stderr'));
    let why: 'timeout' | 'cancelled' | undefined;
    const kill = () => {
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        // Already gone.
      }
      void reap(marker);
    };
    const timer = setTimeout(() => {
      why = 'timeout';
      kill();
    }, timeoutSeconds * 1000);
    const onAbort = () => {
      why = 'cancelled';
      kill();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) =>
      reject(new CfError('engine_error', `Could not start the script: ${e.message}`)),
    );
    child.on('close', async (code, sig) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      kill();
      await reap(marker);
      if (why === 'cancelled') return reject(new CfError('cancelled', 'Cancelled'));
      if (why === 'timeout') {
        return reject(
          new CfError('limit_exceeded', `The script ran longer than ${timeoutSeconds} s`, {
            hint: 'Raise timeout_seconds (up to 1800), or do less per run',
            detail: { stdout: tail.stdout.slice(-4000), stderr: tail.stderr.slice(-4000) },
          }),
        );
      }
      if (code !== 0 && /^unshare: /m.test(tail.stderr)) {
        return reject(
          new CfError('engine_error', 'The sandbox could not isolate the script', {
            hint: 'Run the motion service with tools/motion/seccomp.json as its seccomp profile, as compose.yaml does',
            detail: { stderr: tail.stderr.slice(-1000) },
          }),
        );
      }
      try {
        const outputs = await listOutputs(job);
        resolve({
          exit_code: code,
          signal: sig,
          stdout: tail.stdout,
          stderr: tail.stderr,
          outputs,
          seconds: Math.round((Date.now() - started) / 100) / 10,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Regular files at the top of out/ (folders and links are ignored). */
async function listOutputs(job: CodeJob): Promise<CodeDone['outputs']> {
  const out = join(job.dir, 'out');
  const found: CodeDone['outputs'] = [];
  for (const listed of (await readdir(out)).sort()) {
    if (listed.startsWith('.')) continue;
    const s = await lstat(join(out, listed));
    if (!s.isFile()) continue;
    // Names travel in URLs: anything unusual becomes underscores.
    const name = safeName(listed).slice(-128);
    if (name !== listed) await rename(join(out, listed), join(out, name));
    found.push({ name, bytes: s.size });
  }
  if (found.length > CODE_LIMITS.maxOutputs) {
    throw new CfError(
      'limit_exceeded',
      `The script wrote ${found.length} files to out/; the limit is ${CODE_LIMITS.maxOutputs}`,
      { hint: 'Write fewer, larger files (or a timeline that refers to fewer pieces)' },
    );
  }
  for (const f of found) job.outputs.add(f.name);
  return found;
}

export async function dropCodeJob(job: CodeJob): Promise<void> {
  if (job.timer) clearTimeout(job.timer);
  await rm(job.dir, { recursive: true, force: true });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new CfError('limit_exceeded', 'The request is too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CfError('bad_request', 'The request is not JSON');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
