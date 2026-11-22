import { createHmac } from 'node:crypto';
import { type BlobPart, type BlobStore, Workspace } from '@cuttingfloor/core';
import { MediaLibrary } from '@cuttingfloor/engine';
import { Outputs } from '../outputs.ts';
import { Uploads } from '../uploads.ts';
import { ownerTag, relTag } from './layout.ts';
import type { Manifest } from './manifest.ts';
import { hashStream, pool } from './pass.ts';
import type { Plan, Source } from './plan.ts';
import type { Difference } from './verify.ts';

// Checks of the target that do not lean on the migration's own bookkeeping: bytes read back
// from the bucket, an upload's parts as the bucket lists them, links fetched from the new
// server, and records resolved through the application's own readers.

/** How many of a list to check: all, a share of them, or a count. */
export type Sample = 'all' | number;

/** Evenly spread over the list (sorted), so a sample is the same from run to run. */
export function sampled<T>(items: readonly T[], sample: Sample): T[] {
  if (sample === 'all') return [...items];
  const take = sample < 1 ? Math.ceil(items.length * sample) : Math.floor(sample);
  if (take >= items.length) return [...items];
  if (take <= 0) return [];
  return items.filter(
    (_, i) => Math.floor((i * take) / items.length) !== Math.floor(((i - 1) * take) / items.length),
  );
}

/** A store that lists the parts of an unfinished upload (an object store). */
interface ListsParts {
  multipartParts(key: string, uploadId: string): Promise<BlobPart[]>;
}

const listsParts = (blobs: BlobStore): blobs is BlobStore & ListsParts =>
  typeof (blobs as Partial<ListsParts>).multipartParts === 'function';

/**
 * Reads files back from the target and hashes them against the hashes the manifest took from
 * the source: the one check that the bucket holds the source's bytes, not only that the
 * migration's own writes said so. Needs only the manifest and the target, so it runs on the new
 * server, beside the bucket.
 */
export async function rereadBlobs(
  target: BlobStore,
  manifest: Manifest,
  options: { sample: Sample; concurrency: number; log: (line: string) => void },
): Promise<{ checked: number; bytes: number; differences: Difference[] }> {
  const differences: Difference[] = [];
  // Each target key once: files that share bytes there are one object.
  const byTarget = new Map<string, { rel: string; size: number; sha256: string }>();
  for (const [rel, entry] of Object.entries(manifest.blobs).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!byTarget.has(entry.target)) {
      byTarget.set(entry.target, { rel, size: entry.size, sha256: entry.sha256 });
    }
  }
  const chosen = sampled([...byTarget.entries()], options.sample);
  let checked = 0;
  let bytes = 0;
  const started = Date.now();
  await pool(chosen, options.concurrency, async ([key, want]) => {
    const where = relTag(want.rel);
    const head = await target.head(key);
    if (!head) return void differences.push({ kind: 'blob-missing', of: 'reread', where });
    if (head.bytes !== want.size) {
      return void differences.push({
        kind: 'blob-size',
        of: 'reread',
        where,
        detail: `${want.size} bytes at the source, ${head.bytes} in the target`,
      });
    }
    const got = await hashStream(await target.get(key), undefined, (n) => {
      bytes += n;
    });
    checked += 1;
    if (got !== want.sha256) differences.push({ kind: 'blob-sha256', of: 'reread', where });
    if (checked % 100 === 0) {
      const rate = bytes / Math.max(1, (Date.now() - started) / 1000);
      options.log(`  … reread ${checked} of ${chosen.length}, ${(rate / 1e6).toFixed(1)} MB/s`);
    }
  });
  return { checked, bytes, differences };
}

/**
 * An upload carried part way, as the bucket holds it: the state the record's last part names
 * exists, and the bucket lists the multipart upload with the very parts that state says were
 * sent (number, tag and size), adding up with what is held beside them to the offset the sender
 * resumes from. Undefined where it holds; where not, what is wrong. Nothing to check on a
 * store that does not list parts.
 */
export async function checkCarried(
  blobs: BlobStore,
  carried: { target: string; upload_id: string; offset: number; parts: BlobPart[] },
): Promise<{ kind: string; detail: string } | undefined> {
  if (!listsParts(blobs) || !carried.parts.length) return undefined;
  const last = carried.parts.at(-1) as BlobPart;
  if (!last.etag.startsWith('seq:')) {
    // Parts sent as the bucket's own: listed as they are.
    const listed = await blobs.multipartParts(carried.target, carried.upload_id).catch(() => []);
    const same = carried.parts.every((p) =>
      listed.some((l) => l.part === p.part && l.etag === p.etag && l.bytes === p.bytes),
    );
    return same
      ? undefined
      : { kind: 'upload-parts', detail: 'the bucket does not list the parts the record names' };
  }
  const stateKey = last.etag.slice('seq:'.length);
  let state: Buffer;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of await blobs.get(stateKey)) chunks.push(chunk as Buffer);
    state = Buffer.concat(chunks);
  } catch {
    return { kind: 'upload-state', detail: 'the upload’s state the record names is not there' };
  }
  const line = state.indexOf(0x0a);
  const { parts } = JSON.parse(state.subarray(0, line).toString('utf8')) as {
    parts: Array<[number, string, number]>;
  };
  const tail = state.length - line - 1;
  let listed: BlobPart[];
  try {
    listed = await blobs.multipartParts(carried.target, carried.upload_id);
  } catch {
    return { kind: 'upload-parts', detail: 'the bucket has no such multipart upload' };
  }
  for (const [part, etag, bytes] of parts) {
    if (!listed.some((l) => l.part === part && l.etag === etag && l.bytes === bytes)) {
      return { kind: 'upload-parts', detail: `part ${part} is not as the upload’s state says` };
    }
  }
  const held = parts.reduce((sum, [, , bytes]) => sum + bytes, 0) + tail;
  if (held !== carried.offset) {
    return {
      kind: 'upload-offset',
      detail: `the sender resumes at ${carried.offset}; the bucket holds ${held} bytes`,
    };
  }
  return undefined;
}

const sign = (key: Buffer, text: string) =>
  createHmac('sha256', key).update(text).digest('base64url');

/**
 * A download link and an upload link signed with the source's key, fetched from the new
 * server's own address: the download answers with the file (or a redirect to it) of the size
 * moved, the upload with where it stands. Proves the key, the record and the file together.
 */
export async function checkLiveLinks(
  targetUrl: string,
  key: Buffer,
  plan: Plan,
  manifest: Manifest,
): Promise<{ checked: number; differences: Difference[] }> {
  const differences: Difference[] = [];
  let checked = 0;
  const base = targetUrl.replace(/\/+$/, '');
  const exp = Date.now() + 10 * 60_000;
  const output = plan.blobs.find(
    (b) => b.item.area === 'outputs' && !b.wait && manifest.blobs[b.item.rel],
  );
  if (output) {
    checked += 1;
    const { owner, holder, name } = output.item;
    const path = `/outputs/${owner}/${holder}/${encodeURIComponent(name.join('/'))}`;
    const url = `${base}${path}?exp=${exp}&sig=${sign(key, `${path}\n${exp}`)}`;
    const where = `${ownerTag(owner)}/${holder}`;
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status !== 200 || body.length !== output.item.size) {
        differences.push({
          kind: 'link-live',
          of: 'download',
          where,
          detail: `answered ${res.status} with ${body.length} bytes; ${output.item.size} were moved`,
        });
      }
    } catch (error) {
      differences.push({
        kind: 'link-live',
        of: 'download',
        where,
        detail: `no answer (${(error as Error).name})`,
      });
    }
  }
  const upload = plan.records.find((r) => r.item.spec.name === 'uploads' && !r.item.spec.kind);
  if (upload?.item.owner) {
    checked += 1;
    const { owner, id } = upload.item;
    const path = `/uploads/${owner}/${id}`;
    const url = `${base}${path}?exp=${exp}&sig=${sign(key, `upload\n${path}\n${exp}`)}`;
    const where = `${ownerTag(owner)}/${id}`;
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(60_000) });
      if (res.status !== 200 || res.headers.get('upload-offset') === null) {
        differences.push({
          kind: 'link-live',
          of: 'upload',
          where,
          detail: `answered ${res.status}`,
        });
      }
    } catch (error) {
      differences.push({
        kind: 'link-live',
        of: 'upload',
        where,
        detail: `no answer (${(error as Error).name})`,
      });
    }
  }
  return { checked, differences };
}

/**
 * A sample of media, outputs and uploads resolved through the application's own readers on
 * both sides (MediaLibrary's records and its key functions, Outputs, Uploads), never through
 * the migration's own mapping: each must name a file the target holds, of the size the source's
 * does.
 */
export async function checkAppReads(
  source: Source,
  targetWs: Workspace,
  plan: Plan,
  manifest: Manifest,
  sample: Sample,
): Promise<{ checked: number; differences: Difference[] }> {
  const differences: Difference[] = [];
  let checked = 0;
  const config = { roots: [], maxDownloadBytes: 0, downloadTimeoutMs: 0, allowPrivateUrls: false };
  // The source's own data root as a server would open it (opening it writes nothing).
  const sourceWs = new Workspace(source.root);
  const there = new MediaLibrary(targetWs, config);
  const here = new MediaLibrary(sourceWs, config);
  const differ = (of: string, where: string, detail: string) =>
    differences.push({ kind: 'app-read', of, where, detail });
  const sizeAt = async (blobs: BlobStore, key: string | null | undefined) =>
    key ? ((await blobs.head(key))?.bytes ?? -1) : undefined;
  const names = async (blobs: BlobStore, prefix: string) =>
    new Map((await blobs.list(`${prefix}/`)).map((h) => [h.key.slice(prefix.length + 1), h.bytes]));

  // Media: the record as the library lists it (no use counted), its files, analyses, index.
  const media = plan.records.filter(
    (r) => r.item.spec.name === 'media' && !r.item.spec.kind && r.item.owner,
  );
  const owners = new Set(media.map((r) => r.item.owner as string));
  const listed = new Map<string, Map<string, Awaited<ReturnType<MediaLibrary['list']>>[number]>>();
  for (const owner of owners) {
    // An owner whose records cannot all be read (one is being written, or broken: the pass
    // reports it as waiting) is left for the next run.
    try {
      listed.set(`s:${owner}`, new Map((await here.list(owner)).map((m) => [m.media_id, m])));
      listed.set(`t:${owner}`, new Map((await there.list(owner)).map((m) => [m.media_id, m])));
    } catch {
      listed.delete(`s:${owner}`);
    }
  }
  for (const r of sampled(media, sample)) {
    const owner = r.item.owner as string;
    const where = `${ownerTag(owner)}/${r.item.id}`;
    const src = listed.get(`s:${owner}`)?.get(r.item.id);
    // Only what has been moved and not changed since: what waits is the pass's to report.
    const moved = manifest.records[r.key];
    if (!moved || moved.mtime_ms !== r.item.mtimeMs) continue;
    if (!src || src.status === 'importing' || src.status === 'processing') continue;
    checked += 1;
    const got = listed.get(`t:${owner}`)?.get(r.item.id);
    if (!got) {
      differ('media', where, 'the library does not find it at the target');
      continue;
    }
    for (const field of ['file', 'mezzanine', 'proxy'] as const) {
      const want = await sizeAt(sourceWs.blobs, src[field]);
      const have = await sizeAt(targetWs.blobs, got[field]);
      if (want !== have) {
        differ(
          'media',
          where,
          `its ${field} is ${have ?? 'not named'} bytes, ${want} at the source`,
        );
      }
    }
    for (const sub of ['analyses', 'search']) {
      const want = await names(sourceWs.blobs, sourceWs.blobs.keys.derived(owner, r.item.id, sub));
      const have = await names(targetWs.blobs, targetWs.blobs.keys.derived(owner, r.item.id, sub));
      for (const [name, bytes] of want) {
        if (/\.(part|tmp)$/.test(name)) continue;
        if (have.get(name) !== bytes) differ('media', where, `its ${sub} file is not there whole`);
      }
    }
  }

  // Outputs: a job's or a frame set's file, where the app looks for it.
  const outputs = new Outputs(targetWs);
  const outs = plan.blobs.filter((b) => b.item.area === 'outputs' && !b.wait);
  for (const b of sampled(outs, sample)) {
    if (!manifest.blobs[b.item.rel]) continue;
    checked += 1;
    const head = await targetWs.blobs.head(
      outputs.key(b.item.owner, b.item.holder, b.item.name.join('/')),
    );
    if (head?.bytes !== b.item.size) {
      differ('output', `${ownerTag(b.item.owner)}/${b.item.holder}`, 'its file is not there whole');
    }
  }

  // Uploads: where the app says each stands is what the sender has sent.
  const uploads = new Uploads(targetWs, {
    secret: async () => Buffer.alloc(32),
    publicUrl: () => '',
    maxBytes: 0,
  });
  const ups = plan.records.filter((r) => r.item.spec.name === 'uploads' && !r.item.spec.kind);
  for (const r of sampled(ups, sample)) {
    const owner = r.item.owner as string;
    const moved = manifest.records[r.key];
    if (!moved || moved.mtime_ms !== r.item.mtimeMs) continue;
    const bytes = plan.blobs.find(
      (b) => b.item.area === 'uploads' && b.item.owner === owner && b.item.holder === r.item.id,
    );
    if (bytes?.wait || (bytes && !bytes.partway && !manifest.blobs[bytes.item.rel])) continue;
    const carried = bytes ? manifest.partway[bytes.item.rel] : undefined;
    const want = bytes ? (bytes.partway ? carried?.offset : bytes.item.size) : 0;
    if (want === undefined) continue;
    checked += 1;
    const state = await uploads.state(owner, r.item.id);
    if (state?.received !== want) {
      differ(
        'upload',
        `${ownerTag(owner)}/${r.item.id}`,
        `the app says ${state ? state.received : 'nothing'} received, ${want} were moved`,
      );
    }
  }
  return { checked, differences };
}
