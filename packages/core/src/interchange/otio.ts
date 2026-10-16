import type { TimelineDoc } from '@cuttingfloor/schema';
import { transitionHalves } from '../edit.ts';
import {
  type FlatClip,
  type FlatTrack,
  flatten,
  type InterchangeMediaResolver,
  type InterchangeResult,
  mediaName,
  mediaUrl,
  noteDocument,
  noteDropped,
  playback,
  transitionsInto,
  Warnings,
} from './common.ts';

// OpenTimelineIO JSON (.otio), schema as written by OTIO 0.17/0.18: Timeline.1 > Stack.1 >
// Track.1 > Clip.2 | Gap.1 | Transition.1. Times are RationalTime.1 at the sequence rate.

type Json = { [key: string]: unknown };

function rationalTime(value: number, rate: number): Json {
  return { OTIO_SCHEMA: 'RationalTime.1', rate, value };
}

function timeRange(start: number, duration: number, rate: number): Json {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    duration: rationalTime(duration, rate),
    start_time: rationalTime(start, rate),
  };
}

const item = (schema: string, name: string, extra: Json): Json => ({
  OTIO_SCHEMA: schema,
  metadata: {},
  name,
  ...extra,
});

/** Writes the timeline as OpenTimelineIO JSON. Disabled clips stay, with `enabled: false`. */
export function toOtio(doc: TimelineDoc, resolve: InterchangeMediaResolver): InterchangeResult {
  const w = new Warnings();
  noteDocument(doc, w);
  const { tracks, media, tpf } = flatten(doc, w);
  const fps = doc.sequence.fps;
  const rate = fps.num / fps.den;
  // Sequence frames; non-integer when a source position isn't on the sequence grid.
  const f = (ticks: number) => ticks / tpf;

  const gap = (ticks: number): Json =>
    item('Gap.1', '', {
      source_range: timeRange(0, f(ticks), rate),
      effects: [],
      markers: [],
      enabled: true,
    });

  const clipItem = (c: FlatClip): Json => {
    const meta: Json = { cuttingfloor: { clip_id: c.id, type: c.type } };
    if (c.type === 'adjustment') {
      w.add('Adjustment clips became gaps', c.id);
      return gap(c.duration);
    }
    noteDropped(c, w);
    let name: string;
    let reference: Json;
    const effects: Json[] = [];
    let start = c.in;
    if (c.type === 'media') {
      const m = resolve(c.media_id);
      if (!m) {
        w.add('Clips whose media could not be found became gaps', c.id);
        return gap(c.duration);
      }
      name = mediaName(c.media_id, m, media);
      (meta.cuttingfloor as Json).media_id = c.media_id;
      const duration = m.duration ?? media[c.media_id]?.duration;
      reference = item('ExternalReference.1', name, {
        available_range: duration ? timeRange(0, f(duration), rate) : null,
        available_image_bounds: null,
        target_url: mediaUrl(m.path),
      });
      const p = playback(c, tpf);
      start = p.first;
      if (p.rate === 0) {
        effects.push(
          item('FreezeFrame.1', '', { effect_name: 'FreezeFrame', enabled: true, time_scalar: 0 }),
        );
      } else if (p.rate !== 1 || p.reverse) {
        effects.push(
          item('LinearTimeWarp.1', '', {
            effect_name: 'LinearTimeWarp',
            enabled: true,
            time_scalar: p.reverse ? -p.rate : p.rate,
          }),
        );
      }
    } else {
      name = c.text.split('\n')[0] ?? '';
      w.add(
        'Titles and captions became generator references carrying only their text; styling and rendering do not carry over',
        c.id,
      );
      if (c.type === 'caption' && c.words?.length)
        (meta.cuttingfloor as Json).words = c.words.map((x) => ({
          text: x.text,
          start: f(x.t - c.in),
          end: f(x.end - c.in),
        }));
      reference = item('GeneratorReference.1', name, {
        available_range: null,
        available_image_bounds: null,
        generator_kind: c.type === 'title' ? 'Title' : 'Caption',
        parameters: { text: c.text },
      });
    }
    return {
      OTIO_SCHEMA: 'Clip.2',
      metadata: meta,
      name,
      source_range: timeRange(f(start), f(c.duration), rate),
      effects,
      markers: [],
      enabled: c.enabled,
      media_references: { DEFAULT_MEDIA: reference },
      active_media_reference_key: 'DEFAULT_MEDIA',
    };
  };

  const trackItem = (t: FlatTrack): Json => {
    const children: Json[] = [];
    const into = transitionsInto(t);
    let at = 0;
    let previous: string | undefined;
    for (const c of t.clips) {
      if (c.start > at) {
        children.push(gap(c.start - at));
        previous = undefined;
      }
      const tr = into.get(c.id);
      if (tr && tr.a === previous) {
        const { before, after } = transitionHalves(tr.duration, tpf);
        const dissolve = tr.kind === 'dissolve' || tr.kind === 'crossfade';
        if (!dissolve) w.add('Transitions other than dissolves were written as custom', tr.id);
        children.push(
          item('Transition.1', tr.kind, {
            metadata: { cuttingfloor: { transition_id: tr.id, kind: tr.kind } },
            transition_type: dissolve ? 'SMPTE_Dissolve' : 'Custom_Transition',
            in_offset: rationalTime(f(before), rate),
            out_offset: rationalTime(f(after), rate),
          }),
        );
      }
      children.push(clipItem(c));
      previous = c.id;
      at = c.start + c.duration;
    }
    return item('Track.1', t.name, {
      metadata: { cuttingfloor: { track_id: t.id } },
      source_range: null,
      effects: [],
      markers: [],
      enabled: t.kind === 'video' ? !t.hidden : !t.muted,
      children,
      kind: t.kind === 'video' ? 'Video' : 'Audio',
    });
  };

  const timeline = {
    OTIO_SCHEMA: 'Timeline.1',
    metadata: {
      cuttingfloor: {
        sequence: doc.sequence,
      },
    },
    name: doc.name,
    global_start_time: rationalTime(0, rate),
    tracks: item('Stack.1', 'tracks', {
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      children: tracks.map(trackItem),
    }),
  };
  return { text: `${JSON.stringify(timeline, null, 4)}\n`, warnings: w.list() };
}
