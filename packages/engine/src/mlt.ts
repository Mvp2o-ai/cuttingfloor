import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ticksPerFrame, timelineEnd } from '@cuttingfloor/core';
import { CfError, type TimelineDoc } from '@cuttingfloor/schema';

export interface MltSource {
  path: string;
  image: boolean;
}

export interface CompileOptions {
  width: number;
  height: number;
  /** Media file per media_id for this render (proxy for previews, mezzanine or original for export). */
  sources: Map<string, MltSource>;
  /** Frames to render as a playlist of single frames (render.frames). */
  frames?: number[];
  /** Frame range for exports, end exclusive. */
  range?: { start: number; end: number };
}

/**
 * Compiles a timeline to MLT XML. Only the server writes MLT XML: producers are always forced
 * (`avformat`, `pixbuf`), and no service that runs commands or loads files by name is emitted.
 * Track 0 is a black background; video tracks composite bottom to top with `affine` (fit,
 * aspect kept); audio tracks are summed with `mix`.
 */
export function compileMlt(doc: TimelineDoc, options: CompileOptions): string {
  const fps = doc.sequence.fps;
  const tpf = ticksPerFrame(fps);
  const frame = (ticks: number) => Math.round(ticks / tpf);
  const length = Math.max(1, frame(timelineEnd(doc)));
  const x: string[] = [];
  x.push('<?xml version="1.0" encoding="utf-8"?>');
  x.push(`<mlt LC_NUMERIC="C" producer="${options.frames ? 'frames' : 'main'}">`);
  const { width, height } = options;
  const g = gcd(width, height);
  x.push(
    `<profile width="${width}" height="${height}" frame_rate_num="${fps.num}" frame_rate_den="${fps.den}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${width / g}" display_aspect_den="${height / g}" colorspace="709"/>`,
  );
  x.push(
    `<producer id="black" in="0" out="${length - 1}"><property name="mlt_service">color</property><property name="resource">0x000000ff</property><property name="length">${length}</property></producer>`,
  );
  x.push(`<playlist id="bg"><entry producer="black" in="0" out="${length - 1}"/></playlist>`);

  const used = new Map<string, Set<'video' | 'audio'>>();
  for (const t of doc.tracks)
    for (const c of t.clips) {
      if (!c.enabled) continue;
      const set = used.get(c.media_id) ?? new Set();
      set.add(c.kind);
      used.set(c.media_id, set);
    }
  for (const [mediaId, kinds] of used) {
    const src = options.sources.get(mediaId);
    if (!src) throw new CfError('media_offline', `Media ${mediaId} is not available for rendering`);
    for (const kind of kinds) {
      const id = `${mediaId}_${kind[0]}`;
      if (src.image) {
        x.push(
          `<producer id="${id}" in="0" out="${15_000_000 - 1}"><property name="mlt_service">pixbuf</property><property name="resource">${esc(src.path)}</property><property name="length">15000000</property><property name="ttl">1</property></producer>`,
        );
      } else {
        const only = kind === 'video' ? 'audio_index' : 'video_index';
        x.push(
          `<producer id="${id}"><property name="mlt_service">avformat</property><property name="resource">${esc(src.path)}</property><property name="${only}">-1</property><property name="seekable">1</property></producer>`,
        );
      }
    }
  }

  const trackXml: string[] = ['<track producer="bg"/>'];
  const transitions: string[] = [];
  doc.tracks.forEach((t, i) => {
    const pid = `track${i}`;
    const entries: string[] = [];
    let cursor = 0;
    for (const c of [...t.clips].sort((a, b) => a.start - b.start)) {
      const s = frame(c.start);
      const e = frame(c.start + c.duration);
      if (e <= s) continue;
      if (s > cursor) entries.push(`<blank length="${s - cursor}"/>`);
      if (c.enabled) {
        const inF = frame(c.in);
        entries.push(
          `<entry producer="${c.media_id}_${c.kind[0]}" in="${inF}" out="${inF + (e - s) - 1}"/>`,
        );
      } else {
        entries.push(`<blank length="${e - s}"/>`);
      }
      cursor = e;
    }
    if (cursor < length) entries.push(`<blank length="${length - cursor}"/>`);
    x.push(`<playlist id="${pid}">${entries.join('')}</playlist>`);
    const off = t.kind === 'video' ? t.hidden : t.muted;
    trackXml.push(
      `<track producer="${pid}" hide="${off ? 'both' : t.kind === 'video' ? 'audio' : 'video'}"/>`,
    );
    const index = i + 1;
    if (t.kind === 'video') {
      transitions.push(
        `<transition><property name="mlt_service">affine</property><property name="a_track">0</property><property name="b_track">${index}</property><property name="always_active">1</property></transition>`,
      );
    } else {
      transitions.push(
        `<transition><property name="mlt_service">mix</property><property name="a_track">0</property><property name="b_track">${index}</property><property name="always_active">1</property><property name="sum">1</property></transition>`,
      );
    }
  });
  const inOut = options.range
    ? ` in="${options.range.start}" out="${options.range.end - 1}"`
    : ` in="0" out="${length - 1}"`;
  x.push(
    `<tractor id="main"${inOut}><multitrack>${trackXml.join('')}</multitrack>${transitions.join('')}</tractor>`,
  );
  if (options.frames) {
    x.push(
      `<playlist id="frames">${options.frames.map((f) => `<entry producer="main" in="${f}" out="${f}"/>`).join('')}</playlist>`,
    );
  }
  x.push('</mlt>');
  return x.join('\n');
}

/**
 * Writes `profile` and `timeline.mlt` into `dir` and returns the melt arguments that load them.
 * The profile file is what fixes the consumer's rate and pixel aspect: without it melt falls
 * back to its default (PAL) profile for the output.
 */
export async function writeMltProject(
  dir: string,
  doc: TimelineDoc,
  options: CompileOptions,
): Promise<string[]> {
  const { width, height } = options;
  const g = gcd(width, height);
  const fps = doc.sequence.fps;
  const profile = [
    'description=cuttingfloor',
    `frame_rate_num=${fps.num}`,
    `frame_rate_den=${fps.den}`,
    `width=${width}`,
    `height=${height}`,
    'progressive=1',
    'sample_aspect_num=1',
    'sample_aspect_den=1',
    `display_aspect_num=${width / g}`,
    `display_aspect_den=${height / g}`,
    'colorspace=709',
  ].join('\n');
  await writeFile(join(dir, 'profile'), `${profile}\n`);
  await writeFile(join(dir, 'timeline.mlt'), compileMlt(doc, options));
  // melt ignores in/out on the root tractor; the range is applied as producer arguments.
  const range = options.range ? [`in=${options.range.start}`, `out=${options.range.end - 1}`] : [];
  return ['-profile', join(dir, 'profile'), 'timeline.mlt', ...range];
}

/** Timeline length in frames. */
export function lengthFrames(doc: TimelineDoc): number {
  return Math.round(timelineEnd(doc) / ticksPerFrame(doc.sequence.fps));
}

/** Even dimensions with the sequence aspect and the given long edge. */
export function scaledSize(
  width: number,
  height: number,
  longEdge: number,
): { width: number; height: number } {
  const scale = longEdge / Math.max(width, height);
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}
