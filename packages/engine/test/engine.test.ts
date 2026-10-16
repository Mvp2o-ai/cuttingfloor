import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { framesToTicks, newTimeline, runEdits } from '@cuttingfloor/core';
import {
  compileMlt,
  conformReasons,
  download,
  isBlockedAddress,
  type Probe,
  scaledSize,
  standardRate,
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
    expect(fill).toContain('<property name="rect">0 0 640 360 1</property>');
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

  it('refuses to compile with offline media', () => {
    expect(() => compileMlt(doc, { width: 640, height: 360, sources: new Map() })).toThrow(
      /not available/,
    );
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
