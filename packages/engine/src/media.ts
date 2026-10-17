import { copyFile, mkdir, open, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';
import { randomId, secondsToTicks, type Workspace } from '@cuttingfloor/core';
import { CfError, type MediaInfo, type MediaRef, type ToolError } from '@cuttingfloor/schema';
import { createBLAKE3 } from 'hash-wasm';
import { BIN, run } from './exec.ts';
import { download } from './fetch.ts';
import { conformReasons, type Probe, probe } from './probe.ts';

export const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MediaRecord {
  media_id: string;
  name: string;
  status: 'importing' | 'processing' | 'ready' | 'failed';
  /** Where it came from: a path, a URL, or a create.* tool and the hash of its recipe. */
  source:
    | { path: string }
    | { url: string }
    | { job: string }
    | { created: string; recipe: string };
  /** The original: the user's file in place, or the downloaded copy. */
  file: string | null;
  size: number | null;
  fingerprint: string | null;
  probe: Probe | null;
  conform: string[];
  mezzanine: string | null;
  proxy: string | null;
  analysis: MediaInfo['analysis'];
  /** media.analyze results, kept with the media. */
  analyses?: {
    transcript?: NonNullable<MediaInfo['transcript']>;
    beats?: NonNullable<MediaInfo['beats']>;
    faces?: NonNullable<MediaInfo['faces']>;
  };
  error?: ToolError;
  created_at: string;
  updated_at: string;
}

export interface MediaConfig {
  /** Folders path imports may read from (realpath-checked). Empty disables path imports. */
  roots: string[];
  maxDownloadBytes: number;
  downloadTimeoutMs: number;
  allowPrivateUrls: boolean;
  /** Local mode: which folder on the user's machine a media root is, for hints. */
  hostFolders?: Record<string, string>;
}

export type Progress = (fraction: number, message: string) => void;

/** Imported media for each owner: records plus mezzanines and proxies, kept 7 days after last use. */
export class MediaLibrary {
  readonly #ws: Workspace;
  readonly config: MediaConfig;

  constructor(ws: Workspace, config: MediaConfig) {
    this.#ws = ws;
    this.config = config;
  }

  dir(owner: string, id: string): string {
    if (!/^m_[0-9a-z]{26}$/.test(id)) throw new CfError('bad_request', `Not a media id: ${id}`);
    return this.#ws.ownerDir(owner, 'media', id);
  }

  async get(owner: string, id: string): Promise<MediaRecord> {
    const record = await this.find(owner, id);
    if (!record) {
      throw new CfError('not_found', `No media ${id}`, {
        hint: 'Media expires 7 days after last use; import the file again with media.import',
      });
    }
    return record;
  }

  async find(owner: string, id: string): Promise<MediaRecord | undefined> {
    return this.#ws.readJson<MediaRecord>(join(this.dir(owner, id), 'media.json'), { touch: true });
  }

  async save(owner: string, record: MediaRecord): Promise<void> {
    record.updated_at = new Date().toISOString();
    await this.#ws.writeJson(join(this.dir(owner, record.media_id), 'media.json'), record);
  }

  /** Checks a path import against the media roots and returns its real path. */
  async resolvePath(path: string): Promise<string> {
    if (!this.config.roots.length) {
      throw new CfError('path_not_allowed', 'Path imports are not available on this server', {
        hint: 'Import from a URL instead',
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
      hint: `Allowed: ${this.config.roots.join(', ')}`,
    });
  }

  /** Copies a file the server made (a rendered export) into a new record's folder. */
  async adopt(owner: string, record: MediaRecord, file: string): Promise<string> {
    const dir = this.dir(owner, record.media_id);
    await mkdir(dir, { recursive: true });
    const dest = join(
      dir,
      `source${extname(file)
        .slice(0, 8)
        .replace(/[^.\w]/g, '')}`,
    );
    await copyFile(file, dest);
    return dest;
  }

  /** An existing usable import of the same content, for dedupe. */
  async findByFingerprint(owner: string, fingerprint: string): Promise<MediaRecord | undefined> {
    const index = await this.#ws.readJson<{ media_id: string }>(
      this.#ws.ownerDir(owner, 'media-index', `${fingerprint}.json`),
    );
    if (!index) return undefined;
    const record = await this.find(owner, index.media_id);
    return record && record.status !== 'failed' && (!record.file || (await exists(record.file)))
      ? record
      : undefined;
  }

  /** Created media made from the same recipe, while it lives. */
  async findByRecipe(owner: string, recipe: string): Promise<MediaRecord | undefined> {
    return this.findByFingerprint(owner, `recipe-${recipe}`);
  }

  async rememberRecipe(owner: string, recipe: string, mediaId: string): Promise<void> {
    await this.#ws.writeJson(this.#ws.ownerDir(owner, 'media-index', `recipe-${recipe}.json`), {
      media_id: mediaId,
    });
  }

  /** Creates the record a new import fills in. */
  async create(
    owner: string,
    source: MediaRecord['source'],
    name: string | undefined,
  ): Promise<MediaRecord> {
    const now = new Date().toISOString();
    const record: MediaRecord = {
      media_id: randomId('m_'),
      name:
        name ??
        ('path' in source
          ? basename(source.path)
          : 'url' in source
            ? decodeURIComponent(new URL(source.url).pathname.split('/').pop() || 'download')
            : 'job' in source
              ? source.job
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
  ): Promise<MediaRecord> {
    const dir = this.dir(owner, record.media_id);
    try {
      if ('url' in record.source) {
        progress(0, 'downloading');
        const ext = extname(new URL(record.source.url).pathname)
          .slice(0, 8)
          .replace(/[^.\w]/g, '');
        const dest = join(dir, `source${ext || '.bin'}`);
        await download(record.source.url, dest, {
          maxBytes: this.config.maxDownloadBytes,
          timeoutMs: this.config.downloadTimeoutMs,
          allowPrivate: this.config.allowPrivateUrls,
          signal,
          onProgress: (bytes, total) =>
            progress(
              total ? 0.3 * (bytes / total) : 0.1,
              `downloading ${(bytes / 1e6).toFixed(1)} MB`,
            ),
        });
        record.file = dest;
      } else if ('path' in record.source) {
        record.file = await this.resolvePath(record.source.path);
      } else if (!record.file) {
        throw new CfError('engine_error', `Created media ${record.media_id} has no file`);
      }
      const file = record.file;
      record.size = (await stat(file)).size;
      record.fingerprint = await fingerprint(file);
      progress(0.3, 'probing');
      record.probe = await probe(file, signal);
      record.conform = conformReasons(record.probe);
      record.status = 'processing';
      await this.save(owner, record);
      await this.#ws.writeJson(
        this.#ws.ownerDir(owner, 'media-index', `${record.fingerprint}.json`),
        { media_id: record.media_id },
      );

      const p = record.probe;
      if (p.kind === 'video' && p.video) {
        let source = file;
        if (record.conform.length) {
          progress(0.35, `conforming (${record.conform.join(', ')})`);
          record.mezzanine = join(dir, 'mezzanine.mov');
          await conform(file, record.mezzanine, p, signal, (f) =>
            progress(0.35 + 0.35 * f, `conforming ${Math.round(f * 100)}%`),
          );
          source = record.mezzanine;
          // Edits and exports read the mezzanine, so its length is the media's length.
          const conformed = await probe(record.mezzanine, signal);
          if (p.duration !== null && conformed.duration !== null) {
            p.duration = Math.min(p.duration, conformed.duration);
          }
          await this.save(owner, record);
        }
        progress(0.7, 'making proxy');
        const proxy = join(dir, 'proxy.mov');
        await makeProxy(source, proxy, p, signal, (f) =>
          progress(0.7 + 0.2 * f, `making proxy ${Math.round(f * 100)}%`),
        );
        record.proxy = proxy;
        await this.save(owner, record);
      }
      if (p.kind === 'video' || p.kind === 'audio') {
        progress(0.9, 'analysing');
        record.analysis = await analyse(record.proxy ?? file, p, signal);
      }
      record.status = 'ready';
      await this.save(owner, record);
      progress(1, 'ready');
      return record;
    } catch (error) {
      record.status = 'failed';
      record.error =
        error instanceof CfError
          ? error.toJSON()
          : { code: 'engine_error', message: (error as Error).message };
      await this.save(owner, record);
      throw error;
    }
  }

  async sweep(ttlMs = MEDIA_TTL_MS): Promise<number> {
    let n = 0;
    for (const owner of await this.#ws.owners()) {
      const base = this.#ws.path('owners', owner, 'media');
      // A media folder's age is its record's last use.
      for (const id of await this.#ws.list(base)) {
        const rec = join(base, id, 'media.json');
        try {
          const s = await stat(rec);
          if (s.mtimeMs < Date.now() - ttlMs) {
            await this.#ws.remove(join(base, id));
            n += 1;
          }
        } catch {
          await this.#ws.remove(join(base, id));
        }
      }
      await this.#ws.sweep(this.#ws.path('owners', owner, 'media-index'), ttlMs);
    }
    return n;
  }
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
    ...(p.kind === 'font' || p.kind === 'lut' ? { kind: p.kind } : {}),
  };
}

export function mediaInfo(
  record: MediaRecord,
  include: Array<'transcript' | 'beats' | 'faces'> = [],
): MediaInfo {
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
      }
    : undefined;
  return {
    media_id: record.media_id,
    name: record.name,
    status: record.status,
    kind: p?.kind ?? null,
    ...(p?.family ? { font_family: p.family } : {}),
    duration_seconds: p?.duration ?? null,
    fps: p?.video?.fps ?? null,
    width: p?.video ? (p.video.rotation % 180 ? p.video.height : p.video.width) : null,
    height: p?.video ? (p.video.rotation % 180 ? p.video.width : p.video.height) : null,
    has_video: Boolean(p?.video),
    has_audio: Boolean(p?.audio),
    codecs: { video: p?.video?.codec ?? null, audio: p?.audio?.codec ?? null },
    conform: record.conform,
    analysis: record.analysis,
    ...(analyses && Object.keys(analyses).length ? { analyses } : {}),
    ...Object.fromEntries(include.flatMap((k) => (a?.[k] ? [[k, a[k]]] : []))),
    ...(record.error ? { error: record.error } : {}),
  };
}

/** Which file each render reads: proxies for previews, the mezzanine or original for exports. */
/** Whether a probed picture carries an alpha channel. */
export function hasAlpha(p: Probe): boolean {
  return /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(p.video?.pix_fmt ?? '');
}

/** The picture a render reads for this media, with what the compositor needs to know about it. */
export function renderPicture(
  record: MediaRecord,
  purpose: 'preview' | 'export',
): {
  path: string;
  image: boolean;
  width: number | null;
  height: number | null;
  alpha: boolean;
  family?: string;
} {
  const p = record.probe;
  const v = p?.video;
  const upright = v ? v.rotation % 180 === 0 : true;
  return {
    path: renderSource(record, purpose),
    image: p?.kind === 'image',
    width: v ? (upright ? v.width : v.height) : null,
    height: v ? (upright ? v.height : v.width) : null,
    alpha: p ? hasAlpha(p) : false,
    ...(p?.family ? { family: p.family } : {}),
  };
}

export function renderSource(record: MediaRecord, purpose: 'preview' | 'export'): string {
  const file =
    purpose === 'preview'
      ? (record.proxy ?? record.mezzanine ?? record.file)
      : (record.mezzanine ?? record.file);
  if (!file) throw new CfError('media_not_ready', `Media ${record.media_id} is still importing`);
  return file;
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
  await run(BIN.ffmpeg, args, { signal, onLine: timeProgress(p.duration, onFraction) });
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
  await run(BIN.ffmpeg, args, { signal, onLine: timeProgress(p.duration, onFraction) });
}

/** Scene cuts, integrated loudness and silences, computed once at import. */
async function analyse(
  file: string,
  p: Probe,
  signal: AbortSignal,
): Promise<NonNullable<MediaInfo['analysis']>> {
  const scenes: number[] = [];
  if (p.video) {
    const { stderr } = await run(
      BIN.ffmpeg,
      [
        ...INPUT,
        '-i',
        `file:${file}`,
        '-an',
        '-vf',
        'scdet=threshold=12,metadata=print:key=lavfi.scd.time',
        '-f',
        'null',
        '-',
      ],
      { signal },
    );
    for (const m of stderr.matchAll(/lavfi\.scd\.time=([\d.]+)/g)) scenes.push(Number(m[1]));
  }
  let loudness: number | null = null;
  const silences: Array<{ start: number; end: number }> = [];
  if (p.audio) {
    const { stderr } = await run(
      BIN.ffmpeg,
      [
        ...INPUT,
        '-i',
        `file:${file}`,
        '-vn',
        '-af',
        'ebur128=framelog=quiet,silencedetect=n=-50dB:d=0.5',
        '-f',
        'null',
        '-',
      ],
      { signal },
    );
    const i = /I:\s+(-?[\d.]+) LUFS/.exec(stderr.slice(stderr.lastIndexOf('Summary')));
    loudness = i ? Number(i[1]) : null;
    if (loudness !== null && loudness < -69) loudness = null;
    let open: number | null = null;
    for (const line of stderr.split('\n')) {
      const s = /silence_start: (-?[\d.]+)/.exec(line);
      const e = /silence_end: (-?[\d.]+)/.exec(line);
      if (s) open = Math.max(0, Number(s[1]));
      if (e && open !== null) {
        silences.push({ start: open, end: Number(e[1]) });
        open = null;
      }
    }
    if (open !== null && p.duration) silences.push({ start: open, end: p.duration });
  }
  return { scenes, loudness_lufs: loudness, silences };
}
