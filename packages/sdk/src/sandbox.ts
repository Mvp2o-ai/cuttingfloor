import { mkdtemp, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { type MotionJob, pageDocument, renderMotion, renderStill } from '@cuttingfloor/motion';
import { CfError, type CodeReply, type ErrorCode, type MediaInfo } from '@cuttingfloor/schema';
import type { ToolResult, Transport } from './client.ts';

// Inside a code.run job: the socket to the tools, the job's folders, and the same page renderer
// create.motion and create.still use, run right here.

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new CfError('engine_error', `${name} is not set: this only works inside code.run`, {
      hint: 'Run the script with the code.run tool',
    });
  }
  return v;
}

/** One request to the job's socket. */
function ask(path: string, body: unknown): Promise<CodeReply> {
  const payload = JSON.stringify(body);
  return new Promise((done, fail) => {
    const req = request(
      {
        socketPath: env('CF_SOCKET'),
        path,
        method: 'POST',
        headers: {
          authorization: `Bearer ${env('CF_TOKEN')}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            done(JSON.parse(Buffer.concat(chunks).toString('utf8')) as CodeReply);
          } catch (e) {
            fail(e);
          }
        });
      },
    );
    req.on('error', fail);
    req.end(payload);
  });
}

const fail = (reply: Extract<CodeReply, { error: unknown }>) =>
  new CfError(reply.error.code as ErrorCode, reply.error.message, {
    ...(reply.error.hint ? { hint: reply.error.hint } : {}),
    ...(reply.error.detail ? { detail: reply.error.detail } : {}),
  });

/** Tool calls through the job's socket, answered by the main server as the job's owner. */
export const sandboxTransport: Transport = async (tool, args) => {
  const reply = await ask('/call', { tool, args });
  if ('error' in reply) return { isError: true, structuredContent: reply.error };
  return reply.result as ToolResult;
};

/**
 * A media item's file (m_…) or a timeline's JSON (t_…), fetched into in/ once; the path to it.
 * Inputs named in code.run are already there.
 */
export async function file(id: string): Promise<string> {
  const reply = await ask('/file', id.startsWith('m_') ? { media_id: id } : { timeline_id: id });
  if ('error' in reply) throw fail(reply);
  return (reply.result as { path: string }).path;
}

/**
 * Imports a file the script made (anywhere in its folder) as media now, so the same script can
 * place it with cf.clip.add. Returns the media, as media.get would.
 */
export async function importFile(path: string, name?: string): Promise<MediaInfo> {
  const reply = await ask('/upload', { path: resolve(path), ...(name ? { name } : {}) });
  if ('error' in reply) throw fail(reply);
  return reply.result as MediaInfo;
}

/** in/ (inputs) and out/ (everything written here comes back as media or timelines). */
export const dirs = {
  get in(): string {
    return env('CF_IN');
  },
  get out(): string {
    return env('CF_OUT');
  },
};

/** A path in out/. */
export const out = (name: string): string => join(dirs.out, basename(name));

/** Reports progress on the code.run job (0–1). */
export async function progress(fraction: number, message = ''): Promise<void> {
  await ask('/progress', { fraction, message });
}

export interface PageOptions {
  /** HTML (a fragment or a whole page), or… */
  html?: string;
  /** …a page on disk; files next to it (images, fonts, scripts) load relative to it. */
  file?: string;
  width?: number;
  height?: number;
  /** Unpainted areas stay transparent (default true). */
  transparent?: boolean;
  /** Where to write it. Default: a new file in out/. */
  out?: string;
  /** Seeds Math.random in the page. */
  seed?: number;
}

async function page(options: PageOptions, width: number, height: number) {
  if (options.file) {
    const path = resolve(options.file);
    return { root: dirname(path), entry: basename(path) };
  }
  if (!options.html) throw new CfError('bad_request', 'Give html or file');
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'cf-page-'));
  await writeFile(join(root, 'index.html'), pageDocument(options.html, width, height));
  return { root, entry: 'index.html' };
}

let made = 0;
const quiet = () => undefined;

/**
 * One page renders at a time in a script: a motion render already opens several browsers, so
 * renders started together (Promise.all) wait their turn instead of running the sandbox out of
 * memory.
 */
let turn: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const mine = turn.then(work, work);
  turn = mine.catch(() => undefined);
  return mine;
}

/**
 * Renders an animated page frame by frame, exactly as create.motion does: ProRes 4444 with alpha
 * (transparent, default) or H.264. Returns the file's path. Renders run one at a time, in the
 * order they were asked for.
 */
export async function motion(
  options: PageOptions & { duration: number; fps?: number },
): Promise<string> {
  const job: MotionJob = {
    kind: 'motion',
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    fps: options.fps ?? 30,
    duration: options.duration,
    transparent: options.transparent ?? true,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  };
  made += 1;
  const dest = options.out ?? out(`motion-${made}.${job.transparent ? 'mov' : 'mp4'}`);
  return oneAtATime(async () => {
    const { root, entry } = await page(options, job.width, job.height);
    const profile = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'cf-profile-'));
    return renderMotion(root, job, quiet, { entry, out: dest, profile });
  });
}

/** Renders a page to a PNG, exactly as create.still does. Returns the file's path. */
export async function still(options: PageOptions): Promise<string> {
  const job: MotionJob = {
    kind: 'still',
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    fps: 30,
    duration: 0,
    transparent: options.transparent ?? true,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  };
  made += 1;
  const dest = options.out ?? out(`still-${made}.png`);
  return oneAtATime(async () => {
    const { root, entry } = await page(options, job.width, job.height);
    const profile = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'cf-profile-'));
    return renderStill(root, job, quiet, { entry, out: dest, profile });
  });
}
