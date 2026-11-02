import type { StoredClip } from '@cuttingfloor/schema';
import { describe, expect, it } from 'vitest';
import {
  clipPlacements,
  colourStats,
  numberSpeakers,
  parseSignalstats,
  parseTurns,
  voiceSeries,
  wordSpeakers,
} from '../src/index.ts';

const RATE = 16_000;
const tone = (hz: number, seconds: number, amp = 0.5) =>
  Float32Array.from(
    { length: Math.round(RATE * seconds) },
    (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE),
  );

describe('voice', () => {
  it('reads the pitch and level of a voice-like tone, and nothing in silence', () => {
    const x = new Float32Array(RATE * 3);
    x.set(tone(220, 1), 0);
    x.set(tone(330, 1, 0.25), RATE);
    const v = voiceSeries(x, 10);
    expect(v.from).toBe(10);
    expect(v.frames[0]?.time).toBe(10);
    const at = (t: number) => v.frames.find((f) => Math.abs(f.time - t) < 1e-6);
    expect(at(10.5)?.pitch_hz).toBeCloseTo(220, -1);
    expect(at(11.5)?.pitch_hz).toBeCloseTo(330, -1);
    expect(at(12.5)?.pitch_hz).toBeNull();
    expect(at(12.5)?.level_db).toBeNull();
    // A sine at 0.5 is -9 dBFS RMS; at 0.25, -15.
    expect(at(10.5)?.level_db).toBeCloseTo(-9, 0);
    expect(at(11.5)?.level_db).toBeCloseTo(-15, 0);
    expect(v.summary.voiced_seconds).toBeGreaterThan(1.8);
    expect(v.summary.voiced_seconds).toBeLessThan(2.1);
    expect(v.summary.pitch_range_semitones).toBeCloseTo(7, 0);
  });
});

describe('colour', () => {
  it('measures each channel, luma, white point and clipping of a region', () => {
    // 4x2: left half pure red, right half mid grey with one white pixel.
    const px = [
      [255, 0, 0],
      [255, 0, 0],
      [128, 128, 128],
      [255, 255, 255],
      [255, 0, 0],
      [255, 0, 0],
      [128, 128, 128],
      [128, 128, 128],
    ];
    const rgb = Uint8Array.from(px.flat());
    const left = colourStats(rgb, 4, 2, { x: 0, y: 0, w: 0.5, h: 1 }, [50]);
    expect(left.pixels).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(left.r.mean).toBe(255);
    expect(left.g.mean).toBe(0);
    expect(left.luma.mean).toBeCloseTo(54.21, 1);
    expect(left.clipped_high).toBe(1);
    const right = colourStats(rgb, 4, 2, { x: 0.5, y: 0, w: 0.5, h: 1 }, [5, 95]);
    expect(right.white_point).toEqual({ r: 255, g: 255, b: 255 });
    expect(right.r.percentiles).toEqual({ '5': 128, '95': 255 });
    expect(right.clipped_high).toBe(0.25);
  });
});

describe('picture series', () => {
  it('turns signalstats lines into columns on the source clock', () => {
    const text = [
      'frame:0    pts:0       pts_time:0',
      'lavfi.signalstats.YAVG=16',
      'lavfi.signalstats.YDIF=0',
      'frame:1    pts:512     pts_time:0.04',
      'lavfi.signalstats.YAVG=235',
      'lavfi.signalstats.YDIF=219',
    ].join('\n');
    expect(parseSignalstats(text, 2)).toEqual({
      columns: { time: [2, 2.04], yavg: [16, 235], ydif: [0, 219] },
    });
  });
});

describe('speakers', () => {
  it('numbers voices in the order heard and gives each word the speaker it overlaps most', () => {
    const turns = numberSpeakers(
      parseTurns(
        [
          'Started',
          '5.000 -- 9.000 speaker_03 confidence=0.5',
          '0.500 -- 4.800 speaker_01 confidence=0.7',
          '9.200 -- 12.000 speaker_01',
        ].join('\n'),
      ),
      100,
    );
    expect(turns).toEqual([
      { start: 100.5, end: 104.8, speaker: 0, confidence: 0.7 },
      { start: 105, end: 109, speaker: 1, confidence: 0.5 },
      { start: 109.2, end: 112, speaker: 0, confidence: null },
    ]);
    const words = [
      { start: 101, end: 101.5 },
      { start: 104.6, end: 105.4 },
      { start: 112.5, end: 113 },
    ];
    expect(wordSpeakers(words, turns)).toEqual([0, 1, null]);
  });
});

describe('placements', () => {
  const clip = (extra: Partial<StoredClip>): StoredClip =>
    ({
      id: 'c1',
      type: 'media',
      media_id: 'm_x',
      kind: 'video',
      start: 0,
      in: 0,
      duration: 28_224_000 * 10,
      link: null,
      enabled: true,
      ...extra,
    }) as StoredClip;
  const tpf = 28_224_000; // 25 fps at 705 600 000 ticks a second
  const frame = { width: 1280, height: 720 };

  it('reports a punch-in, a crop and cover fit in sequence and source pixels', () => {
    const src = { width: 1280, height: 720, alpha: false };
    const pip = clipPlacements(
      clip({ transform: { scale: 0.5, x: 0.25, y: 0.25 } }),
      tpf,
      10,
      src,
      frame,
    );
    expect(pip.frames).toEqual([
      {
        frame: 0,
        picture: { x: 0, y: 0, w: 640, h: 360 },
        rotation: 0,
        opacity: 1,
        visible: { x: 0, y: 0, w: 640, h: 360 },
        source: { x: 0, y: 0, w: 1280, h: 720 },
      },
    ]);
    const cropped = clipPlacements(
      clip({ transform: { crop: { left: 0.5, right: 0, top: 0, bottom: 0 } } }),
      tpf,
      10,
      src,
      frame,
    );
    expect(cropped.frames[0]?.visible).toEqual({ x: 640, y: 0, w: 640, h: 720 });
    expect(cropped.frames[0]?.source).toEqual({ x: 640, y: 0, w: 640, h: 720 });
    // 4:3 covering 16:9: 1280x960, the middle 720 rows show.
    const cover = clipPlacements(
      clip({ transform: { fit: 'cover' } }),
      tpf,
      10,
      { width: 640, height: 480, alpha: false },
      frame,
    );
    expect(cover.frames[0]?.picture).toEqual({ x: 0, y: -120, w: 1280, h: 960 });
    expect(cover.frames[0]?.visible).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
    expect(cover.frames[0]?.source).toEqual({ x: 0, y: 60, w: 640, h: 360 });
  });

  it('reads a mask in the fitted frame, bars included', () => {
    // A 9:16 picture in 16:9 fits 405 wide; a half-width mask (640 px) keeps all of it.
    const masked = clipPlacements(
      clip({ mask: { shape: 'rectangle', width: 0.5, height: 0.5 } }),
      tpf,
      10,
      { width: 360, height: 640, alpha: false },
      frame,
    );
    expect(masked.frames[0]?.visible).toEqual({ x: 437.5, y: 180, w: 405, h: 360 });
    expect(masked.frames[0]?.source).toEqual({ x: 0, y: 160, w: 360, h: 320 });
  });

  it('keeps the frames where a move changes course', () => {
    const moving = clipPlacements(
      clip({
        transform: {
          x: {
            keyframes: [
              { t: 0, value: 0.5 },
              { t: tpf * 5, value: 0.75 },
              { t: tpf * 9, value: 0.75 },
            ],
          },
        },
      }),
      tpf,
      10,
      { width: 1280, height: 720, alpha: false },
      frame,
    );
    expect(moving.complete).toBe(true);
    expect(moving.frames.map((f) => f.frame)).toEqual([0, 5, 9]);
    expect(moving.frames[1]?.picture.x).toBe(320);
    expect(moving.frames[1]?.visible).toEqual({ x: 320, y: 0, w: 960, h: 720 });
  });
});
