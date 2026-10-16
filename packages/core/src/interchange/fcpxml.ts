import { TICKS_PER_SECOND, type TimelineDoc } from '@cuttingfloor/schema';
import { transitionHalves } from '../edit.ts';
import {
  type FlatClip,
  type FlatTrack,
  firstValue,
  flatten,
  type InterchangeMedia,
  type InterchangeMediaResolver,
  type InterchangeResult,
  isDropFrame,
  isPlaying,
  type MediaClip,
  mediaName,
  mediaUrl,
  noteDocument,
  noteDropped,
  playback,
  rationalSeconds,
  sameCut,
  type TextClip,
  transitionsInto,
  Warnings,
} from './common.ts';

// Final Cut Pro XML 1.10. The lowest video track in use is the primary storyline (the spine);
// higher video tracks are connected clips on lanes 1, 2, ... and audio tracks on lanes -1,
// -2, .... Connected clips hang off the spine item under their start, offset in its local time.

const XML_INVALID = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

/** Escapes text for XML content and attribute values, dropping characters XML can't hold. */
export function xmlEscape(s: string): string {
  return s
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Ticks as an FCPXML time: `0s`, `5s`, `1001/30000s`. */
export function fcpTime(ticks: number): string {
  const [n, d] = rationalSeconds(Math.round(ticks));
  return d === 1 ? `${n}s` : `${n}/${d}s`;
}

type Attrs = Record<string, string | number | undefined>;

function attrs(a: Attrs): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
    .join('');
}

function element(name: string, a: Attrs, body: string[] = []): string {
  if (!body.length) return `<${name}${attrs(a)}/>`;
  return `<${name}${attrs(a)}>${body.join('')}</${name}>`;
}

const fmtNumber = (n: number) => String(Math.round(n * 1e6) / 1e6);

const AUDIO_RATES: Record<number, string> = {
  32000: '32k',
  44100: '44.1k',
  48000: '48k',
  88200: '88.2k',
  96000: '96k',
  176400: '176.4k',
  192000: '192k',
};

const CROSS_DISSOLVE = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265';
const AUDIO_CROSSFADE = 'FFAudioTransition';
const BASIC_TITLE =
  '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti';

interface SpineItem {
  offset: number;
  duration: number;
  /** Local time at the item's start: connected clips are offset from it. */
  local: number;
  render: (children: string[]) => string;
  children: Array<{ at: number; xml: string }>;
}

/** Writes the timeline as FCPXML 1.10. */
export function toFcpxml(doc: TimelineDoc, resolve: InterchangeMediaResolver): InterchangeResult {
  const w = new Warnings();
  noteDocument(doc, w);
  const { tracks, media, tpf } = flatten(doc, w);
  const seq = doc.sequence;

  // ------------------------------------------------------------------ resources
  const resources: string[] = [];
  let nextId = 1;
  const rid = () => `r${nextId++}`;
  const seqFormat = rid();
  resources.push(
    element('format', {
      id: seqFormat,
      frameDuration: fcpTime(tpf),
      width: seq.width,
      height: seq.height,
      colorSpace: '1-1-1 (Rec. 709)',
    }),
  );
  const assets = new Map<
    string,
    { id: string; m: InterchangeMedia; video: boolean; audio: boolean; still: boolean }
  >();
  const effects = new Map<string, string>();
  const effect = (name: string, uid: string) => {
    let id = effects.get(uid);
    if (!id) {
      id = rid();
      effects.set(uid, id);
      resources.push(element('effect', { id, name, uid }));
    }
    return id;
  };
  const asset = (c: MediaClip) => {
    const known = assets.get(c.media_id);
    if (known) return known;
    const m = resolve(c.media_id);
    if (!m) return undefined;
    const ref = media[c.media_id];
    const hasVideo = ref ? ref.video : !!m.width;
    const hasAudio = ref ? ref.audio : !!m.channels;
    const duration = m.duration ?? ref?.duration ?? null;
    const id = rid();
    let format: string | undefined;
    if (hasVideo) {
      const same =
        (!m.width || m.width === seq.width) &&
        (!m.height || m.height === seq.height) &&
        (!m.fps || (m.fps.num === seq.fps.num && m.fps.den === seq.fps.den));
      if (same && duration !== null) format = seqFormat;
      else {
        format = rid();
        const fps = m.fps ?? seq.fps;
        resources.push(
          element('format', {
            id: format,
            // Stills have no frame rate.
            frameDuration:
              duration === null ? undefined : fcpTime((TICKS_PER_SECOND * fps.den) / fps.num),
            width: m.width ?? seq.width,
            height: m.height ?? seq.height,
            colorSpace: '1-1-1 (Rec. 709)',
          }),
        );
      }
    }
    const name = mediaName(c.media_id, m, media);
    resources.push(
      element(
        'asset',
        {
          id,
          name,
          start: '0s',
          duration: fcpTime(duration ?? 0),
          hasVideo: hasVideo ? 1 : undefined,
          hasAudio: hasAudio ? 1 : undefined,
          format,
          videoSources: hasVideo ? 1 : undefined,
          audioSources: hasAudio ? 1 : undefined,
          audioChannels: hasAudio ? (m.channels ?? seq.channels) : undefined,
          audioRate: hasAudio ? (m.sample_rate ?? seq.audio_rate) : undefined,
        },
        [element('media-rep', { kind: 'original-media', src: mediaUrl(m.path) })],
      ),
    );
    const entry = { id, m, video: hasVideo, audio: hasAudio, still: duration === null };
    assets.set(c.media_id, entry);
    return entry;
  };

  // ------------------------------------------------------------------ clip elements
  let styleId = 1;
  const playing = tracks.filter((t) => {
    if (isPlaying(t)) return true;
    if (t.clips.some((c) => c.enabled))
      w.add(`${t.kind === 'video' ? 'Hidden' : 'Muted'} tracks were left out`, t.name);
    return false;
  });
  const videoTracks = playing.filter((t) => t.kind === 'video');
  const audioTracks = playing.filter((t) => t.kind === 'audio');
  const consumed = new Set<string>();
  // Sound of a video clip: its linked audio clip on an audio track, cut identically.
  const pairOf = (v: FlatClip): FlatClip | undefined => {
    for (const t of audioTracks) {
      const a = t.clips.find((x) => !consumed.has(x.id) && sameCut(v, x));
      if (a) return a;
    }
    return undefined;
  };

  const videoAdjust = (c: FlatClip): string[] => {
    const t = c.transform;
    if (!t) return [];
    const out: string[] = [];
    const x = firstValue(t.x);
    const y = firstValue(t.y);
    const scale = firstValue(t.scale) ?? 1;
    const sx = scale * (firstValue(t.scale_x) ?? 1);
    const sy = scale * (firstValue(t.scale_y) ?? 1);
    const rotation = firstValue(t.rotation);
    if (x !== undefined || y !== undefined || sx !== 1 || sy !== 1 || rotation !== undefined) {
      // FCP positions are percentages of the frame height from the centre, y up; rotation is
      // counter-clockwise.
      const px = ((x ?? 0.5) - 0.5) * (seq.width / seq.height) * 100;
      const py = (0.5 - (y ?? 0.5)) * 100;
      out.push(
        element('adjust-transform', {
          position: `${fmtNumber(px)} ${fmtNumber(py)}`,
          scale: `${fmtNumber(sx)} ${fmtNumber(sy)}`,
          rotation: rotation === undefined ? undefined : fmtNumber(-rotation),
        }),
      );
    }
    const opacity = firstValue(t.opacity);
    if (opacity !== undefined && opacity !== 1)
      out.push(element('adjust-blend', { amount: fmtNumber(opacity) }));
    return out;
  };
  const audioAdjust = (c: FlatClip | undefined): string[] => {
    const gain = firstValue(c?.gain);
    return gain === undefined || gain === 0
      ? []
      : [element('adjust-volume', { amount: `${fmtNumber(gain)}dB` })];
  };

  /** Media clip as an element at `offset`; `local` is the start of its local time. */
  const mediaElement = (
    c: MediaClip,
    lane: number | undefined,
  ): { local: number; audio: boolean; render: (children: string[]) => string } | undefined => {
    const a = asset(c);
    if (!a) {
      w.add('Clips whose media could not be found were left out', c.id);
      return undefined;
    }
    const isVideo = c.kind === 'video';
    const sound = isVideo && a.audio ? pairOf(c) : undefined;
    if (sound) consumed.add(sound.id);
    noteDropped(c, w, { staticTransform: isVideo, staticGain: !isVideo });
    if (sound) noteDropped(sound, w, { staticGain: true });
    // Picture and sound together, or the asset has only the one: the whole asset. Otherwise
    // just the picture (video) or just the sound (audio) of it.
    const whole = a.still ? false : sound !== undefined || (isVideo ? !a.audio : !a.video);
    const tag = whole ? 'asset-clip' : isVideo ? 'video' : 'audio';
    const p = playback(c, tpf);
    const retimed = p.rate !== 1 || p.reverse;
    const local = retimed ? 0 : c.in;
    const body: string[] = [];
    if (retimed) {
      const from = p.reverse ? c.in + p.span : c.in;
      const to = p.rate === 0 ? from : p.reverse ? c.in : c.in + p.span;
      body.push(
        element('timeMap', {}, [
          element('timept', { time: '0s', value: fcpTime(from), interp: 'linear' }),
          element('timept', { time: fcpTime(c.duration), value: fcpTime(to), interp: 'linear' }),
        ]),
      );
    }
    if (isVideo) body.push(...videoAdjust(c));
    body.push(...audioAdjust(isVideo ? sound : c));
    return {
      local,
      audio: tag === 'audio' || (tag === 'asset-clip' && a.audio),
      render: (children) =>
        element(
          tag,
          {
            ref: a.id,
            lane,
            offset: '',
            name: mediaName(c.media_id, a.m, media),
            start: fcpTime(local),
            duration: fcpTime(c.duration),
            role: tag === 'audio' ? 'dialogue' : undefined,
          },
          [...body, ...children],
        ),
    };
  };

  const textElement = (c: TextClip, lane: number | undefined): string => {
    noteDropped(c, w, { staticTransform: true });
    const id = `ts${styleId++}`;
    const style = element('text-style', { ref: id }, [xmlEscape(c.text)]);
    if (c.type === 'caption') {
      if (c.style) w.add('Caption styling was dropped', c.id);
      if (c.words?.length) w.add('Caption word timings were dropped', c.id);
      return element(
        'caption',
        {
          lane,
          offset: '',
          name: c.text.split('\n')[0],
          start: fcpTime(c.in),
          duration: fcpTime(c.duration),
          role: 'iTT?captionFormat=ITT.en',
        },
        [
          element('text', { placement: 'bottom' }, [style]),
          element('text-style-def', { id }, [
            element('text-style', {
              font: '.AppleSystemUIFont',
              fontSize: 13,
              fontFace: 'Regular',
              fontColor: '1 1 1 1',
              backgroundColor: '0 0 0 1',
            }),
          ]),
        ],
      );
    }
    w.add('Title styling was dropped; titles use a basic text style', c.id);
    return element(
      'title',
      {
        ref: effect('Basic Title', BASIC_TITLE),
        lane,
        offset: '',
        name: c.text.split('\n')[0],
        start: fcpTime(c.in),
        duration: fcpTime(c.duration),
      },
      [
        ...videoAdjust(c),
        element('text', {}, [style]),
        element('text-style-def', { id }, [
          element('text-style', {
            font: 'Helvetica',
            fontSize: 63,
            fontColor: '1 1 1 1',
            alignment: 'center',
          }),
        ]),
      ],
    );
  };

  // Offsets are filled in when an element is placed: `offset=""` is replaced below.
  const at = (xml: string, offset: string) => xml.replace(' offset=""', ` offset="${offset}"`);

  // ------------------------------------------------------------------ the spine
  const primaryIndex = videoTracks.findIndex((t) =>
    t.clips.some((c) => c.enabled && (c.type === 'media' || c.type === 'title')),
  );
  const primary: FlatTrack | undefined = videoTracks[primaryIndex];
  const total = Math.max(
    0,
    ...playing.map((t) =>
      t.clips.reduce((m, c) => (c.enabled ? Math.max(m, c.start + c.duration) : m), 0),
    ),
  );
  const spine: SpineItem[] = [];
  const spineGap = (offset: number, duration: number): SpineItem => ({
    offset,
    duration,
    local: 0,
    children: [],
    render: (children) =>
      element(
        'gap',
        { name: 'Gap', offset: fcpTime(offset), start: '0s', duration: fcpTime(duration) },
        children,
      ),
  });
  const spineTransitions = new Map<number, string>();
  const connectedLater: Array<{ c: FlatClip; lane: number }> = [];
  if (primary) {
    const into = transitionsInto(primary);
    let cursor = 0;
    let previous: { id: string; audio: boolean } | undefined;
    for (const c of primary.clips) {
      if (!c.enabled) continue;
      if (c.type === 'caption') {
        connectedLater.push({ c, lane: videoTracks.length });
        continue;
      }
      if (c.type === 'adjustment') {
        w.add('Adjustment clips were dropped', c.id);
        continue;
      }
      let made:
        | { local: number; audio: boolean; render: (children: string[]) => string }
        | undefined;
      if (c.type === 'media') made = mediaElement(c, undefined);
      else {
        const xml = textElement(c, undefined);
        made = {
          local: c.in,
          audio: false,
          render: (ch) => xml.replace(/<\/title>$/, `${ch.join('')}</title>`),
        };
      }
      if (!made) continue;
      if (c.start > cursor) {
        spine.push(spineGap(cursor, c.start - cursor));
        previous = undefined;
      }
      const tr = into.get(c.id);
      if (tr) {
        if (tr.a === previous?.id) {
          const { before, after } = transitionHalves(tr.duration, tpf);
          if (tr.kind !== 'dissolve')
            w.add('Transitions other than dissolves became cross dissolves', tr.id);
          const body = [
            element('filter-video', {
              ref: effect('Cross Dissolve', CROSS_DISSOLVE),
              name: 'Cross Dissolve',
            }),
          ];
          if (previous.audio && made.audio)
            body.push(
              element('filter-audio', {
                ref: effect('Audio Crossfade', AUDIO_CROSSFADE),
                name: 'Audio Crossfade',
              }),
            );
          spineTransitions.set(
            spine.length,
            element(
              'transition',
              {
                name: 'Cross Dissolve',
                offset: fcpTime(c.start - before),
                duration: fcpTime(before + after),
              },
              body,
            ),
          );
        } else w.add('Transitions next to clips that were left out were dropped', tr.id);
      }
      const offset = c.start;
      const render = made.render;
      spine.push({
        offset,
        duration: c.duration,
        local: made.local,
        children: [],
        render: (children) => at(render(children), fcpTime(offset)),
      });
      previous = { id: c.id, audio: made.audio };
      cursor = c.start + c.duration;
    }
    if (total > cursor) spine.push(spineGap(cursor, total - cursor));
  } else if (total > 0) {
    spine.push(spineGap(0, total));
  }

  const attach = (start: number, xml: string) => {
    const host =
      spine.find((s) => start >= s.offset && start < s.offset + s.duration) ??
      spine[spine.length - 1];
    if (!host) return;
    host.children.push({ at: start, xml: at(xml, fcpTime(host.local + (start - host.offset))) });
  };

  // ------------------------------------------------------------------ connected clips
  const connect = (c: FlatClip, lane: number) => {
    if (!c.enabled || consumed.has(c.id)) return;
    if (c.type === 'adjustment') {
      w.add('Adjustment clips were dropped', c.id);
      return;
    }
    if (c.type === 'media') {
      const e = mediaElement(c, lane);
      if (e) attach(c.start, e.render([]));
    } else attach(c.start, textElement(c, lane));
  };
  // Tracks below the primary storyline hold nothing it could show (captions at most).
  videoTracks.forEach((t, i) => {
    if (i === primaryIndex) return;
    for (const c of t.clips) connect(c, i > primaryIndex ? i - primaryIndex : videoTracks.length);
    for (const tr of t.transitions ?? [])
      w.add('Transitions outside the primary storyline were dropped', tr.id);
  });
  for (const { c, lane } of connectedLater) connect(c, lane);
  // Primary-track sound pairs were consumed while building the spine; the rest connect below.
  audioTracks.forEach((t, i) => {
    const into = transitionsInto(t);
    for (const c of t.clips) {
      const tr = into.get(c.id);
      if (tr && !consumed.has(c.id))
        w.add('Transitions outside the primary storyline were dropped', tr.id);
      connect(c, -(i + 1));
    }
  });

  // ------------------------------------------------------------------ document
  const spineXml: string[] = [];
  spine.forEach((s, i) => {
    const tr = spineTransitions.get(i);
    if (tr) spineXml.push(tr);
    s.children.sort((a, b) => a.at - b.at);
    spineXml.push(s.render(s.children.map((ch) => ch.xml)));
  });
  const layout = seq.channels === 1 ? 'mono' : seq.channels === 2 ? 'stereo' : 'surround';
  const sequence = element(
    'sequence',
    {
      format: seqFormat,
      duration: fcpTime(total),
      tcStart: '0s',
      tcFormat: isDropFrame(seq.fps) ? 'DF' : 'NDF',
      audioLayout: layout,
      audioRate: AUDIO_RATES[seq.audio_rate] ?? '48k',
    },
    [element('spine', {}, spineXml)],
  );
  if (!AUDIO_RATES[seq.audio_rate]) w.add(`Audio rate ${seq.audio_rate} Hz was written as 48 kHz`);
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    `<fcpxml version="1.10">`,
    `<resources>${resources.join('')}</resources>`,
    `<library>${element('event', { name: doc.name }, [element('project', { name: doc.name }, [sequence])])}</library>`,
    '</fcpxml>',
    '',
  ];
  return { text: body.join('\n'), warnings: w.list() };
}
