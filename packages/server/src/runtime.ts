import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism, hostname } from 'node:os';
import { extname, join } from 'node:path';
import { ownerKey, TimelineStore, Workspace } from '@cuttingfloor/core';
import {
  MEDIA_TTL_MS,
  MediaLibrary,
  renderLoad,
  setRenderLimit,
  watchRenderQueue,
} from '@cuttingfloor/engine';
import { FileJobStore, type Job, JobRunner } from '@cuttingfloor/jobs';
import { METER_TTL_MS, type MeterEntry, meterJob } from './meter.ts';
import { Uploads } from './uploads.ts';

/**
 * A signed output link as signOutput writes it, on any origin (the public URL may have moved):
 * /outputs/ or /watch/, owner key, id, file name, exp and sig.
 */
const SIGNED_LINK =
  /https?:\/\/[^/\s"\\]+\/(outputs|watch)\/([A-Za-z0-9_-]{1,64}\/(?:j|f|m)_[0-9a-z]{26}\/[^/?\s"\\]+)\?exp=(\d+)&sig=([A-Za-z0-9_-]+)/g;

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
  /** Cut-outs at once, apart from maxJobs. */
  heavyJobs?: number;
  /**
   * Renders (melt, encodes, transcription) that may run at once, jobs and inline previews
   * together; the rest wait their turn. Default: half the CPUs, at least 2.
   */
  maxRenders?: number;
  outputUrlTtlMs: number;
  maxDownloadBytes: number;
  allowPrivateUrls: boolean;
  /** Largest output `resources/read` returns inline; bigger ones answer with the signed URL. */
  inlineMaxBytes: number;
  /** Where downloaded models (transcription) live. Default: `models` under the data root. */
  modelsDir?: string;
  /** The motion sandbox (cuttingfloor motion-worker) for create.motion and create.still. */
  motionUrl: string | null;
  /** This server's name in job records, so servers sharing a data root know whose jobs are whose. */
  node?: string;
  /**
   * Jev judgments each owner may ask a day on the server's key, shared by media.analyze look (one
   * a frame) and judge.ask (one a call, plus one per picture past the first); unset means no limit
   * (local mode).
   */
  judgmentsPerDay?: number;
  /** TypeSafe's API, for judge.ask and media.analyze look. Default: api.typesafe.ai. */
  typesafeUrl?: string;
  /** sync. labs' API, for create.lipsync. Default: api.sync.so. */
  syncUrl?: string;
  /** Hosted: the account page where users save their own provider keys (named in errors). */
  keysUrl?: string;
  /** Local mode: the folder on the user's machine compose mounts at /media/videos. */
  mediaHostPath?: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const mode = env.CUTTINGFLOOR_MODE === 'hosted' ? 'hosted' : 'local';
  const port = env.PORT ?? '8787';
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  // The look-only name from before judge.ask still sets the shared budget.
  const perDay = env.CUTTINGFLOOR_JUDGMENTS_PER_DAY ?? env.CUTTINGFLOOR_LOOK_FRAMES_PER_DAY;
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
    ...(env.CUTTINGFLOOR_HEAVY_JOBS ? { heavyJobs: Number(env.CUTTINGFLOOR_HEAVY_JOBS) } : {}),
    ...(env.CUTTINGFLOOR_MAX_RENDERS ? { maxRenders: Number(env.CUTTINGFLOOR_MAX_RENDERS) } : {}),
    outputUrlTtlMs: Number(env.CUTTINGFLOOR_OUTPUT_URL_TTL_HOURS ?? 24) * 3_600_000,
    maxDownloadBytes: Number(env.CUTTINGFLOOR_MAX_DOWNLOAD_BYTES ?? 10 * 1024 ** 3),
    allowPrivateUrls: env.CUTTINGFLOOR_ALLOW_PRIVATE_URLS === '1',
    inlineMaxBytes: Number(env.CUTTINGFLOOR_INLINE_MAX_BYTES ?? 32 * 1024 ** 2),
    ...(env.CUTTINGFLOOR_MODELS ? { modelsDir: env.CUTTINGFLOOR_MODELS } : {}),
    motionUrl: env.CUTTINGFLOOR_MOTION_URL?.replace(/\/$/, '') || null,
    node: env.CUTTINGFLOOR_NODE ?? (mode === 'local' ? 'local' : hostname()),
    ...(perDay || mode === 'hosted' ? { judgmentsPerDay: Number(perDay || 5000) } : {}),
    ...(env.CUTTINGFLOOR_TYPESAFE_URL
      ? { typesafeUrl: env.CUTTINGFLOOR_TYPESAFE_URL.replace(/\/$/, '') }
      : {}),
    ...(env.CUTTINGFLOOR_SYNC_URL ? { syncUrl: env.CUTTINGFLOOR_SYNC_URL.replace(/\/$/, '') } : {}),
    ...(mode === 'hosted' && env.CUTTINGFLOOR_KEY_SECRET
      ? {
          keysUrl: `${(env.CUTTINGFLOOR_ACCOUNT_URL ?? 'https://cuttingfloor.ai/account').replace(/\/$/, '')}#keys`,
        }
      : {}),
    ...(mode === 'local' && env.CUTTINGFLOOR_MEDIA_HOST_PATH
      ? { mediaHostPath: env.CUTTINGFLOOR_MEDIA_HOST_PATH }
      : {}),
  };
}

/** Process-wide services shared by every per-request server instance. */
export class Runtime {
  readonly config: RuntimeConfig;
  readonly ws: Workspace;
  readonly timelines: TimelineStore;
  readonly media: MediaLibrary;
  readonly jobs: JobRunner;
  readonly uploads: Uploads;
  /** Downloaded models, kept across restarts (they are checksummed, not user data). */
  readonly modelsDir: string;
  #secret: Buffer | undefined;
  #sweeper: NodeJS.Timeout | undefined;
  #reaper: NodeJS.Timeout | undefined;
  #onMetered = new Set<(job: Job, entry: MeterEntry) => void>();

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
      ...(config.mediaHostPath ? { hostFolders: { '/media/videos': config.mediaHostPath } } : {}),
    });
    if (config.maxRenders) setRenderLimit(config.maxRenders);
    this.jobs = new JobRunner(new FileJobStore(this.ws), config.maxJobs, {
      ...(config.node ? { node: config.node } : {}),
      ...(config.heavyJobs ? { heavy: config.heavyJobs } : {}),
      onEnd: (job) =>
        void meterJob(this.ws, job).then(
          (entry) => {
            if (entry) for (const listener of this.#onMetered) listener(job, entry);
          },
          (error: Error) => process.stderr.write(`meter: ${job.id}: ${error.message}\n`),
        ),
      // A job whose render waits for a slot says so, and where it stands.
      around: (ctx, work) =>
        watchRenderQueue(
          {
            queued: (ahead) =>
              ctx.status(
                `waiting for a render slot: ${ahead === 0 ? 'next in line' : `${ahead} ahead`} (${renderLoad().limit} renders run at once on this server)`,
              ),
            started: () => ctx.status('rendering'),
          },
          work,
        ),
    });
    // Uploads take files as big as URL imports may download.
    this.uploads = new Uploads(this.ws, {
      secret: () => this.secret(),
      publicUrl: () => this.config.publicUrl,
      maxBytes: config.maxDownloadBytes,
    });
  }

  /**
   * Loads the signing secret, recovers interrupted jobs and starts the hourly TTL sweep. Cached
   * frames go: a timeline id names the edit, not the renderer, so frames an older build drew
   * would otherwise outlive a fix to how they are drawn.
   */
  async start(options: { sweep?: boolean } = {}): Promise<void> {
    await this.secret();
    await this.ws.remove(this.ws.path('cache', 'frames'));
    await this.jobs.recover();
    if (options.sweep !== false) {
      await this.sweep();
      this.#sweeper = setInterval(() => void this.sweep().catch(() => undefined), 3_600_000);
      this.#sweeper.unref();
      // Jobs whose server died, wherever they ran, end interrupted within a few minutes.
      this.#reaper = setInterval(
        () => void this.jobs.recover({ startup: false }).catch(() => undefined),
        60_000,
      );
      this.#reaper.unref();
    }
  }

  /** Tells `listener` about each job this server meters, once its time is recorded. */
  onMetered(listener: (job: Job, entry: MeterEntry) => void): () => void {
    this.#onMetered.add(listener);
    return () => this.#onMetered.delete(listener);
  }

  stop(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
    if (this.#reaper) clearInterval(this.#reaper);
  }

  async sweep(): Promise<void> {
    await this.timelines.sweep();
    await this.media.sweep(MEDIA_TTL_MS);
    await this.jobs.store.sweep();
    // Frames kept for download (render.frames urls) last as long as their links.
    for (const owner of await this.ws.owners()) {
      await this.ws.sweep(
        this.ws.path('owners', owner, 'outputs'),
        this.config.outputUrlTtlMs,
        (name) => !name.startsWith('f_'),
      );
    }
    await this.uploads.sweep();
    for (const owner of await this.ws.owners()) {
      await this.ws.sweep(this.ws.path('owners', owner, 'usage'), 2 * 24 * 3_600_000);
      await this.ws.sweep(this.ws.path('owners', owner, 'meter'), METER_TTL_MS);
    }
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

  /**
   * A signed, time-limited download URL for a file under `outputs/{id}/`: a job's output (`j_…`),
   * or frames kept for download (`f_…`). A media id (`m_…`) signs the media's own file.
   * `pageUrl` is the same signature on /watch/…, a page that plays the file in a browser.
   */
  async signOutput(
    owner: string,
    jobId: string,
    file: string,
  ): Promise<{ url: string; pageUrl: string; expiresAt: string }> {
    const exp = Date.now() + this.config.outputUrlTtlMs;
    const path = `/outputs/${ownerKey(owner)}/${jobId}/${encodeURIComponent(file)}`;
    const sig = createHmac('sha256', await this.secret())
      .update(`${path}\n${exp}`)
      .digest('base64url');
    const query = `?exp=${exp}&sig=${sig}`;
    return {
      url: `${this.config.publicUrl}${path}${query}`,
      pageUrl: `${this.config.publicUrl}/watch${path.slice('/outputs'.length)}${query}`,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  /**
   * The same value with every signed output link in it signed again, from now: a finished job
   * keeps the links it was made with, and those stop working outputUrlTtlMs after the job ends
   * while its file lives on (7 days). Reading the job hands out working links instead. Only
   * links this server signed are renewed (the old signature must check out, expired or not), and
   * each old expiry time in the value moves to the new one.
   */
  async freshLinks<T>(value: T): Promise<T> {
    if (value === undefined || value === null) return value;
    const text = JSON.stringify(value);
    const found = [...text.matchAll(SIGNED_LINK)];
    if (!found.length) return value;
    const secret = await this.secret();
    const exp = Date.now() + this.config.outputUrlTtlMs;
    const renewed = new Map<string, string>();
    const expiries = new Set<string>();
    for (const m of found) {
      const [link, , rest, oldExp, sig] = m as unknown as [string, string, string, string, string];
      if (renewed.has(link)) continue;
      const path = `/outputs/${rest}`;
      const expected = createHmac('sha256', secret).update(`${path}\n${oldExp}`).digest();
      const given = Buffer.from(sig, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) continue;
      const fresh = createHmac('sha256', secret).update(`${path}\n${exp}`).digest('base64url');
      const page = m[1] === 'watch' ? '/watch' : '/outputs';
      renewed.set(link, `${this.config.publicUrl}${page}/${rest}?exp=${exp}&sig=${fresh}`);
      const at = new Date(Number(oldExp));
      if (!Number.isNaN(at.getTime())) expiries.add(at.toISOString());
    }
    if (!renewed.size) return value;
    const until = new Date(exp).toISOString();
    let out = text.replace(SIGNED_LINK, (link) => renewed.get(link) ?? link);
    for (const old of expiries) out = out.replaceAll(old, until);
    return JSON.parse(out) as T;
  }

  /** A signed download URL for a media item's file; undefined while it has none. */
  async signMedia(
    owner: string,
    record: {
      media_id: string;
      name: string;
      file: string | null;
      probe?: { extension?: string } | null;
    },
  ): Promise<{ url: string; pageUrl: string; expiresAt: string } | undefined> {
    if (!record.file) return undefined;
    // Downloaded under the extension its format takes, whatever the name says (a PNG named .svg).
    const ext = record.probe?.extension ?? extname(record.file);
    const base = record.name.replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '') || record.media_id;
    const own = /^\.[A-Za-z0-9]{1,5}$/.test(extname(base)) ? extname(base) : '';
    const name =
      own.toLowerCase() === ext.toLowerCase()
        ? base
        : `${base.slice(0, base.length - own.length) || base}${ext}`;
    return this.signOutput(owner, record.media_id, name);
  }

  /**
   * Checks a signed output URL. Returns the file on disk and the name to download it as, or
   * undefined when invalid or expired.
   */
  async verifyOutput(
    pathname: string,
    exp: string | null,
    sig: string | null,
  ): Promise<string | undefined> {
    const m = /^\/outputs\/([A-Za-z0-9_-]{1,64})\/((?:j|f|m)_[0-9a-z]{26})\/([^/]+)$/.exec(
      pathname,
    );
    if (!m || !exp || !sig || !(Number(exp) > Date.now())) return undefined;
    const expected = createHmac('sha256', await this.secret())
      .update(`${pathname}\n${exp}`)
      .digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    const name = decodeURIComponent(m[3] ?? '');
    if (name.includes('/') || name.startsWith('.')) return undefined;
    const key = m[1] ?? '';
    const id = m[2] ?? '';
    if (id.startsWith('m_')) {
      // An owner key is its own key, so the media library finds the owner's media by it.
      const record = await this.media.find(key, id);
      return record?.file ?? undefined;
    }
    return this.ws.path('owners', key, 'outputs', id, name);
  }
}
