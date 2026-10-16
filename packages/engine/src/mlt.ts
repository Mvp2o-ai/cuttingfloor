import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { frameSource, type TransformState, ticksPerFrame, timelineEnd } from '@cuttingfloor/core';
import {
  CfError,
  type NestedDoc,
  type StoredClip,
  TICKS_PER_SECOND,
  type TimelineDoc,
} from '@cuttingfloor/schema';
import { compositeFor, type RenderSpan, rotoFilters, type SourceSize } from './composite.ts';
import { applyEffects, clipPlan, crossfadeLevels, planTrack, revealSpline } from './transitions.ts';

export interface MltSource {
  path: string;
  image: boolean;
  /** Display size of the picture (after rotation); null for audio-only media. */
  width: number | null;
  height: number | null;
  /** Whether the picture carries an alpha channel. */
  alpha: boolean;
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
 * Track 0 is a black background. Each video clip composites itself over the tracks below with
 * a `qtblend` transition over its own range (transform, opacity, blend mode); crop and masks
 * are `rotoscoping` filters on the clip. Audio tracks are summed with `mix`. A nested timeline
 * is its own tractor over a transparent base, compiled once and played like a media item.
 */
export function compileMlt(doc: TimelineDoc, options: CompileOptions): string {
  const fps = doc.sequence.fps;
  const tpf = ticksPerFrame(fps);
  const frame = (ticks: number) => Math.round(ticks / tpf);
  const x: string[] = [];
  x.push('<?xml version="1.0" encoding="utf-8"?>');
  x.push(`<mlt LC_NUMERIC="C" producer="${options.frames ? 'frames' : 'main'}">`);
  const { width, height } = options;
  const g = gcd(width, height);
  x.push(
    `<profile width="${width}" height="${height}" frame_rate_num="${fps.num}" frame_rate_den="${fps.den}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${width / g}" display_aspect_den="${height / g}" colorspace="709"/>`,
  );

  // One producer per media item and stream, shared by every level of nesting.
  const nested = doc.nested ?? {};
  const bodies: NestedDoc[] = [doc, ...Object.values(nested)];
  const used = new Map<string, Set<'video' | 'audio'>>();
  for (const body of bodies)
    for (const t of body.tracks)
      for (const c of t.clips) {
        if (!c.enabled || c.type !== 'media') continue;
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

  // Nested timelines first, each after anything it nests itself.
  const tractors = new Map<string, string>();
  const visit = (key: string) => {
    if (tractors.has(key)) return;
    const body = nested[key];
    if (!body)
      throw new CfError('bad_request', `Nested timeline ${key} is missing from the document`);
    for (const t of body.tracks)
      for (const c of t.clips) if (c.type === 'timeline') visit(c.timeline);
    const id = `n${tractors.size + 1}_main`;
    tractors.set(key, id);
    const length = Math.max(1, frame(timelineEnd(body)));
    x.push(...tractor(body, `n${tractors.size}_`, id, { length, clear: true }));
  };
  for (const t of doc.tracks) for (const c of t.clips) if (c.type === 'timeline') visit(c.timeline);

  const length = Math.max(1, frame(timelineEnd(doc)));
  x.push(
    ...tractor(doc, '', 'main', {
      length,
      clear: false,
      ...(options.range ? { range: options.range } : {}),
    }),
  );
  if (options.frames) {
    x.push(
      `<playlist id="frames">${options.frames.map((f) => `<entry producer="main" in="${f}" out="${f}"/>`).join('')}</playlist>`,
    );
  }
  x.push('</mlt>');
  return x.join('\n');

  /** The XML for one timeline body as a tractor with the given id. */
  function tractor(
    body: NestedDoc,
    prefix: string,
    id: string,
    o: { length: number; clear: boolean; range?: { start: number; end: number } },
  ): string[] {
    const parts: string[] = [];
    const { length: len } = o;
    // The top level stands on black; a nested timeline on transparency, so it composites.
    parts.push(
      `<producer id="${prefix}base" in="0" out="${len - 1}"><property name="mlt_service">color</property><property name="resource">${o.clear ? '0x00000000' : '0x000000ff'}</property><property name="length">${len}</property></producer>`,
    );
    parts.push(
      `<playlist id="${prefix}bg"><entry producer="${prefix}base" in="0" out="${len - 1}"/></playlist>`,
    );
    const trackXml: string[] = [`<track producer="${prefix}bg"/>`];
    const transitions: string[] = [];
    const out = { width, height };
    let index = 0;
    body.tracks.forEach((t, ti) => {
      // A track with transitions spreads its clips over sub-tracks so the two clips at a cut
      // can play at once; the clip after a cut is always on the sub-track above.
      const plan = planTrack(t, tpf);
      const lanes: string[][] = Array.from({ length: plan.levels }, () => []);
      const cursors: number[] = Array.from({ length: plan.levels }, () => 0);
      const base = index + 1;
      const put = (level: number, from: number, xml: string, length: number) => {
        const lane = lanes[level] as string[];
        const at = cursors[level] as number;
        if (from > at) lane.push(`<blank length="${from - at}"/>`);
        lane.push(xml);
        cursors[level] = from + length;
      };
      for (const c of [...t.clips].sort((a, b) => a.start - b.start)) {
        const s = frame(c.start);
        const e = frame(c.start + c.duration);
        if (e <= s || !c.enabled) continue;
        const cp = clipPlan(plan, c.id);
        const n = e - s;
        const from = s - cp.head;
        const length = n + cp.head + cp.tail;
        const span = { head: cp.head, tail: cp.tail };
        const src = c.kind === 'video' ? sourceSize(c, nested, options, width, height) : undefined;
        const media = c.type === 'media' ? options.sources.get(c.media_id) : undefined;
        const chained = c.type === 'media' && Boolean(c.speed) && Boolean(media) && !media?.image;
        // Producer position of the clip's first frame, which is what filter keyframes count.
        const keyBase = chained ? cp.head : media?.image ? cp.head : frame(c.in);
        const filters = src
          ? clipFilters(c, tpf, n, src, out, span, keyBase, revealSpline(cp.effects, keyBase))
          : gainFilter(crossfadeLevels(cp.effects, keyBase));
        let entry: string;
        if (chained && media) {
          // A retimed clip is its own chain: the timeremap link maps each clip frame to a
          // source time, which covers speed, ramps, reverse and freeze frames.
          const chain = `${prefix}${c.id}_${c.kind[0]}`;
          parts.push(retimedChain(chain, c, media.path, tpf, n, span));
          entry = `<entry producer="${chain}" in="0" out="${length - 1}">${filters}</entry>`;
        } else {
          const producer =
            c.type === 'media'
              ? `${c.media_id}_${c.kind[0]}`
              : (tractors.get(c.timeline) as string);
          // A still has no timeline of its own: any frame of it is the picture.
          const inF = media?.image ? 0 : frame(c.in) - cp.head;
          entry = `<entry producer="${producer}" in="${inF}" out="${inF + length - 1}">${filters}</entry>`;
        }
        put(cp.level, from, entry, length);
        if (src && !t.hidden) {
          const adjust = cp.effects.length
            ? (i: number, st: TransformState) => applyEffects(cp.effects, i, st)
            : undefined;
          transitions.push(
            clipTransition(c, tpf, from, length, base + cp.level, src, out, span, adjust),
          );
        }
      }
      // Dips to a colour play on a layer above both clips, peaking at the cut.
      for (const dip of plan.dips) {
        const pid = `${prefix}dip_${dip.id}`;
        const d = dip.end - dip.start;
        parts.push(
          `<producer id="${pid}" in="0" out="${d - 1}">${prop('mlt_service', 'color')}${prop('resource', dip.color === 'black' ? '0x000000ff' : '0xffffffff')}${prop('length', d)}</producer>`,
        );
        put(plan.levels - 1, dip.start, `<entry producer="${pid}" in="0" out="${d - 1}"/>`, d);
        if (!t.hidden) {
          const mid = Math.floor(d / 2);
          transitions.push(
            `<transition in="${dip.start}" out="${dip.end - 1}">${prop('mlt_service', 'qtblend')}${prop('a_track', 0)}${prop('b_track', base + plan.levels - 1)}${prop('rect', `0=0 0 ${width} ${height} 0;${mid}=0 0 ${width} ${height} 1;${d - 1}=0 0 ${width} ${height} 0`)}${prop('distort', 1)}</transition>`,
          );
        }
      }
      const off = t.kind === 'video' ? t.hidden : t.muted;
      lanes.forEach((lane, level) => {
        const pid = level ? `${prefix}track${ti}_${level}` : `${prefix}track${ti}`;
        const at = cursors[level] as number;
        if (at < len) lane.push(`<blank length="${len - at}"/>`);
        parts.push(`<playlist id="${pid}">${lane.join('')}</playlist>`);
        trackXml.push(
          `<track producer="${pid}" hide="${off ? 'both' : t.kind === 'video' ? 'audio' : 'video'}"/>`,
        );
        index += 1;
        if (t.kind === 'audio') {
          transitions.push(
            `<transition><property name="mlt_service">mix</property><property name="a_track">0</property><property name="b_track">${index}</property><property name="always_active">1</property><property name="sum">1</property></transition>`,
          );
        }
      });
    });
    const inOut = o.range
      ? ` in="${o.range.start}" out="${o.range.end - 1}"`
      : ` in="0" out="${len - 1}"`;
    parts.push(
      `<tractor id="${id}"${inOut}><multitrack>${trackXml.join('')}</multitrack>${transitions.join('')}</tractor>`,
    );
    return parts;
  }
}

const prop = (name: string, value: string | number) =>
  `<property name="${name}">${esc(String(value))}</property>`;

/** The picture size the compositor works from; the canvas size when the source has none. */
function sourceSize(
  c: StoredClip,
  nested: Record<string, NestedDoc>,
  options: CompileOptions,
  w: number,
  h: number,
): SourceSize {
  if (c.type === 'timeline') {
    // A nested timeline is a picture of its own sequence size, transparent where it is empty.
    const seq = nested[c.timeline]?.sequence;
    return { width: seq?.width ?? w, height: seq?.height ?? h, alpha: true };
  }
  const src = options.sources.get(c.media_id);
  return {
    width: src?.width ?? w,
    height: src?.height ?? h,
    alpha: src?.alpha ?? false,
  };
}

/** A chain that plays `n` frames of a clip's source through timeremap. */
function retimedChain(
  id: string,
  c: StoredClip,
  path: string,
  tpf: number,
  n: number,
  span: RenderSpan,
): string {
  const seconds = (i: number) =>
    Math.round((frameSource(c, tpf, i) / TICKS_PER_SECOND) * 1e6) / 1e6;
  const points: Array<[number, number]> = [];
  for (let j = 0; j < n + span.head + span.tail; j++) points.push([j, seconds(j - span.head)]);
  // Keep only the corners of straight runs: constant speed is two points, a freeze one.
  const kept = points.filter((p, i) => {
    const a = points[i - 1];
    const b = points[i + 1];
    if (!a || !b) return true;
    return Math.abs(p[1] - (a[1] + b[1]) / 2) > 1e-6;
  });
  const steady = kept.every((p) => p[1] === kept[0]?.[1]);
  const map = (steady ? kept.slice(0, 1) : kept).map(([i, v]) => `${i}=${v}`).join(';');
  const only = c.kind === 'video' ? 'audio_index' : 'video_index';
  const pitch = c.kind === 'audio' && c.speed?.preserve_pitch !== false ? 1 : 0;
  return `<chain id="${id}" out="${n + span.head + span.tail - 1}">${prop('mlt_service', 'avformat')}${prop('resource', path)}${prop(only, -1)}${prop('seekable', 1)}<link>${prop('mlt_service', 'timeremap')}${prop('time_map', map)}${prop('image_mode', 'nearest')}${prop('pitch', pitch)}</link></chain>`;
}

/** A volume filter for a clip's crossfades, if it has any. */
function gainFilter(levels: string | undefined): string {
  return levels ? `<filter>${prop('mlt_service', 'volume')}${prop('level', levels)}</filter>` : '';
}

/** Flip, crop, mask and transition-reveal filters on a clip's playlist entry. */
function clipFilters(
  c: StoredClip,
  tpf: number,
  n: number,
  src: SourceSize,
  out: { width: number; height: number },
  span: RenderSpan,
  keyBase: number,
  reveal: string | undefined,
): string {
  const parts: string[] = [];
  const flip = c.transform?.flip;
  if (flip === 'horizontal' || flip === 'both')
    parts.push(`<filter>${prop('mlt_service', 'avfilter.hflip')}</filter>`);
  if (flip === 'vertical' || flip === 'both')
    parts.push(`<filter>${prop('mlt_service', 'avfilter.vflip')}</filter>`);
  for (const f of rotoFilters(c, tpf, n, src, out, span, keyBase, reveal)) {
    parts.push(
      `<filter>${prop('mlt_service', 'rotoscoping')}${prop('mode', 'alpha')}${prop('alpha_operation', f.operation)}${prop('invert', f.invert ? 1 : 0)}${prop('feather', f.feather)}${prop('feather_passes', 2)}${prop('spline', f.spline)}</filter>`,
    );
  }
  return parts.join('');
}

/** The qtblend transition that composites one clip over everything below it. */
function clipTransition(
  c: StoredClip,
  tpf: number,
  from: number,
  length: number,
  index: number,
  src: SourceSize,
  out: { width: number; height: number },
  span: RenderSpan,
  adjust: ((i: number, s: TransformState) => void) | undefined,
): string {
  const comp = compositeFor(c, tpf, length - span.head - span.tail, src, out, span, adjust);
  return `<transition in="${from}" out="${from + length - 1}">${prop('mlt_service', 'qtblend')}${prop('a_track', 0)}${prop('b_track', index)}${prop('rect', comp.rect)}${prop('distort', 1)}${prop('rotate_center', 1)}${comp.rotation ? prop('rotation', comp.rotation) : ''}${comp.compositing ? prop('compositing', comp.compositing) : ''}</transition>`;
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
