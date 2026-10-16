import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { framesToTicks, newTimeline, runEdits } from '@cuttingfloor/core';
import {
  compileMlt,
  conformReasons,
  download,
  estimateTempo,
  isBlockedAddress,
  onsetEnvelope,
  type Probe,
  scaledSize,
  standardRate,
  trackBeats,
} from '@cuttingfloor/engine';
import { describe, expect, it } from 'vitest';

describe('SSRF guard', () => {
  it('blocks private, loopback, link-local and metadata addresses', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '224.0.0.1',
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isBlockedAddress(a), a).toBe(false);
  });

  it('refuses to download from loopback, including after a redirect', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/redirect')
        res.writeHead(302, { location: 'http://127.0.0.1/secret' }).end();
      else res.writeHead(200).end('data');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const dir = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'cf-dl-'));
    const opts = { maxBytes: 1024, timeoutMs: 5000 };
    await expect(
      download(`http://127.0.0.1:${port}/x`, join(dir, 'a'), opts),
    ).rejects.toMatchObject({ code: 'path_not_allowed' });
    await expect(
      download(`http://localhost:${port}/x`, join(dir, 'b'), opts),
    ).rejects.toMatchObject({ code: 'path_not_allowed' });
    await expect(download('file:///etc/passwd', join(dir, 'c'), opts)).rejects.toMatchObject({
      code: 'bad_request',
    });
    // With private addresses allowed (tests only), a redirect is followed and re-checked.
    const ok = await download(`http://127.0.0.1:${port}/x`, join(dir, 'd'), {
      ...opts,
      allowPrivate: true,
    });
    expect(ok.bytes).toBe(4);
    await expect(
      download(`http://127.0.0.1:${port}/x`, join(dir, 'e'), {
        ...opts,
        allowPrivate: true,
        maxBytes: 2,
      }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    server.close();
  });
});

describe('MLT compiler', () => {
  const fps = { num: 25, den: 1 };
  const seq = {
    width: 1920,
    height: 1080,
    fps,
    audio_rate: 48_000,
    channels: 2,
    color: 'bt709' as const,
  };
  const id = 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa';
  const pic = { path: '/a', image: false, width: 640, height: 480, alpha: false };
  const media = { name: 'a', duration: framesToTicks(100, fps), video: true, audio: true };
  const { doc } = runEdits(
    newTimeline('t', seq, { video: 1, audio: 1 }),
    'tl_x',
    [
      {
        tool: 'clip.add',
        args: { track_id: 't1', media_id: id, at_frame: 10, source: { in: 5, out: 30 } },
      },
      { tool: 'track.set', args: { track_id: 't2', muted: true } },
    ],
    () => media,
    { tool: 'x', args: null },
  );

  it('forces producers, fills gaps with blanks and hides muted tracks', () => {
    const xml = compileMlt(doc, {
      width: 640,
      height: 360,
      sources: new Map([[id, { ...pic, path: '/m/a&b.mov' }]]),
    });
    expect(xml).toContain('<property name="mlt_service">avformat</property>');
    expect(xml).toContain('/m/a&amp;b.mov');
    expect(xml).toContain(
      '<blank length="10"/><entry producer="m_aaaaaaaaaaaaaaaaaaaaaaaaaa_v" in="5" out="29"></entry>',
    );
    expect(xml).toMatch(/hide="both"/);
    // Each video clip composites itself over its own range, fitted with its aspect kept.
    expect(xml).toContain(
      '<transition in="10" out="34"><property name="mlt_service">qtblend</property><property name="a_track">0</property><property name="b_track">1</property><property name="rect">80 0 480 360 1</property>',
    );
    expect(xml).not.toMatch(/ante|post|melt_file|xml:/);
  });

  it('renders frame lists as a playlist of single frames', () => {
    const xml = compileMlt(doc, {
      width: 640,
      height: 360,
      sources: new Map([[id, pic]]),
      frames: [12, 20],
    });
    expect(xml).toContain('producer="frames"');
    expect(xml).toContain(
      '<entry producer="main" in="12" out="12"/><entry producer="main" in="20" out="20"/>',
    );
  });

  const edit = (ops: Array<{ tool: string; args: Record<string, unknown> }>) =>
    runEdits(doc, 'tl_x', ops as never, () => media, { tool: 'x', args: null }).doc;
  const compile = (d: typeof doc, source = pic) =>
    compileMlt(d, { width: 640, height: 360, sources: new Map([[id, source]]) });

  it('bakes keyframed transforms per frame and keeps only the corners of straight runs', () => {
    const xml = compile(
      edit([
        {
          tool: 'clip.set_transform',
          args: {
            clip_id: 'c4',
            scale: 0.5,
            x: {
              keyframes: [
                { frame: 0, value: 0.25 },
                { frame: 10, value: 0.75 },
              ],
            },
            rotation: 90,
            opacity: 0.5,
          },
        },
      ]),
    );
    // A 4:3 picture in 16:9 fits 480×360; half size is 240×180, centred at x 160 → 480.
    expect(xml).toContain(
      '<property name="rect">0=40 90 240 180 0.5;10=360 90 240 180 0.5;24=360 90 240 180 0.5</property>',
    );
    expect(xml).toContain('<property name="rotation">90</property>');
  });

  it('fills and covers the frame', () => {
    const fill = compile(
      edit([{ tool: 'clip.set_transform', args: { clip_id: 'c4', fit: 'fill' } }]),
    );
    // Full frame stays just under opacity 1, off qtblend's shortcut (see composite.ts).
    expect(fill).toContain('<property name="rect">0 0 640 360 0.9999</property>');
    const cover = compile(
      edit([{ tool: 'clip.set_transform', args: { clip_id: 'c4', fit: 'cover' } }]),
    );
    expect(cover).toContain('<property name="rect">0 -60 640 480 1</property>');
  });

  it('maps blend modes to qtblend composition modes', () => {
    const xml = compile(
      edit([{ tool: 'clip.set_blend', args: { clip_id: 'c4', mode: 'screen' } }]),
    );
    expect(xml).toContain('<property name="compositing">14</property>');
  });

  it("masks in the picture's own space", () => {
    const xml = compile(
      edit([
        {
          tool: 'clip.set_mask',
          args: {
            clip_id: 'c4',
            mask: { shape: 'rectangle', x: 0.25, width: 0.5, height: 1, invert: true },
          },
        },
      ]),
    );
    const rotos = [
      ...xml.matchAll(
        /<property name="alpha_operation">(\w+)<\/property><property name="invert">(\d)<\/property>/g,
      ),
    ].map((m) => `${m[1]}/${m[2]}`);
    expect(rotos).toEqual(['clear/1']);
    // The mask's left edge is the picture's left edge.
    expect(xml).toContain('[[0,0],[0,0],[0,0]]');
    expect(xml).toContain('<property name="rect">80 0 480 360 1</property>');
  });

  it('keeps an existing alpha channel under a mask', () => {
    const xml = compile(
      edit([{ tool: 'clip.set_mask', args: { clip_id: 'c4', mask: { shape: 'ellipse' } } }]),
      { ...pic, alpha: true },
    );
    expect(xml).toContain('<property name="alpha_operation">min</property>');
    expect(xml).not.toContain('<property name="alpha_operation">clear</property>');
  });

  it('keys animated masks by source frame', () => {
    const xml = compile(
      edit([
        {
          tool: 'clip.set_mask',
          args: {
            clip_id: 'c4',
            mask: {
              shape: 'ellipse',
              x: {
                keyframes: [
                  { frame: 0, value: 0.2 },
                  { frame: 24, value: 0.8 },
                ],
              },
            },
          },
        },
      ]),
    );
    // The clip starts at source frame 5.
    expect(xml).toMatch(/\{&quot;5&quot;:\[\[\[/);
    expect(xml).toContain('&quot;29&quot;:');
  });

  it('plays retimed clips through timeremap chains', () => {
    const fast = compile(edit([{ tool: 'clip.set_speed', args: { clip_id: 'c4', rate: 2 } }]));
    // Source frames 5–29 at 25 fps, twice as fast: 12 frames from 0.2 s, 0.08 s apart.
    expect(fast).toContain('<chain id="c4_v" out="11">');
    expect(fast).toContain('<property name="time_map">0=0.2;11=1.08</property>');
    expect(fast).toContain('<entry producer="c4_v" in="0" out="11">');
    // The linked audio is retimed too, with its pitch kept.
    expect(fast).toMatch(/<chain id="c5_a" out="11">.*<property name="pitch">1<\/property>/);
    const back = compile(
      edit([{ tool: 'clip.set_speed', args: { clip_id: 'c4', reverse: true } }]),
    );
    // Reversed: the first frame is source frame 29, the last is 5.
    expect(back).toContain('<property name="time_map">0=1.16;24=0.2</property>');
    const held = compile(
      edit([{ tool: 'clip.freeze', args: { clip_id: 'c4', at_frame: 20, duration_frames: 5 } }]),
    );
    expect(held).toContain('<property name="time_map">0=0.6</property>');
  });

  it('compiles a nested timeline once, as a tractor over transparency', () => {
    const outer = runEdits(
      newTimeline('outer', seq, { video: 1, audio: 1 }),
      'tl_y',
      [
        {
          tool: 'clip.add',
          args: { track_id: 't1', nested_timeline_id: 'tl_00000000000000000000000000000001' },
        },
        {
          tool: 'clip.add',
          args: { track_id: 't1', nested_timeline_id: 'tl_00000000000000000000000000000001' },
        },
      ],
      () => media,
      { tool: 'x', args: null },
      () => doc,
    ).doc;
    const xml = compile(outer);
    expect(xml.match(/<tractor id="n1_main"/g)).toHaveLength(1);
    expect(xml).toContain(
      '<producer id="n1_base" in="0" out="34"><property name="mlt_service">color</property><property name="resource">0x00000000</property>',
    );
    expect(xml).toMatch(/<entry producer="n1_main" in="0" out="34">/);
    expect(xml.indexOf('id="n1_main"')).toBeLessThan(xml.indexOf('<tractor id="main"'));
  });

  it('plays both clips of a transition on separate sub-tracks', () => {
    const cut = edit([
      { tool: 'clip.split', args: { clip_id: 'c4', at_frame: 20 } },
      {
        tool: 'transition.add',
        args: { clip_id: 'c4', kind: 'dissolve', duration_frames: 6, mode: 'handles' },
      },
    ]);
    const xml = compile(cut);
    // The video track gets a second lane for the clip after the cut, and so does the audio.
    expect(xml).toContain('<playlist id="track0_1">');
    expect(xml).toContain('<playlist id="track1_1">');
    // The clip before the cut runs 3 frames past it; the clip after starts 3 frames early.
    expect(xml).toMatch(
      /<playlist id="track0"><blank length="10"\/><entry producer="m_\w+_v" in="5" out="17">/,
    );
    expect(xml).toMatch(
      /<playlist id="track0_1"><blank length="17"\/><entry producer="m_\w+_v" in="12" out="29">/,
    );
    // The incoming clip fades in over the 6 frames; its sound fades in with it.
    expect(xml).toMatch(
      /<transition in="17" out="34">.*<property name="rect">0=80 0 480 360 0\.0833;/,
    );
    expect(xml).toContain('<property name="level">12=-100;');
  });

  it('writes text as an ASS script over a transparent layer', () => {
    const titled = runEdits(
      newTimeline('t', seq, { video: 1, audio: 0 }),
      'tl_z',
      [
        {
          tool: 'caption.add',
          args: {
            track_id: 't1',
            segments: [
              {
                start_frame: 0,
                end_frame: 50,
                text: 'a {b} c',
                words: [
                  { text: 'a', start_frame: 5, end_frame: 15 },
                  { text: '{b}\\n', start_frame: 20, end_frame: 30 },
                ],
              },
            ],
            style: {
              highlight: { mode: 'karaoke', color: '#FFE000' },
              box: { color: '#00000080', padding: 0.2 },
            },
          },
        },
      ],
      () => media,
      { tool: 'x', args: null },
    ).doc;
    const files = new Map<string, string>();
    const xml = compileMlt(titled, { width: 640, height: 360, sources: new Map(), files });
    expect(xml).toMatch(
      /<producer id="c2_text" in="0" out="49"><property name="mlt_service">color<\/property><property name="resource">0x00000000<\/property>.*<property name="mlt_service">avfilter\.ass<\/property><property name="av\.filename">c2_text\.ass<\/property><property name="av\.alpha">1<\/property>/,
    );
    const ass = files.get('c2_text.ass') ?? '';
    expect(ass).toContain('PlayResX: 640');
    // Karaoke: sung colour is the highlight, waiting colour the text colour; 0.2 s lead, then
    // each word's turn lasts until the next starts.
    expect(ass).toMatch(/Style: Text,Inter,21\.6,&H0000E0FF,&H00FFFFFF,/);
    expect(ass).toContain('{\\k20}{\\k60}a {\\k40}');
    // User text can't open override blocks or escapes.
    expect(ass).toContain('\uFF5Bb\uFF5D\\\u2060n');
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,0:00:02\.00,Box,/);
  });

  it('folds gain, fades and pan into each audio clip, and the master onto the mix', () => {
    const xml = compile(
      edit([
        { tool: 'track.set', args: { track_id: 't2', muted: false } },
        { tool: 'audio.set_gain', args: { clip_id: 'c5', gain_db: -6 } },
        { tool: 'audio.fade', args: { clip_id: 'c5', in_frames: 4 } },
        { tool: 'audio.set_pan', args: { clip_id: 'c5', pan: 1 } },
        { tool: 'audio.set_master', args: { gain_db: 3, limit_db: -1.5 } },
      ]),
    );
    // Source frames 5–29: a 4-frame fade into -6 dB, then flat.
    expect(xml).toMatch(
      /<property name="level">5=-24\.06;6=-14\.52;7=-10\.08;8=-7\.16;9=-6;29=-6<\/property>/,
    );
    expect(xml).toContain(
      '<property name="mlt_service">panner</property><property name="channel">-1</property><property name="start">1</property>',
    );
    expect(xml).toMatch(
      /<\/transition><filter><property name="mlt_service">volume<\/property><property name="level">3<\/property><\/filter><filter><property name="mlt_service">avfilter\.alimiter<\/property><property name="av\.limit">0\.8414<\/property><property name="av\.level">0<\/property>.*<\/tractor>/,
    );
  });

  it('compiles effects on clips, under masks, in adjustment zones and on the timeline', () => {
    const fx = runEdits(
      newTimeline('t', seq, { video: 2, audio: 0 }),
      'tl_q',
      [
        {
          tool: 'clip.add',
          args: {
            track_id: 't1',
            media_id: id,
            av: 'video',
            at_frame: 10,
            source: { in: 5, out: 30 },
          },
        },
        {
          tool: 'filter.add',
          args: {
            clip_id: 'c3',
            name: 'blur',
            params: {
              radius: {
                keyframes: [
                  { frame: 0, value: 0 },
                  { frame: 10, value: 0.1 },
                ],
              },
            },
          },
        },
        {
          tool: 'filter.add',
          args: { clip_id: 'c3', name: 'chroma_key', params: { color: '#00FF00' } },
        },
        { tool: 'clip.set_mask', args: { clip_id: 'c3', mask: { shape: 'ellipse' } } },
        { tool: 'adjustment.add', args: { track_id: 't2', at_frame: 12, duration_frames: 8 } },
        { tool: 'filter.add', args: { clip_id: 'c6', name: 'grayscale' } },
        { tool: 'filter.add', args: { timeline: true, name: 'invert' } },
      ],
      () => media,
      { tool: 'x', args: null },
    ).doc;
    const xml = compile(fx);
    // Blur sigma is half the radius in pixels at 360 high, keyed by source frame (from 5).
    expect(xml).toContain('<property name="av.sigma">5=0;15=18;29=18</property>');
    expect(xml).toContain(
      '<property name="mlt_service">chroma</property><property name="key">0x00FF00ff</property>',
    );
    // The key makes transparency the mask must keep: no clear operation.
    expect(xml).not.toContain('<property name="alpha_operation">clear</property>');
    // Everything below the adjustment track is one sub-tractor with a ranged filter.
    expect(xml).toMatch(
      /<tractor id="below1" in="0" out="34">.*<filter in="12" out="19"><property name="mlt_service">avfilter\.hue<\/property><property name="av\.s">0<\/property><\/filter><\/tractor>/,
    );
    expect(xml).toMatch(
      /<tractor id="main".*<track producer="below1"\/>.*<property name="mlt_service">avfilter\.negate<\/property>.*<\/tractor>/,
    );
  });

  it('refuses to compile with offline media', () => {
    expect(() => compileMlt(doc, { width: 640, height: 360, sources: new Map() })).toThrow(
      /not available/,
    );
  });
});

describe('beats', () => {
  it('finds 120 BPM and its beats in a click track', () => {
    const rate = 22_050;
    const seconds = 12;
    const samples = new Float32Array(rate * seconds);
    // A short decaying click every half second, from 0.25 s.
    for (let beat = 0.25; beat < seconds; beat += 0.5) {
      const at = Math.round(beat * rate);
      for (let i = 0; i < 400 && at + i < samples.length; i++) {
        samples[at + i] = Math.sin(i * 0.9) * Math.exp(-i / 80);
      }
    }
    const env = onsetEnvelope(samples);
    const bpm = estimateTempo(env);
    expect(bpm).toBeGreaterThan(118);
    expect(bpm).toBeLessThan(122);
    // Beat times as analyseBeats reports them: the middle of each analysis frame.
    const beats = trackBeats(env, bpm).map((f) => (f * 512 + 512) / rate);
    const inside = beats.filter((t) => t > 1 && t < 11);
    // Every beat lands within 40 ms of a click, and none is missed.
    const offClick = (t: number) => Math.abs((t - 0.25) / 0.5 - Math.round((t - 0.25) / 0.5)) * 0.5;
    expect(inside.every((t) => offClick(t) < 0.04)).toBe(true);
    expect(inside.length).toBe(20);
  });
});

describe('media helpers', () => {
  it('snaps measured rates to standard ones', () => {
    expect(standardRate({ num: 2997, den: 100 })).toEqual({ num: 30000, den: 1001 });
    expect(standardRate({ num: 25, den: 1 })).toEqual({ num: 25, den: 1 });
    expect(standardRate({ num: 4650, den: 179 })).toEqual({ num: 26, den: 1 });
  });

  it('keeps aspect and even sizes', () => {
    expect(scaledSize(1920, 1080, 640)).toEqual({ width: 640, height: 360 });
    expect(scaledSize(1080, 1920, 640)).toEqual({ width: 360, height: 640 });
  });

  it('decides when a mezzanine is needed', () => {
    const base: Probe = {
      format: 'mov',
      kind: 'video',
      duration: 1,
      video: {
        codec: 'h264',
        width: 1,
        height: 1,
        fps: { num: 25, den: 1 },
        vfr: false,
        rotation: 0,
        transfer: 'bt709',
        primaries: null,
        pix_fmt: null,
        frames: null,
      },
      audio: null,
    };
    expect(conformReasons(base)).toEqual([]);
    const v = base.video as NonNullable<Probe['video']>;
    expect(
      conformReasons({
        ...base,
        video: { ...v, vfr: true, rotation: 90, transfer: 'arib-std-b67', codec: 'theora' },
      }),
    ).toEqual(['vfr', 'rotation', 'hdr', 'codec']);
  });
});
