import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  frameSource,
  sample,
  type TransformState,
  ticksPerFrame,
  timelineEnd,
} from '@cuttingfloor/core';
import {
  CfError,
  type NestedDoc,
  type StoredClip,
  TEXT_DEFAULTS,
  TICKS_PER_SECOND,
  type TimelineDoc,
} from '@cuttingfloor/schema';
import {
  compositeFor,
  cornerParams,
  type RenderSpan,
  rotoFilters,
  type SourceSize,
} from './composite.ts';
import { effectFilters, keysOutColour } from './effects.ts';
import { faceKey, loadFace, type Measure } from './fontmetrics.ts';
import { sourceKey } from './sourcepass.ts';
import { type AssOptions, buildAss, type TextFace } from './text.ts';
import {
  applyEffects,
  clipPlan,
  crossfadeGain,
  type Effect,
  planTrack,
  revealSpline,
} from './transitions.ts';

export interface MltSource {
  path: string;
  image: boolean;
  /** Display size of the picture (after rotation); null for audio-only media. */
  width: number | null;
  height: number | null;
  /** Whether the picture carries an alpha channel. */
  alpha: boolean;
  /** Fonts only: the family libass knows the file by. */
  family?: string;
  /** Source seconds the file starts at, when it is a copy of part of the media. */
  offset?: number;
  /** Seconds of the file a second of source lasts, when the copy is slowed (in-between frames). */
  stretch?: number;
  /** Seconds into the file of its last frame, when it is a copy: times past it show that frame. */
  last?: number;
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
  /** Filled with the side files the XML refers to (text scripts), by file name. */
  files?: Map<string, string>;
  /** A folder of imported fonts for libass, when text uses them. */
  fontsDir?: string;
  /** Character widths of the faces text that breaks its own lines (max_lines) is set in. */
  measure?: AssOptions['measure'];
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

  // One producer per media item and stream in each tractor. Tractors don't share one: MLT
  // keeps a producer's last scaled image, so a picture fitted one way inside a nested timeline
  // leaked into the same media fitted another way outside it.
  const nested = doc.nested ?? {};
  // What a media clip plays: its cleaned sound when a source pass made one. Picture-only
  // renders (frames) may go without it and play the media itself.
  const playedKey = (c: StoredClip): string => {
    const key = sourceKey(c, doc.sequence);
    if (c.type !== 'media' || key === c.media_id || options.sources.has(key)) return key;
    if (options.frames) return c.media_id;
    throw new CfError('media_offline', `The cleaned sound of clip ${c.id} was not prepared`);
  };
  const producerName = (key: string) => key.replace(/[^\w-]/g, '_');
  const producers: string[] = [];
  const made = new Set<string>();
  /** The producer that plays a media clip's stream inside the tractor with this prefix. */
  const producerFor = (prefix: string, c: StoredClip & { type: 'media' }): string => {
    const mediaId = playedKey(c);
    const id = `${prefix}${producerName(mediaId)}_${c.kind[0]}`;
    if (made.has(id)) return id;
    made.add(id);
    const src = options.sources.get(mediaId);
    if (!src) throw new CfError('media_offline', `Media ${mediaId} is not available for rendering`);
    if (src.image) {
      producers.push(
        `<producer id="${id}" in="0" out="${15_000_000 - 1}"><property name="mlt_service">pixbuf</property><property name="resource">${esc(src.path)}</property><property name="length">15000000</property><property name="ttl">1</property></producer>`,
      );
    } else {
      const only = c.kind === 'video' ? 'audio_index' : 'video_index';
      producers.push(
        `<producer id="${id}"><property name="mlt_service">avformat</property><property name="resource">${esc(src.path)}</property><property name="${only}">-1</property><property name="seekable">1</property></producer>`,
      );
    }
    return id;
  };

  // Nested timelines are tractors of their own, written before the tractor that plays them.
  // A tractor that two tracks fetch for the same frame (a nested clip's picture and its linked
  // sound, or two overlapping uses) renders wrong in MLT 7.30: the second fetch disturbs the
  // first's compositing. So each use gets a tractor of its own kind (picture or sound only),
  // shared only by uses of the same kind in the same parent that never overlap in time.
  const compiled: string[] = [];
  const pools = new Map<string, Array<{ id: string; spans: Array<[number, number]> }>>();
  let tractorCount = 0;
  const nestedTractor = (
    parent: string,
    c: StoredClip & { type: 'timeline' },
    from: number,
    to: number,
  ): string => {
    const poolKey = `${parent}|${c.timeline}|${c.kind}`;
    const pool = pools.get(poolKey) ?? [];
    pools.set(poolKey, pool);
    let instance = pool.find((i) => i.spans.every(([a, b]) => to <= a || from >= b));
    if (!instance) {
      const inner = nested[c.timeline];
      if (!inner)
        throw new CfError(
          'bad_request',
          `Nested timeline ${c.timeline} is missing from the document`,
        );
      tractorCount += 1;
      const id = `n${tractorCount}_main`;
      const length = Math.max(1, frame(timelineEnd(inner)));
      compiled.push(
        ...tractor(inner, `n${tractorCount}_`, id, { length, clear: true, kind: c.kind }),
      );
      instance = { id, spans: [] };
      pool.push(instance);
    }
    instance.spans.push([from, to]);
    return instance.id;
  };

  const length = Math.max(1, frame(timelineEnd(doc)));
  compiled.push(
    ...tractor(doc, '', 'main', {
      length,
      clear: false,
      ...(options.range ? { range: options.range } : {}),
    }),
  );
  x.push(...producers, ...compiled);
  if (options.frames) {
    x.push(
      `<playlist id="frames">${options.frames.map((f) => `<entry producer="main" in="${f}" out="${f}"/>`).join('')}</playlist>`,
    );
  }
  x.push('</mlt>');
  return x.join('\n');

  /** A timeline's own effects, over its whole picture and mix. */
  function timelineEffects(body: NestedDoc, len: number): string {
    return (body.effects ?? [])
      .map((e) =>
        effectFilters(e, {
          width,
          height,
          from: 0,
          to: len,
          key: (i) => i,
          at: (v, i) => sample(v, 0, i * tpf),
          path: (id) => options.sources.get(id)?.path,
        }),
      )
      .join('');
  }

  /** The XML for one timeline body as a tractor with the given id. */
  function tractor(
    body: NestedDoc,
    prefix: string,
    id: string,
    o: {
      length: number;
      clear: boolean;
      range?: { start: number; end: number };
      /** A nested use plays only its picture or only its sound: the other tracks are left out. */
      kind?: 'video' | 'audio';
    },
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
    const out = { width, height, pixel: width / doc.sequence.width };
    let index = 0;
    body.tracks.forEach((t, ti) => {
      if (o.kind && t.kind !== o.kind) return;
      // Adjustment clips: everything below this track becomes one sub-tractor whose output
      // their effects filter over their own ranges; this track and those above composite on it.
      const zones = t.clips.filter(
        (c) =>
          c.type === 'adjustment' &&
          c.enabled &&
          c.effects?.length &&
          t.kind === 'video' &&
          !t.hidden,
      );
      if (zones.length) {
        const sub = `${prefix}below${ti}`;
        const filters = zones
          .map((z) => {
            const s = frame(z.start);
            const n = frame(z.start + z.duration) - s;
            const fx = (z.effects ?? [])
              .map((e) =>
                effectFilters(e, {
                  width,
                  height,
                  from: 0,
                  to: n,
                  key: (i) => i,
                  at: (v, i) => sample(v, 0, z.in + i * tpf),
                  path: (id) => options.sources.get(id)?.path,
                }),
              )
              .join('');
            // Tractor filters with a range count keyframes from the start of that range.
            return fx.replace(/<filter>/g, `<filter in="${s}" out="${s + n - 1}">`);
          })
          .join('');
        parts.push(
          `<tractor id="${sub}" in="0" out="${len - 1}"><multitrack>${trackXml.join('')}</multitrack>${transitions.join('')}${filters}</tractor>`,
        );
        trackXml.length = 0;
        trackXml.push(`<track producer="${sub}"/>`);
        transitions.length = 0;
        index = 0;
      }
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
        if (e <= s || !c.enabled || c.type === 'adjustment') continue;
        const cp = clipPlan(plan, c.id);
        const n = e - s;
        const from = s - cp.head;
        const length = n + cp.head + cp.tail;
        const span = { head: cp.head, tail: cp.tail };
        const src = c.kind === 'video' ? sourceSize(c, nested, options, width, height) : undefined;
        const media = c.type === 'media' ? options.sources.get(playedKey(c)) : undefined;
        const chained = c.type === 'media' && Boolean(c.speed) && Boolean(media) && !media?.image;
        // Producer position of the clip's first frame, which is what filter keyframes count.
        const generated = c.type === 'title' || c.type === 'caption';
        const keyBase = chained || generated || media?.image ? cp.head : frame(c.in);
        // The track's effects, then the clip's: clip keyframes ride the source, track
        // keyframes the timeline.
        const fx = [
          ...(t.effects ?? []).map((e) => ({ e, onClip: false })),
          ...(c.effects ?? []).map((e) => ({ e, onClip: true })),
        ];
        const fxXml = fx
          .map(({ e, onClip }) =>
            effectFilters(e, {
              width,
              height,
              from: -cp.head,
              to: n + cp.tail,
              key: (i) => keyBase + i,
              at: (v, i) => sample(v, 0, onClip ? frameSource(c, tpf, i) : c.start + i * tpf),
              path: (id) => options.sources.get(id)?.path,
            }),
          )
          .join('');
        // A chroma key makes its own transparency, which masks must then keep.
        const keyed = src && keysOutColour(fx.map((x) => x.e)) ? { ...src, alpha: true } : src;
        const filters = keyed
          ? fxXml +
            clipFilters(c, tpf, n, keyed, out, span, keyBase, revealSpline(cp.effects, keyBase))
          : fxXml + audioFilters(c, tpf, n, span, keyBase, cp.effects);
        let entry: string;
        if (generated) {
          // Text is libass over a transparent layer of the clip's own length; its script is
          // timed from the start of the render span.
          const pid = `${prefix}${c.id}_text`;
          const file = `${pid}.ass`;
          options.files?.set(
            file,
            buildAss(c, {
              width,
              height,
              fps,
              tpf,
              head: cp.head,
              length,
              at: from,
              fontFamily: (id) => options.sources.get(id)?.family,
              ...(options.measure ? { measure: options.measure } : {}),
            }),
          );
          parts.push(
            `<producer id="${pid}" in="0" out="${length - 1}">${prop('mlt_service', 'color')}${prop('resource', '0x00000000')}${prop('length', length)}<filter>${prop('mlt_service', 'avfilter.ass')}${prop('av.filename', file)}${prop('av.alpha', 1)}${options.fontsDir ? prop('av.fontsdir', options.fontsDir) : ''}</filter></producer>`,
          );
          entry = `<entry producer="${pid}" in="0" out="${length - 1}">${filters}</entry>`;
        } else if (chained && media) {
          // A retimed clip is its own chain: the timeremap link maps each clip frame to a
          // source time, which covers speed, ramps, reverse and freeze frames.
          const chain = `${prefix}${c.id}_${c.kind[0]}`;
          parts.push(retimedChain(chain, c, media, tpf, n, span));
          entry = `<entry producer="${chain}" in="0" out="${length - 1}">${filters}</entry>`;
        } else {
          const producer =
            c.type === 'media'
              ? producerFor(prefix, c)
              : c.type === 'timeline'
                ? nestedTractor(prefix, c, from, from + length)
                : '';
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
      `<tractor id="${id}"${inOut}><multitrack>${trackXml.join('')}</multitrack>${transitions.join('')}${timelineEffects(body, len)}${id === 'main' ? masterFilters(doc) : ''}</tractor>`,
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
  if (c.type !== 'media' && c.type !== 'timeline') return { width: w, height: h, alpha: true };
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
  media: MltSource,
  tpf: number,
  n: number,
  span: RenderSpan,
): string {
  const path = media.path;
  // A copy of part of the source (in-between frames) starts at its own offset, slowed.
  const offset = media.offset ?? 0;
  const stretch = media.stretch ?? 1;
  // A copy's frames sit at the sequence rate, so a slowed clip asks for times on its frame
  // edges; MLT's timeremap then shows the first frame twice. A quarter of a copy frame later
  // keeps each time inside its own frame (measured with melt 7.30). The copy holds every
  // frame the clip shows, so it is read frame for frame (nearest), never blended again.
  const bias = media.stretch !== undefined ? (0.25 * tpf) / TICKS_PER_SECOND : 0;
  const seconds = (i: number) => {
    const raw = (frameSource(c, tpf, i) / TICKS_PER_SECOND - offset) * stretch + bias;
    // Past a copy's last frame MLT has no picture and shows whatever it read before.
    const t = media.last !== undefined ? Math.min(raw, media.last + bias) : raw;
    const r = Math.round(t * 1e6) / 1e6;
    return offset ? Math.max(0, r) : r;
  };
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
  return `<chain id="${id}" out="${n + span.head + span.tail - 1}">${prop('mlt_service', 'avformat')}${prop('resource', path)}${prop(only, -1)}${prop('seekable', 1)}<link>${prop('mlt_service', 'timeremap')}${prop('time_map', map)}${prop('image_mode', c.speed?.interpolate === 'blend' && media.stretch === undefined ? 'blend' : 'nearest')}${prop('pitch', pitch)}</link></chain>`;
}

/** Keyframes "key=value;..." keeping only the corners of straight runs; one value if constant. */
function curve(points: Array<[number, number]>): string | undefined {
  if (!points.length) return undefined;
  const first = points[0]?.[1];
  if (points.every((p) => p[1] === first)) return String(first);
  const kept = points.filter((p, i) => {
    const a = points[i - 1];
    const b = points[i + 1];
    return !a || !b || Math.abs(p[1] - (a[1] + b[1]) / 2) > 0.005;
  });
  return kept.map(([k, v]) => `${k}=${v}`).join(';');
}

/**
 * Volume and pan for an audio clip over its render span: gain (dB, keyframed on the source),
 * fades and transition crossfades combined into one level curve; keys are producer positions.
 */
function audioFilters(
  c: StoredClip,
  tpf: number,
  n: number,
  span: RenderSpan,
  keyBase: number,
  effects: Effect[],
): string {
  const fadeIn = c.fade?.in ? Math.round(c.fade.in / tpf) : 0;
  const fadeOut = c.fade?.out ? Math.round(c.fade.out / tpf) : 0;
  const levels: Array<[number, number]> = [];
  for (let i = -span.head; i < n + span.tail; i++) {
    const t = frameSource(c, tpf, i);
    let g = crossfadeGain(effects, i);
    if (fadeIn && i < fadeIn) g *= Math.max(0, (i + 0.5) / fadeIn);
    if (fadeOut && i >= n - fadeOut) g *= Math.max(0, (n - i - 0.5) / fadeOut);
    const db = sample(c.gain, 0, t) + (g <= 0 ? -100 : 20 * Math.log10(g));
    levels.push([keyBase + i, Math.max(-100, Math.round(db * 100) / 100)]);
  }
  const level = curve(levels);
  return [
    level && level !== '0'
      ? `<filter>${prop('mlt_service', 'volume')}${prop('level', level)}</filter>`
      : '',
    // panner's balance: start 0 is full left, 1 full right (its animated `split` is ignored
    // in MLT 7.30, so pan is a constant).
    c.pan
      ? `<filter>${prop('mlt_service', 'panner')}${prop('channel', -1)}${prop('start', Math.round(((c.pan + 1) / 2) * 1000) / 1000)}</filter>`
      : '',
  ].join('');
}

/** Master gain and limiter on the top-level mix. */
function masterFilters(doc: TimelineDoc): string {
  const m = doc.master;
  if (!m) return '';
  const gain = m.gain
    ? `<filter>${prop('mlt_service', 'volume')}${prop('level', m.gain)}</filter>`
    : '';
  const limit =
    m.limit !== undefined
      ? `<filter>${prop('mlt_service', 'avfilter.alimiter')}${prop('av.limit', Math.round(10 ** (m.limit / 20) * 10_000) / 10_000)}${prop('av.level', 0)}${prop('av.attack', 5)}${prop('av.release', 50)}</filter>`
      : '';
  return gain + limit;
}

/** Flip, crop, mask, transition-reveal and corner-pin filters on a clip's playlist entry. */
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
  // Last, so crop and mask cut the picture before it is warped; "12" keeps the rest clear.
  const corners = cornerParams(c, tpf, n, span, keyBase);
  if (corners) {
    parts.push(
      `<filter>${prop('mlt_service', 'frei0r.c0rners')}${corners.map((v, i) => prop(String(i), v)).join('')}${prop('12', 1)}</filter>`,
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
  // Imported fonts the text uses, gathered where libass looks for them.
  const fonts = [...options.sources].filter(([, src]) => src.family);
  let fontsDir: string | undefined;
  if (fonts.length) {
    fontsDir = join(dir, 'fonts');
    await mkdir(fontsDir);
    for (const [id, src] of fonts)
      await symlink(src.path, join(fontsDir, `${id}${extname(src.path) || '.ttf'}`));
  }
  const files = new Map<string, string>();
  const measure = options.measure ?? (await textMeasures(doc, options.sources));
  await writeFile(
    join(dir, 'timeline.mlt'),
    compileMlt(doc, {
      ...options,
      files,
      ...(fontsDir ? { fontsDir } : {}),
      ...(measure ? { measure } : {}),
    }),
  );
  for (const [name, content] of files) await writeFile(join(dir, name), content);
  // melt ignores in/out on the root tractor; the range is applied as producer arguments.
  const range = options.range ? [`in=${options.range.start}`, `out=${options.range.end - 1}`] : [];
  return ['-profile', join(dir, 'profile'), 'timeline.mlt', ...range];
}

/** The face of a text that breaks its own lines, keyed as the widths are looked up. */
const textFaceKey = (f: TextFace) =>
  f.mediaId
    ? `media:${f.mediaId}|${f.bold}|${f.italic}`
    : faceKey({ family: f.font, bold: f.bold, italic: f.italic });

/**
 * Loads the character widths of every face that text with max_lines is set in (the timeline's
 * and its nested timelines'), so the compiler can break its lines; undefined when none has.
 */
async function textMeasures(
  doc: TimelineDoc,
  sources: Map<string, MltSource>,
): Promise<AssOptions['measure']> {
  const faces = new Map<string, TextFace>();
  const docs = [doc, ...Object.values(doc.nested ?? {})];
  for (const d of docs)
    for (const t of d.tracks)
      for (const c of t.clips) {
        if (c.type !== 'title' && c.type !== 'caption') continue;
        const style = { ...TEXT_DEFAULTS[c.type], ...c.style };
        if (!style.max_lines) continue;
        const mediaId = style.font_media_id;
        const family = mediaId ? sources.get(mediaId)?.family : undefined;
        const font = (family ?? style.font ?? 'Inter').replace(/,/g, ' ');
        const add = (bold: boolean, italic: boolean) => {
          const face = { font, bold, italic, ...(family ? { mediaId } : {}) };
          faces.set(textFaceKey(face), face);
        };
        add(Boolean(style.bold), Boolean(style.italic));
        for (const sp of c.spans ?? [])
          add(sp.bold ?? Boolean(style.bold), sp.italic ?? Boolean(style.italic));
      }
  if (!faces.size) return undefined;
  const loaded = new Map<string, Measure>();
  for (const [key, f] of faces) {
    const file = f.mediaId ? sources.get(f.mediaId)?.path : undefined;
    try {
      loaded.set(key, await loadFace({ family: f.font, bold: f.bold, italic: f.italic, file }));
    } catch (e) {
      throw new CfError(
        'render_failed',
        `Could not read the widths of font ${f.font} to break lines by`,
        {
          hint: 'Set font to one at video://catalog/fonts, or import the font file with media.import',
          detail: { reason: e instanceof Error ? e.message : String(e) },
        },
      );
    }
  }
  return (face) => loaded.get(textFaceKey(face));
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
