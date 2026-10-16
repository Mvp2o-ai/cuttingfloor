import {
  fcpTime,
  framesToTicks,
  type InterchangeMedia,
  type InterchangeMediaResolver,
  newTimeline,
  parseSubtitles,
  runEdits,
  timecode,
  toEdl,
  toFcpxml,
  toOtio,
  toSrt,
  toVtt,
  writeInterchange,
  xmlEscape,
} from '@cuttingfloor/core';
import type {
  FrameRate,
  MediaRef,
  NestedDoc,
  StoredClip,
  StoredTrack,
  StoredTransition,
  TimelineDoc,
} from '@cuttingfloor/schema';
import { describe, expect, it } from 'vitest';

const NTSC: FrameRate = { num: 30000, den: 1001 };
const PAL: FrameRate = { num: 25, den: 1 };

const AV = 'm_aaaaaaaaaaaaaaaaaaaaaaaaav';
const VID = 'm_aaaaaaaaaaaaaaaaaaaaaaavid';
const AUD = 'm_aaaaaaaaaaaaaaaaaaaaaaaaud';

const files: Record<string, InterchangeMedia> = {
  [AV]: { name: 'Interview A&B.mov', path: '/media/Interview A&B.mov', channels: 2 },
  [VID]: { name: 'b-roll.mp4', path: 'media/b roll.mp4', width: 1920, height: 1080 },
  [AUD]: { name: 'music.wav', path: '/media/music.wav', channels: 2, sample_rate: 48_000 },
};
const resolve: InterchangeMediaResolver = (id) => files[id];

function refs(fps: FrameRate): Record<string, MediaRef> {
  return {
    [AV]: {
      name: 'Interview A&B.mov',
      duration: framesToTicks(3000, fps),
      video: true,
      audio: true,
    },
    [VID]: { name: 'b-roll.mp4', duration: framesToTicks(600, fps), video: true, audio: false },
    [AUD]: { name: 'music.wav', duration: framesToTicks(6000, fps), video: false, audio: true },
  };
}

interface ClipOpts {
  link?: string;
  enabled?: boolean;
  speed?: StoredClip['speed'];
  extra?: Partial<StoredClip>;
}

/** A media clip with times in frames. */
function media(
  fps: FrameRate,
  id: string,
  kind: 'video' | 'audio',
  mediaId: string,
  start: number,
  inF: number,
  duration: number,
  o: ClipOpts = {},
): StoredClip {
  const t = (f: number) => framesToTicks(f, fps);
  return {
    id,
    type: 'media',
    kind,
    media_id: mediaId,
    start: t(start),
    in: t(inF),
    duration: t(duration),
    link: o.link ?? null,
    enabled: o.enabled ?? true,
    ...(o.speed ? { speed: o.speed } : {}),
    ...(o.extra as object),
  } as StoredClip;
}

function text(
  fps: FrameRate,
  id: string,
  type: 'title' | 'caption',
  body: string,
  start: number,
  duration: number,
  extra: Partial<StoredClip> = {},
): StoredClip {
  return {
    id,
    type,
    kind: 'video',
    text: body,
    start: framesToTicks(start, fps),
    in: 0,
    duration: framesToTicks(duration, fps),
    link: null,
    enabled: true,
    ...(extra as object),
  } as StoredClip;
}

function track(
  id: string,
  kind: 'video' | 'audio',
  name: string,
  clips: StoredClip[],
  extra: Partial<StoredTrack> = {},
): StoredTrack {
  return { id, kind, name, muted: false, hidden: false, locked: false, clips, ...extra };
}

function document(fps: FrameRate, tracks: StoredTrack[], extra: Partial<TimelineDoc> = {}) {
  const doc: TimelineDoc = {
    format: 'cuttingfloor.timeline',
    version: 2,
    name: 'Cut <one> & "two"',
    sequence: { width: 1920, height: 1080, fps, audio_rate: 48_000, channels: 2, color: 'bt709' },
    tracks,
    media: refs(fps),
    next_id: 100,
    parent: null,
    op: null,
    ...extra,
  };
  return doc;
}

const dissolve = (a: string, b: string, frames: number, fps: FrameRate): StoredTransition => ({
  id: `x_${a}_${b}`,
  a,
  b,
  kind: 'dissolve',
  duration: framesToTicks(frames, fps),
});

// ---------------------------------------------------------------------------- a tiny XML parser

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi;
const decode = (s: string) =>
  s.replace(ENTITY, (_, e: string) =>
    e.startsWith('#')
      ? String.fromCodePoint(
          e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
        )
      : (({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e] ?? ''),
  );

/** Parses well-formed XML strictly enough for tests; throws on anything malformed. */
function parseXml(xml: string): XmlNode {
  let s = xml.replace(/^<\?xml[^?]*\?>\s*/, '').replace(/^<!DOCTYPE [a-z]+>\s*/i, '');
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const checkText = (t: string) => {
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(t)) throw new Error(`Bare & in ${t}`);
    if (t.includes('>')) throw new Error(`Bare > in text ${t}`);
  };
  while (s.length) {
    const lt = s.indexOf('<');
    const chunk = lt < 0 ? s : s.slice(0, lt);
    checkText(chunk);
    (stack[stack.length - 1] as XmlNode).text += decode(chunk);
    if (lt < 0) break;
    s = s.slice(lt);
    const m = /^<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/.exec(s);
    if (!m) throw new Error(`Malformed tag at ${s.slice(0, 60)}`);
    const [whole, close, name, rawAttrs, selfClose] = m as unknown as string[];
    s = s.slice((whole as string).length);
    if (close) {
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`</${name}> closes <${open?.name}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs as string).matchAll(/([\w:.-]+)="([^"]*)"/g)) {
      const [, k, v] = a as unknown as [string, string, string];
      if (k in attrs) throw new Error(`Duplicate attribute ${k}`);
      checkText(v);
      attrs[k] = decode(v);
    }
    const node: XmlNode = { name: name as string, attrs, children: [], text: '' };
    (stack[stack.length - 1] as XmlNode).children.push(node);
    if (!selfClose) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1]?.name}>`);
  if (root.children.length !== 1) throw new Error('Expected one root element');
  return root.children[0] as XmlNode;
}

function all(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

function one(node: XmlNode, name: string): XmlNode {
  const found = all(node, name);
  expect(found, `<${name}>`).toHaveLength(1);
  return found[0] as XmlNode;
}

// ---------------------------------------------------------------------------- timing helpers

describe('timecode', () => {
  it('counts drop frame at 29.97 with a semicolon', () => {
    expect(timecode(0, NTSC)).toBe('00:00:00;00');
    expect(timecode(30, NTSC)).toBe('00:00:01;00');
    expect(timecode(1799, NTSC)).toBe('00:00:59;29');
    // Frame numbers 00 and 01 are skipped at each minute but every tenth.
    expect(timecode(1800, NTSC)).toBe('00:01:00;02');
    expect(timecode(17982, NTSC)).toBe('00:10:00;00');
    expect(timecode(107892, NTSC)).toBe('01:00:00;00');
  });

  it('drops four frame numbers a minute at 59.94', () => {
    const r = { num: 60000, den: 1001 };
    expect(timecode(3599, r)).toBe('00:00:59;59');
    expect(timecode(3600, r)).toBe('00:01:00;04');
    expect(timecode(35964, r)).toBe('00:10:00;00');
  });

  it('is non-drop at 23.976, 25 and 30', () => {
    expect(timecode(30, { num: 24000, den: 1001 })).toBe('00:00:01:06');
    expect(timecode(30, PAL)).toBe('00:00:01:05');
    expect(timecode(1800, { num: 30, den: 1 })).toBe('00:01:00:00');
  });
});

describe('fcpTime and xmlEscape', () => {
  it('writes reduced rational seconds', () => {
    expect(fcpTime(0)).toBe('0s');
    expect(fcpTime(framesToTicks(1, NTSC))).toBe('1001/30000s');
    expect(fcpTime(framesToTicks(30, NTSC))).toBe('1001/1000s');
    expect(fcpTime(framesToTicks(50, PAL))).toBe('2s');
    expect(fcpTime(framesToTicks(3, PAL))).toBe('3/25s');
  });

  it('escapes markup and drops characters XML cannot hold', () => {
    expect(xmlEscape(`a<b>&"c"'\u0001`)).toBe('a&lt;b&gt;&amp;&quot;c&quot;&apos;');
  });
});

// ---------------------------------------------------------------------------- OTIO

/** A 29.97 cut: a gap, an A/V clip at frame 30 dissolving into b-roll, music, a title on V2. */
function ntscCut(): TimelineDoc {
  const f = NTSC;
  return document(f, [
    track(
      't1',
      'video',
      'V1',
      [
        media(f, 'c1', 'video', AV, 30, 100, 60, { link: 'g1' }),
        media(f, 'c3', 'video', VID, 90, 10, 45),
      ],
      { transitions: [dissolve('c1', 'c3', 10, f)] },
    ),
    track('t2', 'video', 'V2', [
      text(f, 'c4', 'title', 'Hello <world> & "you"', 40, 30, {
        style: { font: 'Inter' },
      } as Partial<StoredClip>),
    ]),
    track('t3', 'audio', 'A1', [media(f, 'c2', 'audio', AV, 30, 100, 60, { link: 'g1' })]),
    track('t4', 'audio', 'A2', [media(f, 'c5', 'audio', AUD, 0, 0, 150)]),
  ]);
}

type Json = Record<string, unknown> & {
  children?: Json[];
  OTIO_SCHEMA?: string;
};

describe('toOtio', () => {
  it('writes a Timeline.1 of tracks with gaps, clips, transitions and file references', () => {
    const { text: out, warnings } = toOtio(ntscCut(), resolve);
    const tl = JSON.parse(out) as Json;
    expect(tl.OTIO_SCHEMA).toBe('Timeline.1');
    expect(tl.name).toBe('Cut <one> & "two"');
    const stack = tl.tracks as Json;
    expect(stack.OTIO_SCHEMA).toBe('Stack.1');
    const tracks = stack.children as Json[];
    expect(tracks.map((t) => [t.OTIO_SCHEMA, t.kind, t.name])).toEqual([
      ['Track.1', 'Video', 'V1'],
      ['Track.1', 'Video', 'V2'],
      ['Track.1', 'Audio', 'A1'],
      ['Track.1', 'Audio', 'A2'],
    ]);
    const v1 = tracks[0]?.children as Json[];
    expect(v1.map((c) => c.OTIO_SCHEMA)).toEqual(['Gap.1', 'Clip.2', 'Transition.1', 'Clip.2']);
    const rate = 30000 / 1001;
    expect(v1[0]?.source_range).toEqual({
      OTIO_SCHEMA: 'TimeRange.1',
      duration: { OTIO_SCHEMA: 'RationalTime.1', rate, value: 30 },
      start_time: { OTIO_SCHEMA: 'RationalTime.1', rate, value: 0 },
    });
    const c1 = v1[1] as Json;
    expect(c1.name).toBe('Interview A&B.mov');
    expect(c1.enabled).toBe(true);
    expect(c1.source_range).toEqual({
      OTIO_SCHEMA: 'TimeRange.1',
      duration: { OTIO_SCHEMA: 'RationalTime.1', rate, value: 60 },
      start_time: { OTIO_SCHEMA: 'RationalTime.1', rate, value: 100 },
    });
    expect(c1.active_media_reference_key).toBe('DEFAULT_MEDIA');
    const ref = (c1.media_references as Record<string, Json>).DEFAULT_MEDIA as Json;
    expect(ref.OTIO_SCHEMA).toBe('ExternalReference.1');
    expect(ref.target_url).toBe('file:///media/Interview%20A&B.mov');
    expect((ref.available_range as Json).duration).toEqual({
      OTIO_SCHEMA: 'RationalTime.1',
      rate,
      value: 3000,
    });
    // Relative paths stay relative, percent-encoded.
    const c3 = v1[3] as Json;
    expect(((c3.media_references as Record<string, Json>).DEFAULT_MEDIA as Json).target_url).toBe(
      'media/b%20roll.mp4',
    );
    expect(v1[2]).toMatchObject({
      OTIO_SCHEMA: 'Transition.1',
      transition_type: 'SMPTE_Dissolve',
      in_offset: { OTIO_SCHEMA: 'RationalTime.1', rate, value: 5 },
      out_offset: { OTIO_SCHEMA: 'RationalTime.1', rate, value: 5 },
    });
    // The title is a generator reference behind a gap.
    const v2 = tracks[1]?.children as Json[];
    expect(v2.map((c) => c.OTIO_SCHEMA)).toEqual(['Gap.1', 'Clip.2']);
    const title = ((v2[1] as Json).media_references as Record<string, Json>).DEFAULT_MEDIA as Json;
    expect(title).toMatchObject({
      OTIO_SCHEMA: 'GeneratorReference.1',
      generator_kind: 'Title',
      parameters: { text: 'Hello <world> & "you"' },
    });
    expect(warnings.some((x) => x.startsWith('Titles and captions became generator'))).toBe(true);
    // Audio-only track from frame 0: no leading gap.
    const a2 = tracks[3]?.children as Json[];
    expect(a2.map((c) => c.OTIO_SCHEMA)).toEqual(['Clip.2']);
  });

  it('writes constant speed, reverse and freeze as time effects, and keeps disabled clips', () => {
    const f = PAL;
    const doc = document(f, [
      track('t1', 'video', 'V1', [
        media(f, 'c1', 'video', VID, 0, 10, 20, { speed: { rate: 2 } }),
        media(f, 'c2', 'video', VID, 20, 100, 20, { speed: { rate: 0.5, reverse: true } }),
        media(f, 'c3', 'video', VID, 40, 50, 25, { speed: { rate: 0 } }),
        media(f, 'c4', 'video', VID, 65, 0, 10, { enabled: false }),
        media(f, 'c5', 'video', VID, 75, 0, 20, {
          speed: {
            curve: [
              { t: 0, rate: 1 },
              { t: framesToTicks(20, f), rate: 3 },
            ],
          },
        }),
      ]),
      track('t2', 'audio', 'A1', [], { muted: true }),
    ]);
    const { text: out, warnings } = toOtio(doc, resolve);
    const tracks = ((JSON.parse(out) as Json).tracks as Json).children as Json[];
    const clips = tracks[0]?.children as Json[];
    expect(
      clips.map((c) => (c.effects as Json[]).map((e) => [e.OTIO_SCHEMA, e.time_scalar])),
    ).toEqual([
      [['LinearTimeWarp.1', 2]],
      [['LinearTimeWarp.1', -0.5]],
      [['FreezeFrame.1', 0]],
      [],
      [['LinearTimeWarp.1', 2]],
    ]);
    // Reversed: the first frame shown is the last of the 10 source frames from 100 (109.5 is
    // inside source frame 109).
    const start = (c: Json | undefined) =>
      (((c as Json).source_range as Json).start_time as Json).value as number;
    expect(start(clips[1])).toBe(109.5);
    expect(start(clips[2])).toBe(50);
    expect(clips[3]?.enabled).toBe(false);
    expect(tracks[1]?.enabled).toBe(false);
    expect(warnings).toContain('Speed ramps became a constant speed at their average rate (c5)');
  });

  it('warns about compositing, effects and audio settings it drops', () => {
    const f = PAL;
    const doc = document(
      f,
      [
        track(
          't1',
          'video',
          'V1',
          [
            media(f, 'c1', 'video', VID, 0, 0, 25, {
              extra: {
                mask: { shape: 'ellipse' },
                blend: 'screen',
                transform: { scale: { keyframes: [{ t: 0, value: 1 }] } },
                effects: [{ id: 'e1', name: 'blur', params: {} }],
                animation: { in: { name: 'fade', duration: 100 } },
              },
            }),
          ],
          { effects: [{ id: 'e2', name: 'blur', params: {} }] },
        ),
        track('t2', 'audio', 'A1', [
          media(f, 'c2', 'audio', AUD, 0, 0, 25, {
            extra: { gain: -6, pan: 0.5, fade: { in: 10 } },
          }),
        ]),
      ],
      { master: { gain: 3 }, effects: [{ id: 'e3', name: 'blur', params: {} }] },
    );
    expect(toOtio(doc, resolve).warnings).toEqual([
      'Timeline effects were dropped',
      'Master gain and limiter were dropped',
      'Track effects were dropped (V1)',
      'Effects were dropped (c1)',
      'Transforms (position, scale, rotation, opacity) were dropped (c1)',
      'Blend modes were dropped (c1)',
      'Masks were dropped (c1)',
      'In, out and loop animations were dropped (c1)',
      'Audio gain was dropped (c2)',
      'Audio pan was dropped (c2)',
      'Audio fades were dropped (c2)',
    ]);
  });
});

// ---------------------------------------------------------------------------- nested timelines

function nestedDoc(fps: FrameRate, tracks: StoredTrack[]): NestedDoc {
  const { parent: _p, op: _o, ...body } = document(fps, tracks);
  return { ...body, name: 'inner' };
}

describe('nested timelines', () => {
  const f = PAL;
  const inner = nestedDoc(f, [
    track('t1', 'video', 'V1', [
      media(f, 'c1', 'video', VID, 0, 0, 50),
      media(f, 'c2', 'video', VID, 50, 200, 50),
    ]),
    track('t2', 'audio', 'A1', [media(f, 'c3', 'audio', AUD, 0, 0, 100)]),
  ]);
  const complex = nestedDoc(f, [
    track('t1', 'video', 'V1', [media(f, 'c1', 'video', VID, 0, 0, 50)]),
    track('t2', 'video', 'V2', [media(f, 'c2', 'video', VID, 0, 0, 50)]),
  ]);
  const nestClip = (id: string, key: string, start: number, inF: number, dur: number) =>
    ({
      id,
      type: 'timeline',
      timeline: key,
      kind: 'video',
      start: framesToTicks(start, f),
      in: framesToTicks(inF, f),
      duration: framesToTicks(dur, f),
      link: null,
      enabled: true,
    }) as StoredClip;

  it('flattens a simple nested timeline into the clips it shows, trimmed', () => {
    const doc = document(
      f,
      [track('t1', 'video', 'V1', [nestClip('n1', 'tl_inner', 10, 40, 30)])],
      {
        nested: { tl_inner: inner },
      },
    );
    const { text: out, warnings } = toOtio(doc, resolve);
    const v1 = (((JSON.parse(out) as Json).tracks as Json).children as Json[])[0]
      ?.children as Json[];
    const ranges = v1.map((c) => {
      const r = c.source_range as Json;
      return [
        c.OTIO_SCHEMA,
        (r.start_time as Json).value,
        (r.duration as Json).value,
        ((c.metadata as Json).cuttingfloor as Json | undefined)?.clip_id,
      ];
    });
    expect(ranges).toEqual([
      ['Gap.1', 0, 10, undefined],
      ['Clip.2', 40, 10, 'n1.c1'],
      ['Clip.2', 200, 20, 'n1.c2'],
    ]);
    expect(warnings).toContain('Nested timelines were flattened into the clips they show (n1)');
    const edl = toEdl(doc, resolve).text;
    expect(edl).toContain(
      '001  AX       V     C        00:00:01:15 00:00:02:00 00:00:00:10 00:00:00:20',
    );
    expect(edl).toContain(
      '002  AX       V     C        00:00:08:00 00:00:08:20 00:00:00:20 00:00:01:15',
    );
  });

  it('leaves a nested timeline with several tracks as a gap, with a warning', () => {
    const doc = document(
      f,
      [
        track('t1', 'video', 'V1', [
          media(f, 'c9', 'video', VID, 0, 0, 10),
          nestClip('n1', 'tl_c', 10, 0, 20),
        ]),
      ],
      { nested: { tl_c: complex } },
    );
    const { text: out, warnings } = toOtio(doc, resolve);
    const v1 = (((JSON.parse(out) as Json).tracks as Json).children as Json[])[0]
      ?.children as Json[];
    expect(v1.map((c) => c.OTIO_SCHEMA)).toEqual(['Clip.2']);
    expect(warnings).toContain(
      'Nested timelines that could not be flattened were left out as gaps (n1)',
    );
    expect(warnings).toContain(
      'Nested clip n1 was not flattened because its timeline has 2 video tracks in use',
    );
  });
});

// ---------------------------------------------------------------------------- FCPXML

describe('toFcpxml', () => {
  it('writes well-formed FCPXML 1.10 with a spine, lanes, a transition and escaped text', () => {
    const { text: out, warnings } = toFcpxml(ntscCut(), resolve);
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n')).toBe(
      true,
    );
    const root = parseXml(out);
    expect(root.name).toBe('fcpxml');
    expect(root.attrs.version).toBe('1.10');
    const format = all(root, 'format')[0] as XmlNode;
    expect(format.attrs).toMatchObject({
      frameDuration: '1001/30000s',
      width: '1920',
      height: '1080',
    });
    const assets = all(root, 'asset');
    expect(assets.map((a) => a.attrs.name)).toEqual([
      'Interview A&B.mov',
      'b-roll.mp4',
      'music.wav',
    ]);
    expect(one(assets[0] as XmlNode, 'media-rep').attrs.src).toBe(
      'file:///media/Interview%20A&B.mov',
    );
    expect(assets[0]?.attrs).toMatchObject({ hasVideo: '1', hasAudio: '1', duration: '1001/10s' });
    expect(one(root, 'event').attrs.name).toBe('Cut <one> & "two"');
    const sequence = one(root, 'sequence');
    expect(sequence.attrs).toMatchObject({
      tcFormat: 'DF',
      audioLayout: 'stereo',
      audioRate: '48k',
    });
    // 150 frames at 29.97: the music runs to the end.
    expect(sequence.attrs.duration).toBe('1001/200s');
    const spine = one(root, 'spine');
    expect(spine.children.map((c) => c.name)).toEqual([
      'gap',
      'asset-clip',
      'transition',
      'asset-clip',
      'gap',
    ]);
    const [gap, c1, tr, c3] = spine.children as [XmlNode, XmlNode, XmlNode, XmlNode];
    expect(gap.attrs).toMatchObject({ offset: '0s', duration: '1001/1000s' });
    // Frame 30 at 29.97 is 1001/1000 s; source frame 100 is 1001/300 s.
    expect(c1.attrs).toMatchObject({
      offset: '1001/1000s',
      start: '1001/300s',
      duration: '1001/500s',
      name: 'Interview A&B.mov',
    });
    // The cut is at frame 90; the dissolve starts 5 frames before it and lasts 10.
    expect(tr.attrs).toMatchObject({
      offset: fcpTime(framesToTicks(85, NTSC)),
      duration: '1001/3000s',
    });
    expect(one(tr, 'filter-video').attrs.name).toBe('Cross Dissolve');
    expect(c3.attrs.offset).toBe('3003/1000s');
    // The linked sound is part of the A/V asset-clip, not a separate connected clip.
    const audioLanes = all(root, 'asset-clip').filter((n) => n.attrs.lane === '-1');
    expect(audioLanes).toHaveLength(0);
    // The music connects on lane -2 to the gap (its local time starts at 0).
    const music = all(gap, 'asset-clip')[0] as XmlNode;
    expect(music.attrs).toMatchObject({ lane: '-2', offset: '0s', duration: '1001/200s' });
    // The title connects to c1 at frame 40, which is 10 frames into it: source 110.
    const title = one(c1, 'title');
    expect(title.attrs).toMatchObject({ lane: '1', offset: fcpTime(framesToTicks(110, NTSC)) });
    expect(one(one(title, 'text'), 'text-style').text).toBe('Hello <world> & "you"');
    expect(out).toContain('Hello &lt;world&gt; &amp; &quot;you&quot;');
    expect(warnings).toContain('Title styling was dropped; titles use a basic text style (c4)');
  });

  it('writes speed as a timeMap and keeps unpaired sound and picture apart', () => {
    const f = PAL;
    const doc = document(f, [
      track('t1', 'video', 'V1', [
        media(f, 'c1', 'video', AV, 0, 0, 50, { speed: { rate: 2 } }),
        media(f, 'c2', 'video', VID, 50, 0, 25, { speed: { rate: 0 } }),
      ]),
      track('t2', 'audio', 'A1', [media(f, 'c3', 'audio', AV, 10, 500, 25)]),
    ]);
    const root = parseXml(toFcpxml(doc, resolve).text);
    const spine = one(root, 'spine');
    expect(spine.children.map((c) => c.name)).toEqual(['video', 'asset-clip']);
    const [v, still] = spine.children as [XmlNode, XmlNode];
    expect(v.attrs).toMatchObject({ offset: '0s', start: '0s', duration: '2s' });
    expect(one(v, 'timeMap').children.map((p) => [p.attrs.time, p.attrs.value])).toEqual([
      ['0s', '0s'],
      ['2s', '4s'],
    ]);
    expect(one(still, 'timeMap').children.map((p) => p.attrs.value)).toEqual(['0s', '0s']);
    // Unlinked sound from the A/V file: an audio element on lane -1, 10 frames into c1's
    // local time.
    const sound = one(v, 'audio');
    expect(sound.attrs).toMatchObject({
      lane: '-1',
      offset: '2/5s',
      start: '20s',
      role: 'dialogue',
    });
  });

  it('carries constant transforms and gain, puts captions on a lane, and handles audio-only timelines', () => {
    const f = PAL;
    const doc = document(f, [
      track('t1', 'video', 'V1', [
        media(f, 'c1', 'video', VID, 0, 0, 50, {
          extra: { transform: { x: 0.75, y: 0.25, scale: 0.5, rotation: 90, opacity: 0.5 } },
        }),
      ]),
      track('t2', 'video', 'V2', [text(f, 'c2', 'caption', 'Hi & bye', 5, 20)]),
      track('t3', 'audio', 'A1', [media(f, 'c3', 'audio', AUD, 0, 0, 50, { extra: { gain: -6 } })]),
    ]);
    const root = parseXml(toFcpxml(doc, resolve).text);
    const transform = one(root, 'adjust-transform');
    expect(transform.attrs).toEqual({
      position: '44.444444 25',
      scale: '0.5 0.5',
      rotation: '-90',
    });
    expect(one(root, 'adjust-blend').attrs.amount).toBe('0.5');
    expect(one(root, 'adjust-volume').attrs.amount).toBe('-6dB');
    const caption = one(root, 'caption');
    expect(caption.attrs).toMatchObject({ lane: '1', role: 'iTT?captionFormat=ITT.en' });
    expect(one(one(caption, 'text'), 'text-style').text).toBe('Hi & bye');

    const audioOnly = document(f, [
      track('t1', 'video', 'V1', []),
      track('t2', 'audio', 'A1', [media(f, 'c1', 'audio', AUD, 25, 0, 50)]),
    ]);
    const a = parseXml(toFcpxml(audioOnly, resolve).text);
    const spine = one(a, 'spine');
    expect(spine.children.map((c) => [c.name, c.attrs.duration])).toEqual([['gap', '3s']]);
    expect(one(spine, 'asset-clip').attrs).toMatchObject({ lane: '-1', offset: '1s' });
  });

  it('leaves out disabled clips and hidden tracks', () => {
    const f = PAL;
    const doc = document(f, [
      track('t1', 'video', 'V1', [
        media(f, 'c1', 'video', VID, 0, 0, 25, { enabled: false }),
        media(f, 'c2', 'video', VID, 25, 0, 25),
      ]),
      track('t2', 'video', 'V2', [media(f, 'c3', 'video', VID, 0, 0, 25)], { hidden: true }),
    ]);
    const { text: out, warnings } = toFcpxml(doc, resolve);
    const spine = one(parseXml(out), 'spine');
    expect(spine.children.map((c) => [c.name, c.attrs.offset])).toEqual([
      ['gap', '0s'],
      ['asset-clip', '1s'],
    ]);
    expect(warnings).toEqual(['Hidden tracks were left out (V2)']);
  });
});

// ---------------------------------------------------------------------------- EDL

describe('toEdl', () => {
  it('writes drop-frame events with linked audio, a dissolve and clip names', () => {
    const { text: out, warnings } = toEdl(ntscCut(), resolve);
    expect(out).toBe(
      [
        'TITLE: Cut <one> & "two"',
        'FCM: DROP FRAME',
        '',
        '001  AX       A/V   C        00:00:03;10 00:00:05;05 00:00:01;00 00:00:02;25',
        '* FROM CLIP NAME: Interview A&B.mov',
        '* SOURCE FILE: /media/Interview A&B.mov',
        '',
        '002  AX       V     C        00:00:05;05 00:00:05;05 00:00:02;25 00:00:02;25',
        '002  AX       V     D    010 00:00:00;05 00:00:01;25 00:00:02;25 00:00:04;15',
        '* FROM CLIP NAME: Interview A&B.mov',
        '* TO CLIP NAME: b-roll.mp4',
        '* SOURCE FILE: media/b roll.mp4',
        '',
      ].join('\n'),
    );
    expect(warnings).toEqual([
      'Video tracks after the first were left out (an EDL holds one) (V2)',
      'Audio that does not line up with the main track was left out (c5)',
    ]);
  });

  it('writes speed as M2 lines and non-drop timecode at 25', () => {
    const f = PAL;
    const doc = document(f, [
      track('t1', 'video', 'V1', [
        media(f, 'c1', 'video', VID, 0, 10, 20, { speed: { rate: 2 } }),
        media(f, 'c2', 'video', VID, 20, 100, 20, { speed: { rate: 0.5, reverse: true } }),
        media(f, 'c3', 'video', VID, 40, 50, 25, { speed: { rate: 0 } }),
      ]),
    ]);
    const lines = toEdl(doc, resolve).text.split('\n');
    expect(lines[1]).toBe('FCM: NON-DROP FRAME');
    expect(lines).toContain(
      '001  AX       V     C        00:00:00:10 00:00:02:00 00:00:00:00 00:00:00:20',
    );
    expect(lines).toContain(`M2   AX${' '.repeat(14)}050.0    00:00:00:10`);
    expect(lines).toContain(
      '002  AX       V     C        00:00:04:00 00:00:04:10 00:00:00:20 00:00:01:15',
    );
    expect(lines).toContain(`M2   AX${' '.repeat(13)}-012.5    00:00:04:09`);
    expect(lines).toContain(
      '003  AX       V     C        00:00:02:00 00:00:02:01 00:00:01:15 00:00:02:15',
    );
    expect(lines).toContain(`M2   AX${' '.repeat(14)}000.0    00:00:02:00`);
  });

  it('uses the first audio track when there is no picture, and pairs a second channel', () => {
    const f = PAL;
    const doc = document(f, [
      track('t1', 'video', 'V1', []),
      track('t2', 'audio', 'A1', [media(f, 'c1', 'audio', AV, 25, 0, 50, { link: 'g' })]),
      track('t3', 'audio', 'A2', [media(f, 'c2', 'audio', AV, 25, 0, 50, { link: 'g' })]),
      track('t4', 'audio', 'A3', [media(f, 'c3', 'audio', AUD, 0, 0, 50)]),
    ]);
    const { text: out, warnings } = toEdl(doc, resolve);
    expect(out).toContain(
      '001  AX       AA    C        00:00:00:00 00:00:02:00 00:00:01:00 00:00:03:00',
    );
    expect(warnings).toEqual([
      'Audio tracks after the first two were left out (an EDL holds two channels) (A3)',
    ]);
  });
});

// ---------------------------------------------------------------------------- SRT / VTT

describe('toSrt and toVtt', () => {
  const f = NTSC;
  const t = (n: number) => framesToTicks(n, f);
  const doc = () =>
    document(f, [
      track('t1', 'video', 'V1', [media(f, 'c1', 'video', VID, 0, 0, 300)]),
      track('t2', 'video', 'V2', [
        text(f, 'c3', 'caption', 'Second\n\nline <b>', 120, 60),
        text(f, 'c2', 'caption', 'Hello there world', 30, 60, {
          in: t(10),
          words: [
            { text: 'Hello', t: t(10), end: t(30) },
            { text: 'there', t: t(30), end: t(50) },
            { text: 'world', t: t(50), end: t(70) },
          ],
        } as Partial<StoredClip>),
        text(f, 'c4', 'caption', 'off', 200, 10, { enabled: false }),
      ]),
      track('t3', 'video', 'V3', [text(f, 'c5', 'title', 'A title', 0, 30)]),
    ]);

  it('writes captions in timeline order as SubRip', () => {
    const { text: out, warnings } = toSrt(doc());
    expect(out).toBe(
      [
        '1',
        '00:00:01,001 --> 00:00:03,003',
        'Hello there world',
        '',
        '2',
        '00:00:04,004 --> 00:00:06,006',
        'Second',
        'line <b>',
        '',
      ].join('\n'),
    );
    expect(warnings).toEqual(['SubRip has no word timings; captions were written as plain cues']);
  });

  it('writes WebVTT with inline word timestamps that parse back', () => {
    const { text: out } = toVtt(doc());
    expect(out).toBe(
      [
        'WEBVTT',
        '',
        '00:00:01.001 --> 00:00:03.003',
        'Hello <00:00:01.668>there <00:00:02.336>world',
        '',
        '00:00:04.004 --> 00:00:06.006',
        'Second',
        'line &lt;b&gt;',
        '',
      ].join('\n'),
    );
    const cues = parseSubtitles(out, 'vtt');
    expect(cues.map((c) => c.text)).toEqual(['Hello there world', 'Second\nline <b>']);
    expect(cues[0]?.words?.map((w) => [w.text, Math.round(w.start * 1000) / 1000])).toEqual([
      ['Hello', 1.001],
      ['there', 1.668],
      ['world', 2.336],
    ]);
  });

  it('falls back to titles when there are no captions, and round-trips SubRip', () => {
    const titles = document(f, [
      track('t1', 'video', 'V1', [
        text(f, 'c1', 'title', 'Opening', 0, 90),
        text(f, 'c2', 'title', 'Two & three', 3600 * 30, 30),
      ]),
    ]);
    const { text: out, warnings } = toSrt(titles);
    expect(warnings).toEqual(['The timeline has no captions, so its titles were written as cues']);
    expect(out).toContain('01:00:03,600 --> 01:00:04,601');
    expect(parseSubtitles(out, 'srt').map((c) => [c.start, c.end, c.text])).toEqual([
      [0, 3.003, 'Opening'],
      [3603.6, 3604.601, 'Two & three'],
    ]);
    expect(toVtt(document(f, [track('t1', 'video', 'V1', [])]))).toEqual({
      text: 'WEBVTT\n',
      warnings: ['The timeline has no captions or titles, so there are no cues'],
    });
  });
});

// ---------------------------------------------------------------------------- from real edits

describe('writeInterchange on an edited timeline', () => {
  it('exports a timeline built with the edit tools in every format', () => {
    const fps = NTSC;
    const mediaRefs = refs(fps);
    const base = newTimeline('edited', document(fps, []).sequence, { video: 2, audio: 1 });
    const { doc } = runEdits(
      base,
      'tl_parent',
      [
        { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 0, out: 90 } } },
        { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 300, out: 390 } } },
        { tool: 'transition.add', args: { clip_id: 'c5', kind: 'dissolve', duration_frames: 10 } },
        {
          tool: 'title.add',
          args: { track_id: 't2', text: 'Lower third', at_frame: 30, duration_frames: 45 },
        },
      ],
      (id) => mediaRefs[id],
      { tool: 'test', args: null },
    );
    const fcp = writeInterchange('fcpxml', doc, resolve);
    const spine = one(parseXml(fcp.text), 'spine');
    expect(spine.children.map((c) => c.name)).toEqual(['asset-clip', 'transition', 'asset-clip']);
    const otio = JSON.parse(writeInterchange('otio', doc, resolve).text) as Json;
    const v1 = ((otio.tracks as Json).children as Json[])[0]?.children as Json[];
    expect(v1.map((c) => c.OTIO_SCHEMA)).toEqual(['Clip.2', 'Transition.1', 'Clip.2']);
    const edl = writeInterchange('edl', doc, resolve).text;
    expect(edl).toMatch(/^002 {2}AX {7}A\/V {3}D {4}010 /m);
    expect(writeInterchange('srt', doc, resolve).text).toContain('Lower third');
    expect(writeInterchange('vtt', doc, resolve).text.startsWith('WEBVTT\n')).toBe(true);
  });
});
