import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism, hostname } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import {
  type BlobKey,
  defineCollection,
  MongoRecords,
  mongoUri,
  ownerKey,
  type S3Settings,
  s3SettingsFromEnv,
  TimelineStore,
  Workspace,
} from '@cuttingfloor/core';
import {
  CLAP_MODEL,
  clapTexts,
  MEDIA_TTL_MS,
  MediaLibrary,
  renderLoad,
  setRenderLimit,
  watchRenderQueue,
} from '@cuttingfloor/engine';
import { FileJobStore, type Job, JobRunner } from '@cuttingfloor/jobs';
import { KEEP } from '@cuttingfloor/schema';
import { CALLS, CALLS_TTL_MS, type CallEntry, jobEnd, recordCall } from './calls.ts';
import { Drain } from './drain.ts';
import { DownloadGate, type GateHooks, RELEASES } from './gate.ts';
import { SearchIndexer } from './indexer.ts';
import { markLive } from './live.ts';
import { METER, METER_TTL_MS, type MeterEntry, meterJob, meterJudgments } from './meter.ts';
import { Outputs } from './outputs.ts';
import { MongoSoundLibrary, RemoteSoundLibrary, type SoundLibrary } from './sound-library.ts';
import { Uploads } from './uploads.ts';

/**
 * A signed output link as signOutput writes it, on any origin (the public URL may have moved):
 * /outputs/ or /watch/, owner key, id, file name, exp and sig.
 */
const SIGNED_LINK =
  /https?:\/\/[^/\s"\\]+\/(outputs|watch)\/([A-Za-z0-9_-]{1,64}\/(?:j|f|m)_[0-9a-z]{26}\/[^/?\s"\\]+)\?exp=(\d+)&sig=([A-Za-z0-9_-]+)/g;

/** Usage counts an older build kept per owner; nothing writes them now, and what is left goes. */
const LEGACY_USAGE = defineCollection<unknown>({
  name: 'usage',
  scope: 'owner',
  fs: { dir: 'usage' },
});

const FUNNEL_TTL_MS = 400 * 24 * 3_600_000;

/** Hosted sign-in steps, grouped by day (apps/hosted funnel.ts writes them). */
export const FUNNEL_DAYS = defineCollection<unknown>({
  name: 'funnel',
  scope: 'global',
  fs: { dir: (day) => `funnel/${day}` },
  // A day goes whole, by its newest step: its oldest is up to a day older.
  db: { ttlMs: FUNNEL_TTL_MS + 24 * 3_600_000 },
});

/**
 * Hosted: an owner's downloads, one record per file and UTC day (`{file_id}.{yyyy-mm-dd}`;
 * apps/hosted downloads.ts writes them). Kept as long as sign-in steps.
 */
export const DOWNLOADS = defineCollection<DownloadDay>({
  name: 'downloads',
  scope: 'owner',
  fs: { dir: 'downloads' },
  db: { ttlMs: FUNNEL_TTL_MS },
});

export interface DownloadDay {
  /** The signed link's id: an export job (`j_`), kept frames (`f_`) or a media item (`m_`). */
  file_id: string;
  name: string;
  /** The UTC day, yyyy-mm-dd. */
  day: string;
  first_at: string;
  last_at: string;
  /** Fetches to save the file (the raw link, the page's Download), not counting a player's later ranges. */
  downloads: number;
  /** Fetches to play or show it (the watch page's player, an inline fetch). */
  plays: number;
  /** Watch pages opened. */
  page_views: number;
  /** The client of the day's first request, from its User-Agent (`Mozilla`, `openai-mcp`). */
  agent: string;
}

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
   * The least time a running job may go without any progress before it is ended as stalled and
   * its slot freed; jobs over long media get more. Default 300.
   */
  stallSeconds?: number;
  /** Job slots, beyond maxJobs, that only short jobs take. Default 1. */
  shortJobs?: number;
  /** Jobs reading at most this many seconds of media count as short. Default 60. */
  shortJobSeconds?: number;
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
  /** TypeSafe's API, for judge.ask and media.analyze look. Default: api.typesafe.ai. */
  typesafeUrl?: string;
  /** sync. labs' API, for create.lipsync. Default: api.sync.so. */
  syncUrl?: string;
  /** Hosted: the account page where users save their own provider keys (named in errors). */
  keysUrl?: string;
  /** Hosted: the account page's file drop, where users send files (named in hints). */
  uploadPage?: string;
  /** Local mode: the folder on the user's machine compose mounts at /media/videos. */
  mediaHostPath?: string;
  /**
   * The key that signs download, watch and upload links (CUTTINGFLOOR_URL_SECRET): at least 32
   * bytes, base64 or base64url. Set, every server given it signs and checks the same links and
   * `secret.key` under the data root is never made or read. Unset, the key is that file.
   */
  urlSecret?: string;
  /**
   * Records in MongoDB instead of JSON files under the data root (CUTTINGFLOOR_RECORDS=mongo),
   * for a deployment of more than one server. Files stay under the data root. `uri` is a secret:
   * it is never logged.
   */
  records?: { store: 'mongo'; uri: string; db: string };
  /**
   * Files in an S3 bucket instead of under the data root (CUTTINGFLOOR_BLOBS=s3). The data root
   * then holds this server's caches only. Its keys are secrets: never logged.
   */
  s3?: S3Settings;
  /**
   * Files in a bucket with records still in JSON files under the data root: for development and
   * tests only (CUTTINGFLOOR_S3_FILE_RECORDS=1). Files in a bucket are for more than one server,
   * which only share records in MongoDB, so without this a server refuses to start that way.
   */
  s3FileRecords?: boolean;
  /**
   * A server beside the one in production, on a copy of its data (CUTTINGFLOOR_STANDBY=1): it
   * answers requests, and does nothing to the data by itself. No sweep at start or by the hour,
   * no recovery of jobs, at start or by the minute.
   */
  standby?: boolean;
  /**
   * Takes no new work from the start (CUTTINGFLOOR_DRAIN=1); a file named `drain` in the data
   * root does the same with no restart (drain.ts).
   */
  drain?: boolean;
  /**
   * The sound library sounds.list reads (CUTTINGFLOOR_SOUNDS): `mongo`, the one in this
   * server's record database; or the base url of a server that serves GET /sounds. Default: the
   * record database when records are in MongoDB, else the hosted library.
   */
  sounds?: string;
  /** Where the sound library's files are (CUTTINGFLOOR_SOUNDS_FILES): views play them from there. */
  soundFiles?: string;
}

/** The hosted server, whose sound library every other server reads by default. */
export const HOSTED_SOUNDS = 'https://api.cuttingfloor.ai';

/** How long a link to a file in the bucket works: minted per request behind our own links. */
const BUCKET_LINK_TTL_MS = 3_600_000;

/** Nothing the orphan sweep judges is newer than this: it may be mid-write. */
const ORPHAN_GRACE_MS = 24 * 3_600_000;

/** A signed output link's target: a blob, or a local file where the user's own file is in place. */
export interface OutputTarget {
  /** The name it downloads as. */
  name: string;
  blob?: BlobKey;
  file?: string;
}

/**
 * Where records are kept, from CUTTINGFLOOR_RECORDS: the filesystem unless it says `mongo`, which
 * needs the database's address as one connection string or as its parts.
 */
function recordsFromEnv(env: NodeJS.ProcessEnv): Pick<RuntimeConfig, 'records'> {
  // Trimmed: a value read from a secrets file ends in a newline, which would fail the sign-in.
  const value = (name: string) => env[name]?.trim() ?? '';
  const store = value('CUTTINGFLOOR_RECORDS').toLowerCase();
  if (!store || store === 'fs' || store === 'filesystem') return {};
  // Never what it holds: a connection string pasted here by mistake carries a password.
  if (store !== 'mongo') throw new Error('CUTTINGFLOOR_RECORDS must be fs or mongo');
  const host = value('CUTTINGFLOOR_MONGODB_HOST');
  const user = value('CUTTINGFLOOR_MONGODB_USER');
  const password = value('CUTTINGFLOOR_MONGODB_PASSWORD');
  let uri = value('CUTTINGFLOOR_MONGODB_URI');
  if (uri) {
    if (!/^mongodb(\+srv)?:\/\/./.test(uri)) {
      throw new Error('CUTTINGFLOOR_MONGODB_URI must start with mongodb:// or mongodb+srv://');
    }
  } else {
    if (!host) {
      throw new Error(
        'CUTTINGFLOOR_RECORDS=mongo needs CUTTINGFLOOR_MONGODB_URI, or CUTTINGFLOOR_MONGODB_HOST with CUTTINGFLOOR_MONGODB_USER and CUTTINGFLOOR_MONGODB_PASSWORD',
      );
    }
    if (password && !user) {
      throw new Error('CUTTINGFLOOR_MONGODB_PASSWORD is set without CUTTINGFLOOR_MONGODB_USER');
    }
    uri = mongoUri({ host, ...(user ? { user, password } : {}) });
  }
  return {
    records: { store: 'mongo', uri, db: value('CUTTINGFLOOR_MONGODB_DB') || 'cuttingfloor' },
  };
}

/** Where files are kept, from CUTTINGFLOOR_BLOBS: the filesystem unless it says `s3`. */
function blobsFromEnv(env: NodeJS.ProcessEnv): Pick<RuntimeConfig, 's3'> {
  const s3 = s3SettingsFromEnv(env);
  return s3 ? { s3 } : {};
}

/** The link-signing key from CUTTINGFLOOR_URL_SECRET. The value never appears in the error. */
export function urlSecretKey(value: string): Buffer {
  const text = value.trim();
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(text) ? Buffer.from(text, 'base64') : null;
  if (!key || key.length < 32) {
    throw new Error(
      `CUTTINGFLOOR_URL_SECRET must be at least 32 bytes, base64 or base64url (${key ? `it decodes to ${key.length}` : 'it is not base64'}). Make one with: openssl rand -base64 32. To keep links already handed out working, use the "key" value in secret.key under the data root.`,
    );
  }
  return key;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const mode = env.CUTTINGFLOOR_MODE === 'hosted' ? 'hosted' : 'local';
  const port = env.PORT ?? '8787';
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const account = (env.CUTTINGFLOOR_ACCOUNT_URL ?? 'https://cuttingfloor.ai/account').replace(
    /\/$/,
    '',
  );
  // The look-only name from before judge.ask still sets the shared budget.
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
    ...(env.CUTTINGFLOOR_STALL_SECONDS
      ? { stallSeconds: Number(env.CUTTINGFLOOR_STALL_SECONDS) }
      : {}),
    ...(env.CUTTINGFLOOR_SHORT_JOBS ? { shortJobs: Number(env.CUTTINGFLOOR_SHORT_JOBS) } : {}),
    ...(env.CUTTINGFLOOR_SHORT_JOB_SECONDS
      ? { shortJobSeconds: Number(env.CUTTINGFLOOR_SHORT_JOB_SECONDS) }
      : {}),
    ...(env.CUTTINGFLOOR_MAX_RENDERS ? { maxRenders: Number(env.CUTTINGFLOOR_MAX_RENDERS) } : {}),
    outputUrlTtlMs: env.CUTTINGFLOOR_OUTPUT_URL_TTL_HOURS
      ? Number(env.CUTTINGFLOOR_OUTPUT_URL_TTL_HOURS) * 3_600_000
      : KEEP,
    maxDownloadBytes: Number(env.CUTTINGFLOOR_MAX_DOWNLOAD_BYTES ?? 10 * 1024 ** 3),
    allowPrivateUrls: env.CUTTINGFLOOR_ALLOW_PRIVATE_URLS === '1',
    inlineMaxBytes: Number(env.CUTTINGFLOOR_INLINE_MAX_BYTES ?? 32 * 1024 ** 2),
    ...(env.CUTTINGFLOOR_MODELS ? { modelsDir: env.CUTTINGFLOOR_MODELS } : {}),
    motionUrl: env.CUTTINGFLOOR_MOTION_URL?.replace(/\/$/, '') || null,
    node: env.CUTTINGFLOOR_NODE ?? (mode === 'local' ? 'local' : hostname()),
    ...(env.CUTTINGFLOOR_TYPESAFE_URL
      ? { typesafeUrl: env.CUTTINGFLOOR_TYPESAFE_URL.replace(/\/$/, '') }
      : {}),
    ...(env.CUTTINGFLOOR_SYNC_URL ? { syncUrl: env.CUTTINGFLOOR_SYNC_URL.replace(/\/$/, '') } : {}),
    ...(mode === 'hosted' && env.CUTTINGFLOOR_KEY_SECRET ? { keysUrl: `${account}#keys` } : {}),
    // The site's upload page: files only (the account page also sells credits).
    ...(mode === 'hosted' ? { uploadPage: new URL('/upload', account).href } : {}),
    ...(mode === 'local' && env.CUTTINGFLOOR_MEDIA_HOST_PATH
      ? { mediaHostPath: env.CUTTINGFLOOR_MEDIA_HOST_PATH }
      : {}),
    ...(env.CUTTINGFLOOR_URL_SECRET ? { urlSecret: env.CUTTINGFLOOR_URL_SECRET } : {}),
    ...recordsFromEnv(env),
    ...blobsFromEnv(env),
    ...(env.CUTTINGFLOOR_S3_FILE_RECORDS === '1' ? { s3FileRecords: true } : {}),
    ...(env.CUTTINGFLOOR_STANDBY === '1' ? { standby: true } : {}),
    ...(env.CUTTINGFLOOR_DRAIN === '1' ? { drain: true } : {}),
    ...(env.CUTTINGFLOOR_SOUNDS?.trim() ? { sounds: env.CUTTINGFLOOR_SOUNDS.trim() } : {}),
    ...(env.CUTTINGFLOOR_SOUNDS_FILES?.trim()
      ? { soundFiles: env.CUTTINGFLOOR_SOUNDS_FILES.trim() }
      : {}),
  };
}

/** Process-wide services shared by every per-request server instance. */
export class Runtime {
  readonly config: RuntimeConfig;
  readonly ws: Workspace;
  readonly timelines: TimelineStore;
  readonly media: MediaLibrary;
  /** media.search's picture index of each ready media. */
  readonly indexer: SearchIndexer;
  readonly jobs: JobRunner;
  readonly uploads: Uploads;
  /** Files jobs and previews leave for download. */
  readonly outputs: Outputs;
  /** Whether the server takes new work now (the storage cutover drains it first). */
  readonly drain: Drain;
  /** Downloaded models, kept across restarts (they are checksummed, not user data). */
  readonly modelsDir: string;
  /** Hosted: the download gate (the mark and clean-copy releases); none locally. */
  gate: DownloadGate | undefined;
  /** What sounds.list reads: the library in the record database, or the hosted one. */
  sounds: SoundLibrary;
  #secret: Buffer | undefined;
  #sweeper: NodeJS.Timeout | undefined;
  #reaper: NodeJS.Timeout | undefined;
  #calls: Promise<void> = Promise.resolve();
  #onMetered = new Set<(owner: string, entry: MeterEntry, job?: Job) => void>();
  #onToolCall = new Set<(owner: string, entry: CallEntry) => void>();

  constructor(config: RuntimeConfig) {
    if (config.s3 && !config.records && !config.s3FileRecords) {
      throw new Error(
        'CUTTINGFLOOR_BLOBS=s3 needs CUTTINGFLOOR_RECORDS=mongo: a bucket is shared by servers, which share records only in MongoDB (CUTTINGFLOOR_S3_FILE_RECORDS=1 allows files for development and tests)',
      );
    }
    this.config = config;
    // On the filesystem a blob's direct link is the server's own signed link to it, for the
    // outputs it serves; nothing else is downloaded.
    this.ws = new Workspace(config.dataDir, {
      ...(config.records
        ? {
            records: new MongoRecords({
              uri: config.records.uri,
              db: config.records.db,
              ...(config.node ? { node: config.node } : {}),
            }),
          }
        : {}),
      ...(config.s3 ? { s3: config.s3 } : {}),
      presign: async (key) => {
        const m = /^owners\/([A-Za-z0-9_-]{1,64})\/outputs\/((?:j|f)_[0-9a-z]{26})\/([^/]+)$/.exec(
          key,
        );
        return m ? (await this.signOutput(m[1] ?? '', m[2] ?? '', m[3] ?? '')).url : undefined;
      },
    });
    this.modelsDir = config.modelsDir ?? join(config.dataDir, 'models');
    this.gate = undefined;
    const sounds = config.sounds ?? (config.records ? 'mongo' : HOSTED_SOUNDS);
    if (sounds === 'mongo') {
      const records = this.ws.records;
      if (!(records instanceof MongoRecords)) {
        throw new Error('CUTTINGFLOOR_SOUNDS=mongo needs CUTTINGFLOOR_RECORDS=mongo');
      }
      this.sounds = new MongoSoundLibrary({
        db: () => records.database(),
        embed: clapTexts,
        model: CLAP_MODEL,
      });
    } else {
      if (!/^https?:\/\/./.test(sounds)) {
        throw new Error('CUTTINGFLOOR_SOUNDS must be mongo or an http(s) url');
      }
      this.sounds = new RemoteSoundLibrary(sounds);
    }
    this.timelines = new TimelineStore(this.ws);
    this.outputs = new Outputs(this.ws);
    this.media = new MediaLibrary(this.ws, {
      roots: config.mediaRoots,
      maxDownloadBytes: config.maxDownloadBytes,
      downloadTimeoutMs: 30 * 60_000,
      allowPrivateUrls: config.allowPrivateUrls,
      ...(config.mediaHostPath ? { hostFolders: { '/media/videos': config.mediaHostPath } } : {}),
      ...(config.uploadPage ? { uploadPage: config.uploadPage } : {}),
      onReady: (owner, record) => this.indexer.enqueue(owner, record.media_id),
    });
    this.indexer = new SearchIndexer(this.media);
    if (config.maxRenders) setRenderLimit(config.maxRenders);
    this.jobs = new JobRunner(new FileJobStore(this.ws), config.maxJobs, {
      ...(config.node ? { node: config.node } : {}),
      ...(config.heavyJobs ? { heavy: config.heavyJobs } : {}),
      ...(config.stallSeconds ? { stallMs: config.stallSeconds * 1000 } : {}),
      ...(config.shortJobs !== undefined ? { shortSlots: config.shortJobs } : {}),
      ...(config.shortJobSeconds !== undefined ? { shortSeconds: config.shortJobSeconds } : {}),
      onEnd: (job) => {
        this.logCall(job.owner, jobEnd(job));
        void meterJob(this.ws, job).then(
          (entry) => {
            if (entry) for (const listener of this.#onMetered) listener(job.owner, entry, job);
          },
          (error: Error) => process.stderr.write(`meter: ${job.id}: ${error.message}\n`),
        );
      },
      // A job whose render waits for a slot says so, and where it stands.
      // Every local copy a job is handed stays on this node's disk until the job ends.
      around: (ctx, work) =>
        this.ws.scratch.hold(() =>
          watchRenderQueue(
            {
              // Waiting for a render slot is not a stall.
              queued: (ahead) => {
                ctx.waiting(true);
                ctx.status(
                  `waiting for a render slot: ${ahead === 0 ? 'next in line' : `${ahead} ahead`} (${renderLoad().limit} renders run at once on this server)`,
                );
              },
              started: () => {
                ctx.waiting(false);
                ctx.status('rendering');
              },
            },
            work,
          ),
        ),
    });
    // Uploads take files as big as URL imports may download.
    this.drain = new Drain({
      dataDir: this.ws.root,
      forced: Boolean(config.drain),
      node: config.node ?? 'local',
      running: async () =>
        (await this.jobs.store.working()).filter(
          (j) => (j.node ?? this.config.node) === this.config.node,
        ).length,
    });
    this.uploads = new Uploads(this.ws, {
      secret: () => this.secret(),
      publicUrl: () => this.config.publicUrl,
      maxBytes: config.maxDownloadBytes,
      ...(config.uploadPage ? { uploadPage: config.uploadPage } : {}),
    });
  }

  /**
   * Loads the signing secret, recovers interrupted jobs and starts the hourly TTL sweep. Cached
   * frames go: a timeline id names the edit, not the renderer, so frames an older build drew
   * would otherwise outlive a fix to how they are drawn.
   */
  async start(options: { sweep?: boolean } = {}): Promise<void> {
    await this.ws.records.ready();
    await this.ws.blobs.ready();
    await this.secret();
    await this.ws.blobs.deletePrefix(this.ws.blobs.keys.cache('frames'));
    this.drain.start();
    // Whether a server serves on this record store, which a storage migration refuses to write.
    await markLive(this.ws.records, {
      standby: Boolean(this.config.standby),
      node: this.config.node ?? 'local',
      filesystem: this.ws.recordsWithFiles,
    });
    if (this.config.standby) return;
    await this.jobs.recover();
    if (options.sweep !== false) {
      await this.#sweepTurn();
      this.#sweeper = setInterval(() => void this.#sweepTurn().catch(() => undefined), 3_600_000);
      this.#sweeper.unref();
      // Jobs whose server died, wherever they ran, end interrupted within a few minutes.
      this.#reaper = setInterval(
        () =>
          void this.ws.records
            .leader('job-reaper')
            .then((mine) => (mine ? this.jobs.recover({ startup: false }) : 0))
            .catch(() => undefined),
        60_000,
      );
      this.#reaper.unref();
    }
  }

  /**
   * The hourly sweep, by the one server whose turn it is among those sharing the record store;
   * the others only clear their own cached frames.
   */
  async #sweepTurn(): Promise<void> {
    if (await this.ws.records.leader('sweep')) return this.sweep();
    await this.#sweepCache();
  }

  /** What only this server holds: frames it cached. */
  async #sweepCache(): Promise<void> {
    const { blobs } = this.ws;
    await blobs.expire(blobs.keys.cache('frames'), 24 * 3_600_000);
  }

  /**
   * Tells `listener` about each job this server meters, once its time is recorded, and each
   * call's judgments (no job: judge.ask; or a judging job's, under their own id).
   */
  onMetered(listener: (owner: string, entry: MeterEntry, job?: Job) => void): () => void {
    this.#onMetered.add(listener);
    return () => this.#onMetered.delete(listener);
  }

  /** Records judgments an owner asked of Jev, billed with their jobs. */
  async meterJudgments(owner: string, id: string, tool: string, judgments: number): Promise<void> {
    if (!(judgments > 0)) return;
    const entry = await meterJudgments(this.ws, owner, id, tool, judgments);
    for (const listener of this.#onMetered) listener(owner, entry);
  }

  /** Tells `listener` about each tool call this server answers (not job ends), as it is logged. */
  onToolCall(listener: (owner: string, entry: CallEntry) => void): () => void {
    this.#onToolCall.add(listener);
    return () => this.#onToolCall.delete(listener);
  }

  /** Adds a line to the owner's call log (calls.ts); a failed write never fails the call. */
  logCall(owner: string, entry: CallEntry): void {
    if (entry.ms !== undefined) for (const listener of this.#onToolCall) listener(owner, entry);
    // One write at a time, so lines land in the order the calls ended.
    this.#calls = this.#calls
      .then(() => recordCall(this.ws, this.config.node ?? 'local', owner, entry))
      .catch((error: Error) => void process.stderr.write(`calls: ${error.message}\n`));
  }

  stop(): void {
    this.drain.stop();
    if (this.#sweeper) clearInterval(this.#sweeper);
    if (this.#reaper) clearInterval(this.#reaper);
  }

  /**
   * Stops, and lets go of the record store's leases and connections. With `withinMs` it answers
   * by then whatever the store does (a database out of reach makes letting go wait), so a
   * shutdown is never held up by it; the leases then run out by themselves.
   */
  async close(withinMs?: number): Promise<void> {
    this.stop();
    const closed = Promise.all([
      this.ws.records.close().catch(() => undefined),
      this.ws.blobs.close().catch(() => undefined),
    ]).then(() => undefined);
    if (withinMs === undefined) return closed;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, withinMs);
      }),
    ]);
    clearTimeout(timer);
  }

  async sweep(): Promise<void> {
    await this.timelines.sweep();
    await this.media.sweep(MEDIA_TTL_MS);
    await this.jobs.store.sweep();
    // Frames kept for download (render.frames urls) last as long as their links.
    const { records, blobs } = this.ws;
    for (const owner of await records.owners()) {
      await this.outputs.forget(
        owner,
        await blobs.expire(
          blobs.keys.outputs(owner),
          this.config.outputUrlTtlMs,
          (name) => !name.startsWith('f_'),
        ),
      );
      // And any record whose output went some other way (the job sweep above, an older server).
      await this.outputs.prune(owner);
    }
    await this.uploads.sweep({
      media: async (owner) => new Set((await this.media.holders(owner)).held.keys()),
    });
    for (const owner of await records.owners()) {
      await records.collection(LEGACY_USAGE, { owner }).expire(2 * 24 * 3_600_000);
      await records.expireParents(METER, { owner }, METER_TTL_MS);
      await records.log(CALLS, { owner }).expire(CALLS_TTL_MS);
      await records.collection(DOWNLOADS, { owner }).expire(FUNNEL_TTL_MS);
      // A release outlives its file (made again, it is a new export), kept like the downloads.
      await records.collection(RELEASES, { owner }).expire(FUNNEL_TTL_MS);
    }
    await this.#sweepCache();
    // Hosted sign-in steps (apps/hosted funnel.ts), one folder per day.
    await records.expireParents(FUNNEL_DAYS, {}, FUNNEL_TTL_MS);
    await this.sweepOrphans();
  }

  /**
   * Where files are in an object store, what holds a file is counted apart from the file, and a
   * crash between the two leaves one without the other. Puts that right for every owner: see
   * `BlobStore.orphans`. Nothing to do on the filesystem.
   */
  async sweepOrphans(graceMs = ORPHAN_GRACE_MS): Promise<void> {
    const { records, blobs } = this.ws;
    if (!blobs.orphans) return;
    for (const owner of await records.owners()) {
      try {
        // Uploads before media: an import saves its media, then lets go of its upload, so one
        // between the two reads is seen at least once.
        const holders = async () => {
          const uploads = await this.uploads.held(owner);
          const found = await this.media.holders(owner);
          for (const { key, taken } of uploads) {
            // Claimed by a media that names it: counted once, as that media's.
            if (taken && found.held.has(key)) continue;
            found.held.set(key, (found.held.get(key) ?? 0) + 1);
          }
          return found;
        };
        const report = await blobs.orphans(owner, holders, graceMs);
        if (report.records || report.objects || report.refs || report.marked) {
          process.stderr.write(
            `blobs: orphan sweep for ${owner}: ${report.objects} files and ${report.records} records removed, ${report.refs} holder counts set, ${report.marked ?? 0} files marked to check again\n`,
          );
        }
      } catch (error) {
        // One owner's trouble never stops the sweep.
        process.stderr.write(`blobs: orphan sweep for ${owner}: ${(error as Error).message}\n`);
      }
    }
  }

  async secret(): Promise<Buffer> {
    if (this.#secret) return this.#secret;
    if (this.config.urlSecret) {
      this.#secret = urlSecretKey(this.config.urlSecret);
      return this.#secret;
    }
    const file = this.ws.path('secret.key');
    await this.ws.writeJson(file, { key: randomBytes(32).toString('base64') }, { exclusive: true });
    const { key } = JSON.parse(await readFile(file, 'utf8')) as { key: string };
    this.#secret = Buffer.from(key, 'base64');
    return this.#secret;
  }

  /** Turns on the download gate with the hosting app's plans and credits. */
  useGate(hooks: GateHooks, options: { from?: string } = {}): DownloadGate {
    this.gate = new DownloadGate(this, hooks, options);
    return this.gate;
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
    return this.#markState(await this.#freshLinks(value));
  }

  /**
   * A finished job (or a list of them) with its file's mark state as it is now: a release after
   * the job ended clears `watermarked` from what reading it gives.
   */
  async #markState<T>(value: T): Promise<T> {
    const gate = this.gate;
    if (!gate || value === undefined || value === null) return value;
    // One balance read per owner for the whole answer, however many jobs it lists.
    const balances = new Map<string, Promise<number | null | undefined>>();
    for (const job of (Array.isArray(value) ? value : [value]) as Array<Partial<Job>>) {
      const out = job?.result?.structuredContent as Record<string, unknown> | undefined;
      if (!job?.id || !job.owner || !out || typeof out.url !== 'string') continue;
      const owner = job.owner;
      const readCredits = () => {
        if (!balances.has(owner)) balances.set(owner, gate.credits(owner));
        return balances.get(owner) as Promise<number | null | undefined>;
      };
      const state = await gate.described(owner, job.id, readCredits).catch(() => undefined);
      if (!state) continue;
      out.watermarked = state.watermarked;
      for (const key of ['release_credits', 'credits_left', 'watermark_note'] as const) {
        if (state[key] !== undefined) out[key] = state[key];
        else delete out[key];
      }
    }
    return value;
  }

  async #freshLinks<T>(value: T): Promise<T> {
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
    const target = await this.outputTarget(pathname, exp, sig);
    if (!target) return undefined;
    return target.file ?? (target.blob ? this.ws.scratch.materialize(target.blob) : undefined);
  }

  /**
   * Checks a signed output URL and names what it is a link to, without fetching it: the blob,
   * or the local file of a path import. Undefined when invalid or expired.
   */
  async outputTarget(
    pathname: string,
    exp: string | null,
    sig: string | null,
  ): Promise<OutputTarget | undefined> {
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
      if (!record?.file) return undefined;
      return isAbsolute(record.file) ? { name, file: record.file } : { name, blob: record.file };
    }
    return { name, blob: this.outputs.key(key, id, name) };
  }

  /** A blob as a local file on this server, for an engine (or a hash) to read. */
  scratchFile(blob: BlobKey): Promise<string> {
    return this.ws.scratch.materialize(blob);
  }

  /**
   * A link straight to a blob in the bucket, for a download (`attachment`, under its name) or
   * to play in a page (`inline`). Undefined where files are served by this server itself.
   */
  async bucketLink(
    blob: BlobKey,
    name: string,
    type: string,
    how: 'attachment' | 'inline' = 'attachment',
  ): Promise<string | undefined> {
    if (!this.ws.blobs.remote) return undefined;
    const plain = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return this.ws.blobs.presignGet(blob, {
      ttlMs: BUCKET_LINK_TTL_MS,
      disposition:
        how === 'inline'
          ? 'inline'
          : `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      type,
    });
  }

  /** The origin files in the bucket are fetched from, which pages that play them must allow. */
  get bucketOrigin(): string | undefined {
    return (this.ws.blobs as { origin?: string }).origin;
  }
}
