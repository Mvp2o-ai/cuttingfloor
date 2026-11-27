import { randomBytes } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, sep } from 'node:path';
import {
  type BlobKey,
  type BlobStore,
  type Collection,
  defineCollection,
  FLOOR,
  floorChanged,
  isExisting,
  isMissing,
  ownerKey,
  randomId,
  secondsToTicks,
  type Workspace,
} from '@cuttingfloor/core';
import {
  type ANALYSES,
  CfError,
  expiry,
  KEEP_MS,
  KEEP_THEN,
  type MediaGetResult,
  type MediaInfo,
  type MediaOrigin,
  type MediaRef,
  mediaNotReady,
  type ToolError,
} from '@cuttingfloor/schema';
import { createBLAKE3 } from 'hash-wasm';
import { BIN, run } from './exec.ts';
import { directDownloadUrl, download } from './fetch.ts';
import { conformReasons, type Probe, probe } from './probe.ts';
import { wordSpeakers } from './speakers.ts';
import { LOUDNESS_STATS, parseChannelLevels } from './speech.ts';
import { unwrapWebFont } from './webfont.ts';

export const MEDIA_TTL_MS = KEEP_MS.media;

/** How long the server remembers why a media is gone (deleted or expired). */
const GONE_DAYS = 30;

export interface MediaRecord {
  media_id: string;
  name: string;
  status: 'importing' | 'processing' | 'ready' | 'failed';
  /** Where it came from: a path, a URL, an upload, a render, or a create.* tool and its recipe. */
  source:
    | { path: string }
    | { url: string; attached?: boolean }
    | { upload: string; file_name?: string; via?: 'media.upload' | 'account_page' | 'data_uri' }
    | {
        job: string;
        timeline_id?: string;
        preset?: string;
        range?: { start: number; end: number };
        /** Where each stretch of the render comes from (see MediaOrigin.sources). */
        sources?: NonNullable<MediaOrigin['sources']>;
      }
    | { created: string; recipe: string; job_id?: string; from?: string[] }
    | { still: number; media_id?: string; timeline_id?: string };
  /**
   * The original: the blob the server holds (a downloaded, sent or created file), or, for a path
   * import, the user's own file in place as an absolute path. `MediaLibrary.local` gives the
   * local file of either.
   */
  file: BlobKey | string | null;
  size: number | null;
  fingerprint: string | null;
  probe: Probe | null;
  conform: string[];
  /** The conformed copy's blob. */
  mezzanine: BlobKey | null;
  /** The proxy's blob. */
  proxy: BlobKey | null;
  analysis: MediaInfo['analysis'];
  /** media.analyze results, kept with the media. */
  analyses?: {
    transcript?: NonNullable<MediaInfo['transcript']>;
    beats?: NonNullable<MediaInfo['beats']>;
    faces?: NonNullable<MediaInfo['faces']>;
    look?: NonNullable<MediaInfo['look']>;
    speech?: NonNullable<MediaInfo['speech']>;
    sounds?: NonNullable<MediaInfo['sounds']>;
    speakers?: NonNullable<MediaGetResult['speakers']>;
    voice?: NonNullable<MediaGetResult['voice']>;
    colour?: NonNullable<MediaGetResult['colour']>;
    picture?: NonNullable<MediaGetResult['picture']>;
  };
  /** The media.import job that ingests it (a create.* job is in source). */
  job_id?: string;
  /** create.motion and create.still: what went wrong in the page as it rendered. */
  warnings?: string[];
  error?: ToolError;
  created_at: string;
  updated_at: string;
}

type LookRun = NonNullable<MediaInfo['look']>['runs'][number];

/** The analyses kept with a media, one file each (look: one per run). */
export type StoredAnalysis = (typeof ANALYSES)[number];

/** Look runs kept with each media. */
export const LOOK_RUNS_KEPT = 10;

export interface MediaConfig {
  /** Folders path imports may read from (realpath-checked). Empty disables path imports. */
  roots: string[];
  maxDownloadBytes: number;
  downloadTimeoutMs: number;
  allowPrivateUrls: boolean;
  /** Local mode: which folder on the user's machine a media root is, for hints. */
  hostFolders?: Record<string, string>;
  /** Hosted: the account page's file drop, named in hints for the user's own files. */
  uploadPage?: string;
  /** Told of each media as it becomes ready (imported, created or shared), never awaited. */
  onReady?: (owner: string, record: MediaRecord) => void;
}

export type Progress = (fraction: number, message: string) => void;

/** A media's record: `owners/{owner}/media/{media_id}/media.json` on the filesystem. */
export const MEDIA = defineCollection<MediaRecord>({
  name: 'media',
  scope: 'owner',
  fs: { dir: 'media', leaf: 'media.json' },
  blobs: ['file', 'mezzanine', 'proxy'],
  db: { indexes: [['fingerprint']] },
});

/** Which media holds given bytes (by fingerprint) or was made from a recipe (`recipe-…`). */
export const MEDIA_INDEX = defineCollection<{ media_id: string }>({
  name: 'media_index',
  scope: 'owner',
  fs: { dir: 'media-index' },
});

/** Why a media is gone, so a later lookup can say so. */
export const MEDIA_GONE = defineCollection<{ reason: 'deleted' | 'expired'; at: string }>({
  name: 'gone',
  kind: 'media',
  scope: 'owner',
  fs: { dir: 'media-gone' },
  db: { ttlMs: GONE_DAYS * 86_400_000 },
});

const MEDIA_ID = /^m_[0-9a-z]{26}$/;

/** Whether a record's file is a blob the server holds, not the user's own file in place. */
function isBlob(ref: string | null): ref is BlobKey {
  return !!ref && !isAbsolute(ref);
}

/** Imported media for each owner: records plus mezzanines and proxies, kept 7 days after last use. */
export class MediaLibrary {
  readonly #ws: Workspace;
  readonly config: MediaConfig;

  constructor(ws: Workspace, config: MediaConfig) {
    this.#ws = ws;
    this.config = config;
  }

  /** The media id, checked. */
  #id(id: string): string {
    if (!MEDIA_ID.test(id)) throw new CfError('bad_request', `Not a media id: ${id}`);
    return id;
  }

  #records(owner: string): Collection<MediaRecord> {
    return this.#ws.records.collection(MEDIA, { owner });
  }

  /**
   * A media's analyses (transcript, beats, each look run): files beside the media, one a kind,
   * in whichever store the media's files are (`owners/{owner}/media/{id}/analyses/{name}.json`
   * on the filesystem, the JSON they always held). They are read whole and can be large, so
   * they are not records; they go with the media's files when it is deleted or expires, and
   * count as its storage. One can be written again, so nothing keeps one by its key alone.
   */
  #analyses(owner: string, id: string) {
    const { blobs } = this.#ws;
    const folder = blobs.keys.derived(owner, this.#id(id), 'analyses');
    const key = (name: string): BlobKey => {
      if (!name || /[/\\\0]/.test(name) || name.startsWith('.')) {
        throw new Error(`Not an analysis name: ${name}`);
      }
      return `${folder}/${name}.json`;
    };
    /**
     * Whole or not at all: written beside its place and stored for good, then moved into it.
     * `once` moves it in only when the place is free, and says whether it did.
     */
    const write = async (name: string, value: unknown, once = false): Promise<boolean> => {
      const to = key(name);
      const temp = `${to}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      await blobs.put(
        temp,
        { bytes: body },
        { private: true, durable: true, type: 'application/json' },
      );
      try {
        await blobs.move(temp, to, { ifAbsent: once });
        return true;
      } catch (error) {
        await blobs.delete(temp).catch(() => undefined);
        if (once && isExisting(error)) return false;
        throw error;
      }
    };
    return {
      /** The names there are, in no order. */
      ids: async (): Promise<string[]> =>
        (await blobs.list(folder))
          .map((head) => head.key.slice(folder.length + 1))
          .filter((file) => file.endsWith('.json') && !file.includes('/') && !file.startsWith('.'))
          .map((file) => file.slice(0, -'.json'.length)),
      get: async (name: string): Promise<unknown> => {
        let stream: Awaited<ReturnType<typeof blobs.get>>;
        try {
          stream = await blobs.get(key(name));
        } catch (error) {
          if (isMissing(error)) return undefined;
          throw error;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      },
      put: async (name: string, value: unknown): Promise<void> => {
        await write(name, value);
      },
      /** Written only when there is none of this name: of writers at once, one writes. */
      insertOnce: (name: string, value: unknown): Promise<boolean> => write(name, value, true),
      delete: (name: string) => blobs.delete(key(name)),
    };
  }

  #index(owner: string): Collection<{ media_id: string }> {
    return this.#ws.records.collection(MEDIA_INDEX, { owner });
  }

  /** The key of one of the media's own files (source, mezzanine, proxy). */
  #key(owner: string, id: string, name: string): BlobKey {
    return this.#ws.blobs.keys.media(owner, this.#id(id), name);
  }

  /** The key every file kept with the media starts with. */
  prefix(owner: string, id: string): BlobKey {
    return this.#ws.blobs.keys.derived(owner, this.#id(id));
  }

  /**
   * The media's folder on this node's filesystem store. Only for code that has not moved to
   * `derivedDir` and `local`, and for tests that lay a record down by hand.
   */
  dir(owner: string, id: string): string {
    return this.#ws.ownerDir(owner, 'media', this.#id(id));
  }

  /**
   * A local folder for a set of files made from the media and found again by name (`cleaned`,
   * `between`, `selected`, `search`). It may not exist yet; whoever writes there makes it.
   */
  derivedDir(owner: string, id: string, ...name: string[]): Promise<string> {
    return this.#ws.scratch.materializeDir(
      this.#ws.blobs.keys.derived(owner, this.#id(id), ...name),
    );
  }

  /**
   * The same folder with only `files` of it brought to this node (none: a folder to write in),
   * for a set whose files are large and made one at a time (`between`, `cleaned`, `selected`):
   * a caller names the one it needs and finds it there when it was made before, on any server.
   * On the filesystem this is `derivedDir`.
   */
  derivedDirWith(owner: string, id: string, name: string[], files: string[]): Promise<string> {
    return this.#ws.scratch.materializeDir(
      this.#ws.blobs.keys.derived(owner, this.#id(id), ...name),
      { only: files },
    );
  }

  /**
   * Stores what an engine wrote in a derived folder on this node (`files` of it, or all that is
   * new or changed), so another server finds it. Nothing to do on the filesystem, where the
   * folder is the store.
   */
  async keepDerived(owner: string, id: string, name: string[], files?: string[]): Promise<void> {
    const prefix = this.#ws.blobs.keys.derived(owner, this.#id(id), ...name);
    await this.#ws.scratch.publishDir(
      await this.#ws.scratch.materializeDir(prefix, { only: [] }),
      prefix,
      files ? { only: files } : {},
    );
  }

  /** Removes every file kept with a media, whether or not it still has a record. */
  async discard(owner: string, id: string): Promise<void> {
    await this.#ws.blobs.deletePrefix(this.prefix(owner, id));
  }

  /** A small file kept beside a set of derived files (a note that making them failed). */
  async readDerived(owner: string, id: string, ...name: string[]): Promise<string | undefined> {
    try {
      const chunks: Buffer[] = [];
      const key = this.#ws.blobs.keys.derived(owner, this.#id(id), ...name);
      for await (const chunk of await this.#ws.blobs.get(key)) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    } catch {
      return undefined;
    }
  }

  async writeDerived(owner: string, id: string, text: string, ...name: string[]): Promise<void> {
    await this.#ws.blobs.put(this.#ws.blobs.keys.derived(owner, this.#id(id), ...name), {
      bytes: Buffer.from(text),
    });
  }

  async deleteDerived(owner: string, id: string, ...name: string[]): Promise<void> {
    await this.#ws.blobs.delete(this.#ws.blobs.keys.derived(owner, this.#id(id), ...name));
  }

  /**
   * Where media.search's index of the media's picture is kept on the filesystem store (tests
   * read it); the server takes it from `derivedDir(owner, id, 'search')`.
   */
  searchDir(owner: string, id: string): string {
    return join(this.dir(owner, id), 'search');
  }

  /**
   * Makes a file an engine wrote on this node (in the media's `derivedDir`) one of the media's
   * own, under the name it was written with. Returns what the record keeps.
   */
  async own(owner: string, id: string, localPath: string): Promise<BlobKey> {
    return this.#ws.scratch.publish(localPath, this.#key(owner, id, basename(localPath)));
  }

  /** The local file of a record's `file`, `mezzanine` or `proxy`, for an engine to read. */
  async local(ref: string): Promise<string> {
    return isBlob(ref) ? this.#ws.scratch.materialize(ref) : ref;
  }

  /** The local file a render reads for this media (see sourceRef). */
  async sourceFile(record: MediaRecord, purpose: 'preview' | 'export'): Promise<string> {
    return this.local(sourceRef(record, purpose));
  }

  /** The picture a render reads for this media, with what the compositor needs to know about it. */
  async picture(
    record: MediaRecord,
    purpose: 'preview' | 'export',
  ): Promise<{
    path: string;
    image: boolean;
    width: number | null;
    height: number | null;
    alpha: boolean;
    family?: string;
  }> {
    const p = record.probe;
    const v = p?.video;
    const upright = v ? v.rotation % 180 === 0 : true;
    return {
      path: await this.sourceFile(record, purpose),
      image: p?.kind === 'image',
      width: v ? (upright ? v.width : v.height) : null,
      height: v ? (upright ? v.height : v.width) : null,
      alpha: p ? hasAlpha(p) : false,
      ...(p?.family ? { family: p.family } : {}),
    };
  }

  /** Whether the file a record names is still there. */
  async #held(ref: string): Promise<boolean> {
    if (isBlob(ref)) return (await this.#ws.blobs.head(ref)) !== undefined;
    return exists(ref);
  }

  /**
   * A record as kept before files had keys named its files by their absolute path under the
   * data root: those become the keys of the same files. A path import's original stays a path.
   */
  #keyed(record: MediaRecord): MediaRecord {
    for (const field of ['file', 'mezzanine', 'proxy'] as const) {
      const ref = record[field];
      if (!ref || isBlob(ref)) continue;
      const key = this.#ws.scratch.keyOf(ref);
      if (key) record[field] = key;
    }
    return record;
  }

  async get(owner: string, id: string): Promise<MediaRecord> {
    const record = await this.find(owner, id);
    if (!record) throw await this.missing(owner, id);
    return record;
  }

  /** Why the owner has no such media: deleted, expired, another account's, or never here. */
  async missing(owner: string, id: string): Promise<CfError> {
    const again = 'import the file again with media.import (a saved copy, or its source)';
    const gone = MEDIA_ID.test(id)
      ? await this.#ws.records.collection(MEDIA_GONE, { owner }).get(id)
      : undefined;
    if (gone?.reason === 'deleted') {
      return new CfError('not_found', `Media ${id} was deleted with media.delete at ${gone.at}`, {
        hint: `It can't come back; ${again}`,
        detail: { media_id: id, reason: 'deleted', at: gone.at },
      });
    }
    if (gone?.reason === 'expired') {
      return new CfError(
        'not_found',
        `Media ${id} expired at ${gone.at}, 7 days after its last use`,
        {
          hint: `Use keeps media: to carry on, ${again}`,
          detail: { media_id: id, reason: 'expired', at: gone.at },
        },
      );
    }
    const own = ownerKey(owner);
    if (MEDIA_ID.test(id)) {
      for (const key of await this.#ws.records.owners()) {
        if (key === own) continue;
        if (await this.#records(key).has(id)) {
          return new CfError('not_found', `Media ${id} belongs to another account`, {
            hint: "Media is kept per account; this one can't use it. Import the file into this account with media.import",
            detail: { media_id: id, reason: 'other_owner' },
          });
        }
      }
    }
    return new CfError('not_found', `No media ${id}`, {
      hint: `Not an id this server has had in the last ${GONE_DAYS} days, or a typo: media.list shows what is held. Media expires 7 days after last use; ${again}`,
      detail: { media_id: id, reason: 'unknown' },
    });
  }

  /** Remembers why a media is gone, so a later lookup can say so. */
  async #tombstone(owner: string, id: string, reason: 'deleted' | 'expired'): Promise<void> {
    await this.#ws.records
      .collection(MEDIA_GONE, { owner })
      .put(id, { reason, at: new Date().toISOString() });
  }

  async find(owner: string, id: string): Promise<MediaRecord | undefined> {
    const stored = await this.#records(owner).get(this.#id(id), { touch: true });
    if (!stored) return undefined;
    const record = this.#keyed(stored);
    // Each analysis is its own file, so analyses running on different servers never overwrite
    // each other. A record from before that kept them inline: move them out once.
    const kept = this.#analyses(owner, id);
    if (record.analyses) {
      const { look, ...rest } = record.analyses;
      for (const [kind, value] of Object.entries(rest)) await kept.insertOnce(kind, value);
      for (const [i, run] of (look?.runs ?? []).entries()) {
        await kept.insertOnce(`look-${String(i).padStart(14, '0')}-${run.id}`, run);
      }
      delete record.analyses;
      await this.save(owner, record);
    }
    // In the order their files sort, which is the order look runs were made.
    const names = (await kept.ids()).sort((a, b) => (`${a}.json` < `${b}.json` ? -1 : 1));
    const analyses: NonNullable<MediaRecord['analyses']> = {};
    const runs: LookRun[] = [];
    for (const name of names) {
      const value = (await kept.get(name)) as never;
      if (!value) continue;
      if (name.startsWith('look-')) runs.push(value);
      else analyses[name as Exclude<StoredAnalysis, 'look'>] = value;
    }
    if (runs.length) analyses.look = { runs: runs.slice(-LOOK_RUNS_KEPT) };
    if (Object.keys(analyses).length) record.analyses = analyses;
    return record;
  }

  /** Whether the owner still holds this media. Doesn't count as a use. */
  async exists(owner: string, id: string): Promise<boolean> {
    if (!MEDIA_ID.test(id)) return false;
    return this.#records(owner).has(id);
  }

  /** The record itself; analyses are written apart, with saveAnalysis. */
  async save(owner: string, record: MediaRecord): Promise<void> {
    record.updated_at = new Date().toISOString();
    const { analyses: _kept, ...rest } = record;
    await this.#records(owner).put(this.#id(record.media_id), rest as MediaRecord);
    await floorChanged(this.#ws, owner);
  }

  /**
   * Stores one analysis beside the record. transcript, beats and faces replace the last of their
   * kind; each look run is a new file, named so they sort by time, and only the newest are kept.
   */
  async saveAnalysis(
    owner: string,
    id: string,
    kind: StoredAnalysis,
    value: unknown,
  ): Promise<MediaRecord> {
    const kept = this.#analyses(owner, id);
    if (kind === 'look') {
      const run = value as LookRun;
      await kept.insertOnce(`look-${Date.now().toString().padStart(14, '0')}-${run.id}`, run);
      const looks = (await kept.ids()).filter((n) => n.startsWith('look-')).sort();
      for (const old of looks.slice(0, -LOOK_RUNS_KEPT)) await kept.delete(old);
    } else {
      await kept.put(kind, value);
    }
    return this.get(owner, id);
  }

  /** Checks a path import against the media roots and returns its real path. */
  async resolvePath(path: string): Promise<string> {
    if (!this.config.roots.length) {
      throw new CfError('path_not_allowed', 'Path imports are not available on this server', {
        hint: `This server imports URLs, staged files and data: URIs. ${this.#fromUser()}`,
      });
    }
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw new CfError('not_found', `No file at ${path}`, {
        hint: `The server sees only ${this.config.roots.join(', ')}.${Object.entries(
          this.config.hostFolders ?? {},
        )
          .map(([inside, host]) => ` ${inside} is ${host} on the user's machine.`)
          .join(
            '',
          )} To recreate a reference, no import is needed: rebuild it with create.motion or create.still. For the user's own footage, use a path there (copy the file into that folder first) or an http(s) URL`,
      });
    }
    for (const root of this.config.roots) {
      let realRoot: string;
      try {
        realRoot = await realpath(root);
      } catch {
        continue;
      }
      if (
        real === realRoot ||
        real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
      ) {
        const s = await stat(real);
        if (!s.isFile()) throw new CfError('bad_request', `${path} is not a file`);
        return real;
      }
    }
    throw new CfError('path_not_allowed', `${path} is outside the media roots`, {
      hint: `Paths must be under ${this.config.roots.join(', ')}. ${this.#fromUser()}`,
    });
  }

  /** How a file on the user's phone or computer gets here, for hints. */
  #fromUser(): string {
    const page = this.config.uploadPage ? ` or their upload page, ${this.config.uploadPage}` : '';
    return `A file on the user's phone or computer must be staged first (media.upload${page})`;
  }

  /**
   * Makes a file the server holds a new record's own: a rendered export is copied (it expires
   * on its own clock), an upload is moved. `from` is a blob, or a local file on this node.
   * Returns what the record keeps as its `file`.
   */
  async adopt(
    owner: string,
    record: MediaRecord,
    from: { blob: BlobKey } | { file: string },
    options: { move?: boolean } = {},
  ): Promise<BlobKey> {
    const name = 'blob' in from ? from.blob : from.file;
    const key = this.#key(
      owner,
      record.media_id,
      `source${extname(name)
        .slice(0, 8)
        .replace(/[^.\w]/g, '')}`,
    );
    if ('file' in from) {
      await this.#ws.blobs.put(key, { file: from.file, ...(options.move ? { move: true } : {}) });
      return key;
    }
    if (options.move) {
      // An object store never moves a blob: the upload's object is the media's source as it is.
      return this.#ws.blobs.remote ? from.blob : this.#ws.blobs.move(from.blob, key);
    }
    await this.#ws.blobs.copy(from.blob, key);
    return key;
  }

  /** Runs `work` with every local copy it is handed kept on this node until it ends. */
  hold<T>(work: () => Promise<T>): Promise<T> {
    return this.#ws.scratch.hold(work);
  }

  /** An existing usable import of the same content, for dedupe. */
  async findByFingerprint(owner: string, fingerprint: string): Promise<MediaRecord | undefined> {
    const index = await this.#index(owner).get(fingerprint);
    if (!index) return undefined;
    const record = await this.find(owner, index.media_id);
    return record && record.status !== 'failed' && (!record.file || (await this.#held(record.file)))
      ? record
      : undefined;
  }

  /** Created media made from the same recipe, while it lives. */
  async findByRecipe(owner: string, recipe: string): Promise<MediaRecord | undefined> {
    return this.findByFingerprint(owner, `recipe-${recipe}`);
  }

  async rememberRecipe(owner: string, recipe: string, mediaId: string): Promise<void> {
    await this.#index(owner).put(`recipe-${recipe}`, { media_id: mediaId });
  }

  /** Creates the record a new import fills in. */
  async create(
    owner: string,
    source: MediaRecord['source'],
    name: string | undefined,
    /** The id to give it, when the caller had to name it first (to claim an upload with). */
    options: { id?: string } = {},
  ): Promise<MediaRecord> {
    const now = new Date().toISOString();
    const record: MediaRecord = {
      media_id: options.id ?? randomId('m_'),
      name:
        name ??
        ('path' in source
          ? basename(source.path)
          : 'url' in source
            ? urlName(source.url)
            : 'job' in source
              ? source.job
              : 'upload' in source
                ? source.upload
                : 'still' in source
                  ? `${source.timeline_id ?? source.media_id}-frame-${source.still}.png`
                  : source.created),
      status: 'importing',
      source,
      file: null,
      size: null,
      fingerprint: null,
      probe: null,
      conform: [],
      mezzanine: null,
      proxy: null,
      analysis: null,
      created_at: now,
      updated_at: now,
    };
    await this.save(owner, record);
    return record;
  }

  /** Runs the import pipeline: download, fingerprint, probe, conform, proxy, analysis. */
  async ingest(
    owner: string,
    record: MediaRecord,
    progress: Progress,
    signal: AbortSignal,
    /** A tighter cap on a download than the server's (the account's storage left), and why. */
    options: { maxBytes?: number; tooBig?: { limit: string; hint: string } } = {},
  ): Promise<MediaRecord> {
    const { blobs, scratch } = this.#ws;
    const own = (name: string) => this.#key(owner, record.media_id, name);
    try {
      if ('url' in record.source) {
        progress(0, 'downloading');
        const ext = extname(new URL(record.source.url).pathname)
          .slice(0, 8)
          .replace(/[^.\w]/g, '');
        const key = own(`source${ext || '.bin'}`);
        const dest = await scratch.reserve(key);
        const direct = directDownloadUrl(record.source.url);
        const got = await download(direct, dest, {
          maxBytes: Math.min(this.config.maxDownloadBytes, options.maxBytes ?? Infinity),
          ...(options.maxBytes !== undefined &&
          options.maxBytes < this.config.maxDownloadBytes &&
          options.tooBig
            ? { tooBig: options.tooBig }
            : {}),
          timeoutMs: this.config.downloadTimeoutMs,
          allowPrivate: this.config.allowPrivateUrls,
          signal,
          onProgress: (bytes, total) =>
            progress(
              total ? 0.3 * (bytes / total) : 0.1,
              `downloading ${(bytes / 1e6).toFixed(1)} MB`,
            ),
        }).catch((error: unknown) => {
          // A video's page, or a share that needs signing in, sends a web page instead of the file.
          if (error instanceof CfError && error.detail?.web_page) {
            throw new CfError(error.code, error.message, {
              detail: error.detail,
              hint: `The server imports only the file itself, never a page about it: a video site's page (YouTube, Vimeo, TikTok, Instagram) or a private share sends a web page. ${this.#fromUser()}; a public link that downloads the file directly also imports`,
            });
          }
          // A link that needs signing in, or one only the chat app can open, fails here.
          if (
            error instanceof CfError &&
            !error.hint &&
            (error.code === 'bad_request' || error.code === 'path_not_allowed')
          ) {
            throw new CfError(error.code, error.message, {
              ...(error.detail ? { detail: error.detail } : {}),
              hint: `The server downloads the URL itself, so it must open without signing in. ${this.#fromUser()}`,
            });
          }
          throw error;
        });
        // A share link's own path names a web page ("view"); the file's name comes with it.
        if (
          direct !== record.source.url &&
          got.filename &&
          record.name === urlName(record.source.url)
        ) {
          record.name = got.filename.slice(0, 200);
        }
        record.file = await scratch.publish(dest, key);
      } else if ('path' in record.source) {
        record.file = await this.resolvePath(record.source.path);
      } else if (!record.file) {
        throw new CfError('engine_error', `Created media ${record.media_id} has no file`);
      }
      let file = await this.local(record.file);
      record.size = (await stat(file)).size;
      record.fingerprint = await fingerprint(file);
      // The same bytes imported before (a URL fetched again, an upload sent twice): share that
      // media's files and facts rather than conform and proxy them again.
      const known = await this.findByFingerprint(owner, record.fingerprint);
      if (known && known.media_id !== record.media_id && known.status === 'ready') {
        return await this.#share(owner, record, known, progress);
      }
      // A web font (WOFF, WOFF2) is used as the TrueType or OpenType font it packs.
      const unpacked = await unwrapWebFont(
        file,
        await scratch.materializeDir(this.prefix(owner, record.media_id)),
      );
      if (unpacked) {
        record.file = await scratch.publish(unpacked, own(basename(unpacked)));
        file = await this.local(record.file);
      }
      progress(0.3, 'probing');
      record.probe = await probe(file, signal);
      // A copy the server holds is named for what it is, whatever name it came with (a PNG sent
      // as .svg, a download with no extension). The user's own file in a media root stays as is.
      const ext = record.probe.extension;
      if (ext && isBlob(record.file) && extname(file).toLowerCase() !== ext) {
        record.file = await blobs.move(record.file, own(`source${ext}`));
        file = await this.local(record.file);
      }
      record.conform = conformReasons(record.probe);
      record.status = 'processing';
      await this.save(owner, record);
      await this.#index(owner).put(record.fingerprint, { media_id: record.media_id });

      const p = record.probe;
      /** The proxy made here, as a local file. */
      let made: string | undefined;
      if (p.kind === 'video' && p.video) {
        let source = file;
        if (record.conform.length) {
          progress(0.35, `conforming (${record.conform.join(', ')})`);
          record.mezzanine = own('mezzanine.mov');
          const mezzanine = await scratch.reserve(record.mezzanine);
          await conform(file, mezzanine, p, signal, (f) =>
            progress(0.35 + 0.35 * f, `conforming ${Math.round(f * 100)}%`),
          );
          await scratch.publish(mezzanine, record.mezzanine);
          source = mezzanine;
          // Edits and exports read the mezzanine, so its length is the media's length.
          const conformed = await probe(mezzanine, signal);
          if (p.duration !== null && conformed.duration !== null) {
            p.duration = Math.min(p.duration, conformed.duration);
          }
          if (p.video && conformed.video) p.video.frames = conformed.video.frames;
          await this.save(owner, record);
        }
        progress(0.7, 'making proxy');
        const proxy = await scratch.reserve(own('proxy.mov'));
        await makeProxy(source, proxy, p, signal, (f) =>
          progress(0.7 + 0.2 * f, `making proxy ${Math.round(f * 100)}%`),
        );
        record.proxy = await scratch.publish(proxy, own('proxy.mov'));
        made = proxy;
        // The proxy decoded all of the file. Where it stops well short of the length the file
        // states (an unfinished download, a cut-off recording), nothing past that can be read:
        // what was read is the media's length.
        const read = await probe(proxy, signal);
        const stated = Math.max(streamSeconds(p, 'video') ?? 0, streamSeconds(p, 'audio') ?? 0);
        if (p.duration !== null && read.duration !== null && read.duration < stated - 1) {
          p.duration = Math.min(p.duration, read.duration);
          if (p.video && read.video) p.video.frames = read.video.frames;
        }
        await this.save(owner, record);
      }
      if (p.kind === 'video' || p.kind === 'audio') {
        progress(0.9, 'analysing');
        record.analysis = await analyse(made ?? file, p, signal);
      }
      record.status = 'ready';
      await this.save(owner, record);
      progress(1, 'ready');
      this.config.onReady?.(owner, record);
      return record;
    } catch (error) {
      await this.fail(owner, record, error);
      throw error;
    }
  }

  /** Marks media failed with what went wrong, so it never waits as importing for a job that ended. */
  async fail(owner: string, record: MediaRecord, error: unknown): Promise<void> {
    record.status = 'failed';
    record.error =
      error instanceof CfError
        ? error.toJSON()
        : { code: 'engine_error', message: (error as Error).message };
    await this.save(owner, record);
  }

  /**
   * Makes a record the same file as `known`, which is ready: its server-held files are hard
   * links to known's (no bytes or encoding twice; either can go on its own) and its analyses
   * copies of known's.
   */
  async #share(
    owner: string,
    record: MediaRecord,
    known: MediaRecord,
    progress: Progress,
  ): Promise<MediaRecord> {
    progress(0.5, `same file as ${known.media_id}, already imported`);
    const { blobs } = this.#ws;
    const mine = `${this.prefix(owner, record.media_id)}/`;
    const theirs = `${this.prefix(owner, known.media_id)}/`;
    // In an object store a media's files are not under its own prefix, and may be another's.
    const held = (ref: string | null): ref is BlobKey =>
      isBlob(ref) && (blobs.remote || ref.startsWith(theirs));
    const shared = (key: BlobKey) =>
      blobs.share(key, this.#key(owner, record.media_id, basename(key)));
    // A downloaded or sent copy gives way to known's; the user's own file in place stays.
    if (
      isBlob(record.file) &&
      (blobs.remote || record.file.startsWith(mine)) &&
      held(known.file) &&
      record.file !== known.file
    ) {
      await blobs.delete(record.file);
      record.file = await shared(known.file);
    }
    record.size = known.size;
    record.probe = known.probe;
    record.conform = known.conform;
    record.mezzanine = held(known.mezzanine) ? await shared(known.mezzanine) : null;
    record.proxy = held(known.proxy) ? await shared(known.proxy) : null;
    record.analysis = known.analysis;
    const from = this.#analyses(owner, known.media_id);
    const to = this.#analyses(owner, record.media_id);
    for (const name of await from.ids()) {
      try {
        // Read and written whole: one that does not parse is not brought along, and a reader
        // of the new media never meets half of one.
        const value = await from.get(name);
        if (value !== undefined) await to.put(name, value);
      } catch {
        // One analysis that can't be read is left behind; the rest come along.
      }
    }
    // Its search index too, when known has one: the same picture indexes the same.
    const search = `${blobs.keys.derived(owner, known.media_id, 'search')}/`;
    for (const { key } of await blobs.list(search)) {
      const name = key.slice(search.length);
      if (name.endsWith('.part') || name.includes('/')) continue;
      await blobs.share(key, blobs.keys.derived(owner, record.media_id, 'search', name));
    }
    record.status = 'ready';
    await this.save(owner, record);
    await this.#index(owner).put(record.fingerprint as string, { media_id: record.media_id });
    progress(1, 'ready');
    this.config.onReady?.(owner, record);
    return record;
  }

  /** Every media the owner has, newest use first, with when each expires. Doesn't count as a use. */
  async list(owner: string): Promise<Array<MediaRecord & { expires_at: string }>> {
    const out: Array<MediaRecord & { expires_at: string; used: number }> = [];
    for (const { value, usedAt } of await this.#records(owner).find()) {
      const used = usedAt.getTime();
      out.push({
        ...this.#keyed(value),
        used,
        expires_at: new Date(used + MEDIA_TTL_MS).toISOString(),
      });
    }
    return out.sort((a, b) => b.used - a.used).map(({ used: _used, ...record }) => record);
  }

  /**
   * Deletes a media: its folder (the file it holds, mezzanine, proxy, analyses) and the index
   * entries that find it by content or recipe. A path import's original stays where it is: only
   * what the server made is removed. Returns the bytes freed.
   */
  async remove(owner: string, id: string): Promise<number> {
    const record = await this.#records(owner).get(this.#id(id));
    if (!record) throw await this.missing(owner, id);
    if (record.status === 'importing' || record.status === 'processing') {
      const busy = notReady(record, 'media.delete');
      throw new CfError('media_not_ready', busy.message, {
        hint: `${busy.hint}; or stop that job with job.cancel, then delete it`,
        ...(busy.detail ? { detail: busy.detail } : {}),
      });
    }
    let freed = await this.#ws.blobs.freeable(this.prefix(owner, id));
    for (const key of this.#apart(owner, record)) {
      const head = await this.#ws.blobs.head(key);
      if (head && head.refs <= 1) freed += head.bytes;
    }
    const index = this.#index(owner);
    for (const name of await index.ids()) {
      const entry = await index.get(name);
      if (entry?.media_id === id) await index.delete(name);
    }
    await this.#drop(owner, id, record);
    await this.#tombstone(owner, id, 'deleted');
    await floorChanged(this.#ws, owner);
    return freed;
  }

  /**
   * The record's own files that are not under the media's prefix: in an object store its
   * source, mezzanine and proxy, each of which another media may hold too. None on the
   * filesystem, where they are in the media's folder: a record there that names a file outside
   * it (an older server's) names a file that is not its own, and is left alone as it always was.
   */
  #apart(owner: string, record: MediaRecord): BlobKey[] {
    if (!this.#ws.blobs.remote) return [];
    const prefix = `${this.prefix(owner, record.media_id)}/`;
    const keys = new Set<BlobKey>();
    for (const ref of [record.file, record.mezzanine, record.proxy]) {
      if (isBlob(ref) && !ref.startsWith(prefix)) keys.add(ref);
    }
    return [...keys];
  }

  /**
   * Removes a media's files (its analyses with them) and its record. `record` is the media as
   * it was, where it is known: its files kept apart from its prefix go by name (each stays for
   * any other media that holds it).
   */
  async #drop(owner: string, id: string, record?: MediaRecord): Promise<void> {
    if (record) for (const key of this.#apart(owner, record)) await this.#ws.blobs.delete(key);
    // Its analyses are among its files.
    await this.#ws.blobs.deletePrefix(this.prefix(owner, id));
    await this.#records(owner).delete(id);
  }

  /**
   * What the owner's media hold, for an object store's orphan sweep: how many media name each
   * file, and the ids that have a record.
   */
  async holders(owner: string): Promise<{ held: Map<BlobKey, number>; media: Set<string> }> {
    const held = new Map<BlobKey, number>();
    const media = new Set<string>();
    for (const { id, value } of await this.#records(owner).find()) {
      media.add(id);
      for (const ref of new Set([value.file, value.mezzanine, value.proxy])) {
        if (isBlob(ref)) held.set(ref, (held.get(ref) ?? 0) + 1);
      }
    }
    return { held, media };
  }

  async sweep(ttlMs = MEDIA_TTL_MS): Promise<number> {
    let n = 0;
    for (const owner of await this.#ws.records.owners()) {
      const before = n;
      // In an object store a media's own files are found through its record, which is gone by
      // the time it is told of: read first.
      const known = new Map<string, MediaRecord>();
      if (this.#ws.blobs.remote) {
        for (const { id, value } of await this.#records(owner).find()) known.set(id, value);
      }
      // A media is as old as its record's last use.
      // Each media's files and tombstone are dealt with as it goes, before the next is removed.
      await this.#records(owner).expire(ttlMs, undefined, async (id) => {
        if (MEDIA_ID.test(id)) {
          await this.#drop(owner, id, known.get(id));
          await this.#tombstone(owner, id, 'expired');
        }
        n += 1;
      });
      if (n > before) await floorChanged(this.#ws, owner);
      await this.#index(owner).expire(ttlMs);
      await this.#ws.records.collection(MEDIA_GONE, { owner }).expire(GONE_DAYS * 86_400_000);
      // The floor cursor of an account idle as long as its media lasts; a lost one costs a list.
      await this.#ws.records.collection(FLOOR, { owner }).expire(ttlMs, (id) => id !== 'floor');
    }
    return n;
  }
}

/** Where a media came from, as a result states it. A URL's query (often a signature) is left out. */
export function mediaOrigin(record: MediaRecord): MediaOrigin {
  const s = record.source;
  if ('url' in s) {
    let url = s.url;
    try {
      const u = new URL(s.url);
      url = `${u.origin}${u.pathname}`;
    } catch {
      // stored as given
    }
    return { from: 'url', url, ...(s.attached ? { attached: true } : {}) };
  }
  if ('path' in s) return { from: 'path', path: s.path };
  if ('upload' in s) {
    return {
      from: 'upload',
      upload_id: s.upload,
      ...(s.file_name ? { file_name: s.file_name } : {}),
      ...(s.via ? { via: s.via } : {}),
    };
  }
  if ('job' in s) {
    return {
      from: 'render',
      job_id: s.job,
      ...(s.timeline_id ? { timeline_id: s.timeline_id } : {}),
      ...(s.preset ? { preset: s.preset } : {}),
      ...(s.range ? { range: s.range } : {}),
      ...(s.sources ? { sources: s.sources } : {}),
    };
  }
  if ('still' in s) {
    return {
      from: 'still',
      frame: s.still,
      ...(s.media_id ? { media_id: s.media_id } : {}),
      ...(s.timeline_id ? { timeline_id: s.timeline_id } : {}),
    };
  }
  return {
    from: 'created',
    tool: s.created,
    recipe: s.recipe,
    ...(s.job_id ? { job_id: s.job_id } : {}),
    ...(s.from?.length ? { media_ids: s.from } : {}),
  };
}

/** What a timeline stores about media. */
export function mediaRef(record: MediaRecord): MediaRef | undefined {
  const p = record.probe;
  if (!p || record.status === 'importing' || record.status === 'failed') return undefined;
  return {
    name: record.name,
    duration: p.duration === null ? null : secondsToTicks(p.duration),
    video: Boolean(p.video),
    audio: Boolean(p.audio),
    ...shorter('picture', p.video ? streamSeconds(p, 'video') : null, p.duration),
    ...shorter('sound', p.audio ? streamSeconds(p, 'audio') : null, p.duration),
    ...(p.kind === 'font' || p.kind === 'lut' ? { kind: p.kind } : {}),
  };
}

/** A stream's length in ticks, kept only when it stops before the file does. */
function shorter(
  key: 'picture' | 'sound',
  seconds: number | null,
  duration: number | null,
): Partial<Record<'picture' | 'sound', number>> {
  if (seconds === null || duration === null || seconds >= duration) return {};
  return { [key]: secondsToTicks(seconds) };
}

export function mediaInfo(
  record: MediaRecord,
  include: StoredAnalysis[] = [],
  /** Everything the probe read (media.get gives it). */
  options: { probe?: boolean } = {},
): MediaGetResult {
  // Every way to a record (find, create, import) counts as a use, so it is kept from now.
  const until = Date.now() + KEEP_MS.media;
  const p = record.probe;
  const a = record.analyses;
  const analyses = a
    ? {
        ...(a.transcript
          ? {
              transcript: {
                model: a.transcript.model,
                language: a.transcript.language,
                words: a.transcript.words.length,
              },
            }
          : {}),
        ...(a.beats ? { beats: { bpm: a.beats.bpm, beats: a.beats.beats.length } } : {}),
        ...(a.faces
          ? {
              faces: {
                rate: a.faces.rate,
                frames_with_faces: a.faces.frames.filter((f) => f.faces.length).length,
              },
            }
          : {}),
        ...(a.speech
          ? {
              speech: {
                model: a.speech.model,
                frames: a.speech.probabilities.length,
                frame_seconds: a.speech.frame_seconds,
              },
            }
          : {}),
        ...(a.sounds
          ? {
              sounds: {
                model: a.sounds.model,
                min_probability: a.sounds.min_probability,
                heard: Object.keys(a.sounds.spans).filter((k) => a.sounds?.spans[k]?.length),
              },
            }
          : {}),
        ...(a.speakers
          ? {
              speakers: {
                model: a.speakers.model,
                speakers: a.speakers.speakers,
                turns: a.speakers.turns.length,
              },
            }
          : {}),
        ...(a.voice ? { voice: { ...a.voice.summary, frames: a.voice.frames.length } } : {}),
        ...(a.colour
          ? {
              colour: {
                frames: a.colour.frames.length,
                regions: Object.keys(a.colour.frames[0]?.regions ?? {}),
              },
            }
          : {}),
        ...(a.picture
          ? {
              picture: {
                frames: a.picture.columns.time?.length ?? 0,
                from: a.picture.from,
              },
            }
          : {}),
        ...(a.look?.runs.length
          ? {
              look: {
                runs: a.look.runs.length,
                frames: a.look.runs.at(-1)?.frames.length ?? 0,
                questions: Object.keys(a.look.runs.at(-1)?.questions ?? {}),
              },
            }
          : {}),
      }
    : undefined;
  return {
    media_id: record.media_id,
    name: record.name,
    kept_until: new Date(until).toISOString(),
    expiry: expiry(until, KEEP_THEN.media),
    origin: mediaOrigin(record),
    created_at: record.created_at,
    fingerprint: record.fingerprint,
    status: record.status,
    kind: p?.kind ?? null,
    ...(p?.family ? { font_family: p.family } : {}),
    ...(p?.extension ? { extension: p.extension } : {}),
    ...(p?.mime ? { mime_type: p.mime } : {}),
    duration_seconds: p?.duration ?? null,
    fps: p?.video?.fps ?? null,
    width: p?.video ? (p.video.rotation % 180 ? p.video.height : p.video.width) : null,
    height: p?.video ? (p.video.rotation % 180 ? p.video.width : p.video.height) : null,
    has_video: Boolean(p?.video),
    has_audio: Boolean(p?.audio),
    codecs: { video: p?.video?.codec ?? null, audio: p?.audio?.codec ?? null },
    ...(p?.audio && streamSeconds(p, 'audio') !== null
      ? { sound_seconds: streamSeconds(p, 'audio') as number }
      : {}),
    ...(p?.video && p.duration !== null && streamSeconds(p, 'video') !== null
      ? { picture_seconds: streamSeconds(p, 'video') as number }
      : {}),
    conform: record.conform,
    analysis: record.analysis,
    ...(analyses && Object.keys(analyses).length ? { analyses } : {}),
    ...(options.probe && p?.raw ? { probe: p.raw } : {}),
    ...Object.fromEntries(include.flatMap((k) => (a?.[k] ? [[k, a[k]]] : []))),
    // Each transcript word carries the speaker the latest speakers run heard saying it.
    ...(include.includes('transcript') && a?.transcript && a.speakers
      ? { transcript: withSpeakers(a.transcript, a.speakers) }
      : {}),
    ...(record.warnings?.length ? { warnings: record.warnings } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

/** How long the first stream of a type runs, from the probe; null when unknown. */
function streamSeconds(p: Probe, type: 'video' | 'audio'): number | null {
  const s = p.raw?.streams.find((x) => x.codec_type === type);
  if (!s) return null;
  const tagged = (s.tags as { DURATION?: string } | undefined)?.DURATION;
  const hms = tagged ? /^(\d+):(\d+):([\d.]+)$/.exec(tagged) : null;
  const stated = s.duration
    ? Number(s.duration)
    : hms
      ? Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])
      : Number.NaN;
  // Never past the media's length, which is what could be read of it.
  const seconds = p.duration === null ? stated : Math.min(stated, p.duration);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : null;
}

/** A transcript whose words carry the speaker whose turns overlap each most. */
function withSpeakers(
  transcript: NonNullable<MediaInfo['transcript']>,
  speakers: NonNullable<MediaGetResult['speakers']>,
): NonNullable<MediaInfo['transcript']> {
  const who = wordSpeakers(transcript.words, speakers.turns);
  return {
    ...transcript,
    words: transcript.words.map((w, i) => ({ ...w, speaker: who[i] ?? null })),
  };
}

/** Which file each render reads: proxies for previews, the mezzanine or original for exports. */
/**
 * Whether a picture may be see-through anywhere: an alpha channel, or a palette (a PNG palette
 * can mark colours transparent). Views of it go over a checkerboard.
 */
export function mayBeTransparent(p: Probe | null | undefined): boolean {
  return Boolean(p?.video) && (hasAlpha(p as Probe) || p?.video?.pix_fmt === 'pal8');
}

/** Whether a probed picture carries an alpha channel. */
export function hasAlpha(p: Probe): boolean {
  return /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(p.video?.pix_fmt ?? '');
}

/** The job that makes a media: the create.* job that made it, or its media.import. */
export function makingJob(record: MediaRecord): { tool: string; job_id?: string } {
  if ('created' in record.source) {
    return {
      tool: record.source.created,
      ...(record.source.job_id ? { job_id: record.source.job_id } : {}),
    };
  }
  return { tool: 'media.import', ...(record.job_id ? { job_id: record.job_id } : {}) };
}

/**
 * media_not_ready (or failed) for a media that `needs` must have ready, naming the job making
 * it; `needs` null when only a probe is needed (status processing).
 */
export function notReady(record: MediaRecord, needs: string | null): CfError {
  return mediaNotReady(record.media_id, record.status, needs, makingJob(record));
}

/**
 * Which of a media's files a render reads: the proxy for previews, the mezzanine or original
 * for exports. A record's own reference (a blob key, or a path import's file); engines take the
 * local file from `MediaLibrary.sourceFile`.
 */
export function sourceRef(record: MediaRecord, purpose: 'preview' | 'export'): string {
  const file =
    purpose === 'preview'
      ? (record.proxy ?? record.mezzanine ?? record.file)
      : (record.mezzanine ?? record.file);
  if (!file) throw notReady(record, null);
  return file;
}

/**
 * `fingerprint` of a blob, read from the store in ranges (at most 12 MB, whatever its size):
 * the same answer as for its bytes in a local file. Undefined when there is no such blob.
 */
export async function fingerprintBlob(
  blobs: Pick<BlobStore, 'head' | 'getRange'>,
  key: BlobKey,
): Promise<string | undefined> {
  const head = await blobs.head(key);
  if (!head) return undefined;
  const CHUNK = 4 * 1024 * 1024;
  const size = head.bytes;
  const hasher = await createBLAKE3();
  hasher.init();
  hasher.update(String(size));
  const offsets = size <= 3 * CHUNK ? [0] : [0, Math.floor(size / 2 - CHUNK / 2), size - CHUNK];
  for (const offset of offsets) {
    const length = size <= 3 * CHUNK ? size : CHUNK;
    const buf = Buffer.alloc(length);
    if (length > 0) {
      let at = 0;
      for await (const chunk of await blobs.getRange(key, offset, offset + length - 1)) {
        const bytes = chunk as Buffer;
        bytes.copy(buf, at, 0, Math.min(bytes.length, length - at));
        at += bytes.length;
        if (at >= length) break;
      }
    }
    hasher.update(buf);
  }
  return hasher.digest('hex').slice(0, 40);
}

/** Size + BLAKE3 of the first, middle and last 4 MB. */
export async function fingerprint(path: string): Promise<string> {
  const CHUNK = 4 * 1024 * 1024;
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const hasher = await createBLAKE3();
    hasher.init();
    hasher.update(String(size));
    const offsets = size <= 3 * CHUNK ? [0] : [0, Math.floor(size / 2 - CHUNK / 2), size - CHUNK];
    for (const offset of offsets) {
      const length = size <= 3 * CHUNK ? size : CHUNK;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, offset);
      hasher.update(buf);
    }
    return hasher.digest('hex').slice(0, 40);
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Parses ffmpeg's `time=` progress against a known duration. */
function timeProgress(duration: number | null, onFraction: (f: number) => void) {
  return (line: string) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (!m || !duration) return;
    const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    onFraction(Math.min(1, t / duration));
  };
}

const INPUT = ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file'];

/** ProRes 422 HQ mezzanine: constant frame rate, upright, BT.709 SDR. */
async function conform(
  src: string,
  dest: string,
  p: Probe,
  signal: AbortSignal,
  onFraction: (f: number) => void,
) {
  const v = p.video;
  if (!v) return;
  const filters: string[] = [];
  if (v.transfer === 'smpte2084' || v.transfer === 'arib-std-b67') {
    filters.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
    );
  }
  const alpha = hasAlpha(p);
  // ProRes 4444 keeps an alpha channel; 422 HQ is the mezzanine otherwise.
  filters.push(
    `fps=${v.fps.num}/${v.fps.den}`,
    alpha ? 'format=yuva444p10le' : 'format=yuv422p10le',
  );
  const args = [
    ...INPUT,
    '-y',
    '-i',
    `file:${src}`,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    filters.join(','),
    '-c:v',
    'prores_ks',
    '-profile:v',
    alpha ? '4' : '3',
    '-vendor',
    'apl0',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-c:a',
    'pcm_s24le',
    '-ar',
    '48000',
    '-f',
    'mov',
    `file:${dest}`,
  ];
  await run(BIN.ffmpeg, args, {
    heavy: true,
    signal,
    onLine: timeProgress(p.duration, onFraction),
  });
}

/** 540p all-intra MJPEG proxy (every frame a keyframe) with PCM audio. */
async function makeProxy(
  src: string,
  dest: string,
  p: Probe,
  signal: AbortSignal,
  onFraction: (f: number) => void,
) {
  const v = p.video;
  if (!v) return;
  const args = [
    ...INPUT,
    '-y',
    '-i',
    `file:${src}`,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `fps=${v.fps.num}/${v.fps.den},scale='if(gte(iw,ih),-2,540)':'if(gte(iw,ih),540,-2)':flags=bicubic,format=${hasAlpha(p) ? 'rgba' : 'yuvj422p'}`,
    // MJPEG has no alpha; pictures with one get an all-intra PNG proxy instead.
    ...(hasAlpha(p) ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', '4']),
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    '-f',
    'mov',
    `file:${dest}`,
  ];
  await run(BIN.ffmpeg, args, {
    heavy: true,
    signal,
    onLine: timeProgress(p.duration, onFraction),
  });
}

/** Integrated loudness, measured once at import (EBU R128; below its -70 LUFS gate, none). */
async function analyse(
  file: string,
  p: Probe,
  signal: AbortSignal,
): Promise<NonNullable<MediaInfo['analysis']>> {
  if (!p.audio) return { loudness_lufs: null };
  const { stderr } = await run(
    BIN.ffmpeg,
    [
      ...INPUT,
      '-i',
      `file:${file}`,
      '-vn',
      '-af',
      `ebur128=framelog=quiet,astats=${LOUDNESS_STATS}`,
      '-f',
      'null',
      '-',
    ],
    { signal },
  );
  const i = /I:\s+(-?[\d.]+) LUFS/.exec(stderr.slice(stderr.lastIndexOf('Summary')));
  const loudness = i ? Number(i[1]) : null;
  return {
    loudness_lufs: loudness !== null && loudness >= -70 ? loudness : null,
    channels: parseChannelLevels(stderr),
  };
}

/** The name a URL import starts with: the last part of its path. */
function urlName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
}
