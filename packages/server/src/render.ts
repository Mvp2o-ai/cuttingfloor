import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type MediaFacts, ticksPerFrame, timelineEnd } from '@cuttingfloor/core';
import {
  lengthFrames,
  type MltSource,
  mediaRef,
  renderPicture,
  renderTimelineFrames,
  renderWaveform,
} from '@cuttingfloor/engine';
import { CfError, type MediaRef, type TimelineDoc } from '@cuttingfloor/schema';
import type { Runtime } from './runtime.ts';

/** Resolves every media file a timeline uses, for previews (proxies) or exports. */
export async function sourcesFor(
  rt: Runtime,
  owner: string,
  doc: TimelineDoc,
  purpose: 'preview' | 'export',
): Promise<{ sources: Map<string, MltSource>; offline: string[] }> {
  const sources = new Map<string, MltSource>();
  const offline: string[] = [];
  // Media the clips play, fonts their text is set in, and LUTs their effects use.
  const luts = (effects: Array<{ name: string; params: Record<string, unknown> }> | undefined) =>
    (effects ?? []).flatMap((e) =>
      e.name === 'lut' && typeof e.params.media_id === 'string' ? [e.params.media_id] : [],
    );
  const bodies = [doc, ...Object.values(doc.nested ?? {})];
  const effectMedia = bodies.flatMap((body) => [
    ...luts(body.effects),
    ...body.tracks.flatMap((t) => [...luts(t.effects), ...t.clips.flatMap((c) => luts(c.effects))]),
  ]);
  const ids = new Set(
    [doc, ...Object.values(doc.nested ?? {})]
      .flatMap((body) =>
        body.tracks.flatMap((t) =>
          t.clips.flatMap((c) => {
            if (!c.enabled) return [];
            if (c.type === 'media') return [c.media_id];
            if ((c.type === 'title' || c.type === 'caption') && c.style?.font_media_id)
              return [c.style.font_media_id];
            return [];
          }),
        ),
      )
      .concat(effectMedia),
  );
  for (const id of ids) {
    const record = await rt.media.find(owner, id);
    if (!record || record.status === 'failed' || record.status === 'importing') {
      offline.push(id);
      continue;
    }
    // Previews may read the original while it is conformed; exports wait for the mezzanine.
    if (purpose === 'export' && record.status !== 'ready') {
      throw new CfError('media_not_ready', `Media ${id} is still processing`, {
        hint: 'Wait for its media.import job to finish, then export',
        detail: { media_id: id },
      });
    }
    sources.set(id, renderPicture(record, purpose));
  }
  return { sources, offline };
}

export function assertOnline(offline: string[]): void {
  if (offline.length) {
    throw new CfError('media_offline', `Media not available: ${offline.join(', ')}`, {
      hint: 'Media expires 7 days after last use. Import the file again and swap the clips with clip.add',
      detail: { media_ids: offline },
    });
  }
}

/** Loads the media records an edit refers to, so the synchronous edit math can resolve them. */
export async function mediaResolver(
  rt: Runtime,
  owner: string,
  ids: Iterable<string>,
): Promise<Map<string, MediaRef>> {
  const out = new Map<string, MediaRef>();
  for (const id of new Set(ids)) {
    if (!/^m_[0-9a-z]{26}$/.test(id)) continue;
    const record = await rt.media.find(owner, id);
    if (!record) continue;
    if (record.status === 'importing') {
      throw new CfError('media_not_ready', `Media ${id} is still being probed`, {
        hint: 'Wait for its media.import job to report processing or ready, then try again',
      });
    }
    if (record.status === 'failed') {
      throw new CfError(
        'bad_request',
        `Media ${id} failed to import: ${record.error?.message ?? 'unknown error'}`,
      );
    }
    const ref = mediaRef(record);
    if (ref) out.set(id, ref);
  }
  return out;
}

/** Loads the stored timelines an edit nests, so the synchronous edit math can resolve them. */
export async function timelineResolver(
  rt: Runtime,
  owner: string,
  ids: Iterable<string>,
): Promise<Map<string, TimelineDoc>> {
  const out = new Map<string, TimelineDoc>();
  for (const id of new Set(ids)) {
    if (!/^tl_[0-9a-f]{32}$/.test(id)) continue;
    const doc = await rt.timelines.find(owner, id);
    if (doc) out.set(id, doc);
  }
  return out;
}

/** Every string value under a `nested_timeline_id` key, anywhere in an args tree. */
export function nestedIdsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) nestedIdsIn(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'nested_timeline_id' && typeof v === 'string') out.push(v);
      else nestedIdsIn(v, out);
    }
  }
  return out;
}

/** Every string value under a `media_id` key, anywhere in an args tree. */
export function mediaIdsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) mediaIdsIn(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'media_id' && typeof v === 'string') out.push(v);
      else mediaIdsIn(v, out);
    }
  }
  return out;
}

/** Frames a preview shows: the edit point, or a filmstrip around it for temporal edits. */
export function previewFrames(doc: TimelineDoc, focusTicks: number, temporal: boolean): number[] {
  const length = lengthFrames(doc);
  if (!length) return [];
  const fps = doc.sequence.fps;
  const focus = Math.round(focusTicks / ticksPerFrame(fps));
  const second = Math.max(1, Math.round(fps.num / fps.den));
  const clamp = (f: number) => Math.min(length - 1, Math.max(0, f));
  const frames = temporal ? [focus - second, focus - 1, focus, focus + second] : [focus];
  return [...new Set(frames.map(clamp))].sort((a, b) => a - b);
}

export function framesUri(
  kind: 'timeline' | 'media',
  id: string,
  frames: number[],
  format: 'webp' | 'png' = 'webp',
): string {
  return `video://${kind}/${id}/frames/${frames.join('_')}.${format}`;
}

/**
 * Renders (or reads from cache) one image of timeline frames: a still for one frame, a grid
 * for several. Cached by timeline id, which is a content hash, so entries never go stale.
 */
export async function timelineImage(
  rt: Runtime,
  owner: string,
  timelineId: string,
  doc: TimelineDoc,
  frames: number[],
  options: {
    longEdge?: number;
    format?: 'webp' | 'png';
    signal?: AbortSignal;
    /** Full size from the original media instead of preview size from proxies. */
    full?: boolean;
  } = {},
): Promise<Buffer> {
  const longEdge = options.full
    ? Math.max(doc.sequence.width, doc.sequence.height)
    : (options.longEdge ?? 640);
  const format = options.format ?? 'webp';
  const cacheFile = rt.ws.path(
    'cache',
    'frames',
    `${timelineId}-${frames.join('_')}-${longEdge}${options.full ? '-full' : ''}.${format}`,
  );
  try {
    return await readFile(cacheFile);
  } catch {
    // not cached yet
  }
  if (!timelineEnd(doc))
    throw new CfError('bad_request', 'The timeline is empty', {
      hint: 'Add a clip with clip.add first',
    });
  const { sources, offline } = await sourcesFor(
    rt,
    owner,
    doc,
    options.full ? 'export' : 'preview',
  );
  assertOnline(offline);
  const [image] = await renderTimelineFrames(doc, frames, sources, {
    longEdge,
    format,
    layout: 'grid',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!image) throw new CfError('render_failed', 'No image was rendered');
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, image);
  return image;
}

export function waveformUri(
  id: string,
  range: { start: number; end: number },
  format: 'webp' | 'png' = 'webp',
): string {
  return `video://timeline/${id}/waveform/${range.start}_${range.end}.${format}`;
}

/**
 * Renders (or reads from cache) a waveform of a timeline span with its loudness. Cached by
 * timeline id, a content hash, so entries never go stale.
 */
export async function timelineWaveform(
  rt: Runtime,
  owner: string,
  timelineId: string,
  doc: TimelineDoc,
  range: { start: number; end: number },
  options: { format?: 'webp' | 'png'; signal?: AbortSignal } = {},
): Promise<{ image: Buffer; lufs: number | null; peak: number | null }> {
  const format = options.format ?? 'webp';
  const base = rt.ws.path('cache', 'frames', `${timelineId}-wave-${range.start}_${range.end}`);
  try {
    const [image, meta] = await Promise.all([
      readFile(`${base}.${format}`),
      readFile(`${base}.json`, 'utf8'),
    ]);
    return { image, ...(JSON.parse(meta) as { lufs: number | null; peak: number | null }) };
  } catch {
    // not cached yet
  }
  const length = lengthFrames(doc);
  if (range.end <= range.start || range.end > length) {
    throw new CfError(
      'bad_request',
      `Span ${range.start}–${range.end} is not inside the timeline`,
      {
        hint: `The timeline has ${length} frames`,
      },
    );
  }
  const { sources, offline } = await sourcesFor(rt, owner, doc, 'preview');
  assertOnline(offline);
  const wave = await renderWaveform(doc, sources, range, {
    format,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await mkdir(dirname(base), { recursive: true });
  await writeFile(`${base}.${format}`, wave.image);
  await writeFile(`${base}.json`, JSON.stringify({ lufs: wave.lufs, peak: wave.peak }));
  return wave;
}

/** Silences and transcript words per media item, for edits that use them. */
export async function factsResolver(
  rt: Runtime,
  owner: string,
  doc: TimelineDoc,
  more: Iterable<string> = [],
): Promise<Map<string, MediaFacts>> {
  const out = new Map<string, MediaFacts>();
  const ids = new Set([
    ...doc.tracks.flatMap((t) => t.clips.flatMap((c) => (c.type === 'media' ? [c.media_id] : []))),
    ...more,
  ]);
  for (const id of ids) {
    const record = await rt.media.find(owner, id);
    if (!record) continue;
    out.set(id, {
      ...(record.analyses?.transcript ? { words: record.analyses.transcript.words } : {}),
    });
  }
  return out;
}
