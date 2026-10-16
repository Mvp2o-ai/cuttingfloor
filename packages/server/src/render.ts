import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ticksPerFrame, timelineEnd } from '@cuttingfloor/core';
import {
  lengthFrames,
  type MltSource,
  mediaRef,
  renderSource,
  renderTimelineFrames,
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
  const ids = new Set(
    doc.tracks.flatMap((t) => t.clips.filter((c) => c.enabled).map((c) => c.media_id)),
  );
  for (const id of ids) {
    const record = await rt.media.find(owner, id);
    if (!record || record.status === 'failed' || record.status === 'importing') {
      offline.push(id);
      continue;
    }
    sources.set(id, { path: renderSource(record, purpose), image: record.probe?.kind === 'image' });
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
  options: { longEdge?: number; format?: 'webp' | 'png'; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const longEdge = options.longEdge ?? 640;
  const format = options.format ?? 'webp';
  const cacheFile = rt.ws.path(
    'cache',
    'frames',
    `${timelineId}-${frames.join('_')}-${longEdge}.${format}`,
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
  const { sources, offline } = await sourcesFor(rt, owner, doc, 'preview');
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
