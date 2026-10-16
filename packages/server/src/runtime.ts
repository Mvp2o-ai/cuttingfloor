import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { ownerKey, TimelineStore, Workspace } from '@cuttingfloor/core';
import { MEDIA_TTL_MS, MediaLibrary } from '@cuttingfloor/engine';
import { FileJobStore, JobRunner } from '@cuttingfloor/jobs';

export interface RuntimeConfig {
  /** Data root: timelines, media, jobs, outputs and caches, all with TTLs. */
  dataDir: string;
  /** `local`: one user, path imports from media roots, exports copied to `exportsDir`. */
  mode: 'local' | 'hosted';
  /** Base URL clients reach this server on, for signed output links. */
  publicUrl: string;
  mediaRoots: string[];
  exportsDir: string | null;
  maxJobs: number;
  outputUrlTtlMs: number;
  maxDownloadBytes: number;
  allowPrivateUrls: boolean;
  /** Largest output `resources/read` returns inline; bigger ones answer with the signed URL. */
  inlineMaxBytes: number;
  /** Where downloaded models (transcription) live. Default: `models` under the data root. */
  modelsDir?: string;
  /** The motion sandbox (cuttingfloor motion-worker) for create.motion and create.still. */
  motionUrl: string | null;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const mode = env.CUTTINGFLOOR_MODE === 'hosted' ? 'hosted' : 'local';
  const port = env.PORT ?? '8787';
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    dataDir: env.CUTTINGFLOOR_DATA ?? '/data',
    mode,
    publicUrl: (env.CUTTINGFLOOR_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    mediaRoots:
      mode === 'local'
        ? list(env.CUTTINGFLOOR_MEDIA_ROOTS ?? '/media,/samples')
        : list(env.CUTTINGFLOOR_MEDIA_ROOTS),
    exportsDir: mode === 'local' ? (env.CUTTINGFLOOR_EXPORTS ?? '/exports') : null,
    maxJobs: Number(
      env.CUTTINGFLOOR_MAX_JOBS ?? Math.max(1, Math.floor(availableParallelism() / 4)),
    ),
    outputUrlTtlMs: Number(env.CUTTINGFLOOR_OUTPUT_URL_TTL_HOURS ?? 24) * 3_600_000,
    maxDownloadBytes: Number(env.CUTTINGFLOOR_MAX_DOWNLOAD_BYTES ?? 10 * 1024 ** 3),
    allowPrivateUrls: env.CUTTINGFLOOR_ALLOW_PRIVATE_URLS === '1',
    inlineMaxBytes: Number(env.CUTTINGFLOOR_INLINE_MAX_BYTES ?? 32 * 1024 ** 2),
    ...(env.CUTTINGFLOOR_MODELS ? { modelsDir: env.CUTTINGFLOOR_MODELS } : {}),
    motionUrl: env.CUTTINGFLOOR_MOTION_URL?.replace(/\/$/, '') || null,
  };
}

/** Process-wide services shared by every per-request server instance. */
export class Runtime {
  readonly config: RuntimeConfig;
  readonly ws: Workspace;
  readonly timelines: TimelineStore;
  readonly media: MediaLibrary;
  readonly jobs: JobRunner;
  /** Downloaded models, kept across restarts (they are checksummed, not user data). */
  readonly modelsDir: string;
  #secret: Buffer | undefined;
  #sweeper: NodeJS.Timeout | undefined;

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.ws = new Workspace(config.dataDir);
    this.modelsDir = config.modelsDir ?? join(config.dataDir, 'models');
    this.timelines = new TimelineStore(this.ws);
    this.media = new MediaLibrary(this.ws, {
      roots: config.mediaRoots,
      maxDownloadBytes: config.maxDownloadBytes,
      downloadTimeoutMs: 30 * 60_000,
      allowPrivateUrls: config.allowPrivateUrls,
    });
    this.jobs = new JobRunner(new FileJobStore(this.ws), config.maxJobs);
  }

  /** Loads the signing secret, recovers interrupted jobs and starts the hourly TTL sweep. */
  async start(options: { sweep?: boolean } = {}): Promise<void> {
    await this.secret();
    await this.jobs.recover();
    if (options.sweep !== false) {
      await this.sweep();
      this.#sweeper = setInterval(() => void this.sweep().catch(() => undefined), 3_600_000);
      this.#sweeper.unref();
    }
  }

  stop(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
  }

  async sweep(): Promise<void> {
    await this.timelines.sweep();
    await this.media.sweep(MEDIA_TTL_MS);
    await this.jobs.store.sweep();
    await this.ws.sweep(this.ws.path('cache', 'frames'), 24 * 3_600_000);
  }

  async secret(): Promise<Buffer> {
    if (this.#secret) return this.#secret;
    const file = this.ws.path('secret.key');
    await this.ws.writeJson(file, { key: randomBytes(32).toString('base64') }, { exclusive: true });
    const { key } = JSON.parse(await readFile(file, 'utf8')) as { key: string };
    this.#secret = Buffer.from(key, 'base64');
    return this.#secret;
  }

  /** A signed, time-limited download URL for a job output. */
  async signOutput(
    owner: string,
    jobId: string,
    file: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const exp = Date.now() + this.config.outputUrlTtlMs;
    const path = `/outputs/${ownerKey(owner)}/${jobId}/${encodeURIComponent(file)}`;
    const sig = createHmac('sha256', await this.secret())
      .update(`${path}\n${exp}`)
      .digest('base64url');
    return {
      url: `${this.config.publicUrl}${path}?exp=${exp}&sig=${sig}`,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  /** Checks a signed output URL. Returns the file on disk, or undefined when invalid or expired. */
  async verifyOutput(
    pathname: string,
    exp: string | null,
    sig: string | null,
  ): Promise<string | undefined> {
    const m = /^\/outputs\/([A-Za-z0-9_-]{1,64})\/(j_[0-9a-z]{26})\/([^/]+)$/.exec(pathname);
    if (!m || !exp || !sig || !(Number(exp) > Date.now())) return undefined;
    const expected = createHmac('sha256', await this.secret())
      .update(`${pathname}\n${exp}`)
      .digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    const name = decodeURIComponent(m[3] ?? '');
    if (name.includes('/') || name.startsWith('.')) return undefined;
    return this.ws.path('owners', m[1] ?? '', 'outputs', m[2] ?? '', name);
  }
}
