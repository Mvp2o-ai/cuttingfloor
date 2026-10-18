import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BatchOp,
  diff,
  easeFn,
  frameSource,
  framesToTicks,
  fromView,
  type MediaResolver,
  migrate,
  newTimeline,
  runEdits,
  sample,
  span,
  TimelineStore,
  ticksPerFrame,
  timelineIdOf,
  toView,
  transformAt,
  Workspace,
} from '@cuttingfloor/core';
import { CfError, type MediaRef, type TimelineDoc } from '@cuttingfloor/schema';
import { describe, expect, it } from 'vitest';

const fps = { num: 25, den: 1 };
const seq = {
  width: 1920,
  height: 1080,
  fps,
  audio_rate: 48_000,
  channels: 2,
  color: 'bt709' as const,
};
const media: Record<string, MediaRef> = {
  m_aaaaaaaaaaaaaaaaaaaaaaaaav: {
    name: 'av.mp4',
    duration: framesToTicks(250, fps),
    video: true,
    audio: true,
  },
  m_aaaaaaaaaaaaaaaaaaaaaaavid: {
    name: 'vid.mp4',
    duration: framesToTicks(100, fps),
    video: true,
    audio: false,
  },
  m_aaaaaaaaaaaaaaaaaaaaaaaaud: {
    name: 'aud.wav',
    duration: framesToTicks(500, fps),
    video: false,
    audio: true,
  },
  m_aaaaaaaaaaaaaaaaaaaaaaapng: { name: 'card.png', duration: null, video: true, audio: false },
};
const resolve: MediaResolver = (id) => media[id];

function edit(doc: TimelineDoc, ...ops: BatchOp[]) {
  return runEdits(doc, 'tl_parent', ops, resolve, { tool: 'test', args: null });
}

function start() {
  return newTimeline('t', seq, { video: 1, audio: 1 });
}

/** Clips of one track as [start, end, source.in] in frames. */
function layout(doc: TimelineDoc, trackIndex: number): Array<[number, number, number]> {
  const view = toView('tl_x', doc);
  return (view.tracks[trackIndex]?.clips ?? []).map((c) => [c.start, c.end, c.source.in]);
}

describe('timelines', () => {
  it('creates video tracks before audio tracks', () => {
    const doc = newTimeline('t', seq, { video: 2, audio: 2 });
    expect(doc.tracks.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'video:V1',
      'video:V2',
      'audio:A1',
      'audio:A2',
    ]);
  });

  it('rejects frame rates that do not divide the tick rate', () => {
    expect(() =>
      newTimeline('t', { ...seq, fps: { num: 11, den: 1 } }, { video: 1, audio: 0 }),
    ).toThrow(CfError);
  });

  it('hashes equal documents to equal ids, whatever the key order', async () => {
    const a = start();
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)]),
            )
          : v;
    const b = reverse(a);
    expect(await timelineIdOf(a)).toBe(await timelineIdOf(b));
    expect(await timelineIdOf(a)).toMatch(/^tl_[0-9a-f]{32}$/);
  });
});

describe('clip.add', () => {
  it('adds a linked A/V clip on both tracks and appends by default', () => {
    let { doc, outcome } = edit(start(), {
      tool: 'clip.add',
      args: {
        track_id: 't1',
        media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaav',
        source: { in: 0, out: 50 },
      },
    });
    expect(outcome.clip_ids).toHaveLength(2);
    ({ doc } = edit(doc, {
      tool: 'clip.add',
      args: {
        track_id: 't1',
        media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaav',
        source: { in: 100, out: 120 },
      },
    }));
    expect(layout(doc, 0)).toEqual([
      [0, 50, 0],
      [50, 70, 100],
    ]);
    expect(layout(doc, 1)).toEqual([
      [0, 50, 0],
      [50, 70, 100],
    ]);
    const v = doc.tracks[0]?.clips[0];
    const a = doc.tracks[1]?.clips[0];
    expect(v?.link).toBeTruthy();
    expect(v?.link).toBe(a?.link);
  });

  it('overwrites what is underneath, cutting clips at the edges', () => {
    let { doc } = edit(start(), {
      tool: 'clip.add',
      args: {
        track_id: 't1',
        media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid',
        at_frame: 0,
        source: { in: 0, out: 100 },
      },
    });
    ({ doc } = edit(doc, {
      tool: 'clip.add',
      args: {
        track_id: 't1',
        media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid',
        at_frame: 40,
        source: { in: 0, out: 20 },
      },
    }));
    expect(layout(doc, 0)).toEqual([
      [0, 40, 0],
      [40, 60, 0],
      [60, 100, 60],
    ]);
  });

  it('inserts, splitting the clip underneath and pushing the rest right', () => {
    let { doc } = edit(start(), {
      tool: 'clip.add',
      args: {
        track_id: 't1',
        media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid',
        at_frame: 0,
        source: { in: 0, out: 100 },
      },
    });
    ({ doc } = edit(doc, {
      tool: 'clip.add',
      args: {
        track_id: 't1',
        media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid',
        at_frame: 40,
        source: { in: 0, out: 20 },
        mode: 'insert',
      },
    }));
    expect(layout(doc, 0)).toEqual([
      [0, 40, 0],
      [40, 60, 0],
      [60, 120, 40],
    ]);
  });

  it('refuses media on the wrong kind of track and past the media end', () => {
    expect(() =>
      edit(start(), {
        tool: 'clip.add',
        args: { track_id: 't2', media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid' },
      }),
    ).toThrow(/no audio/);
    expect(() =>
      edit(start(), {
        tool: 'clip.add',
        args: {
          track_id: 't1',
          media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid',
          source: { in: 90, out: 110 },
        },
      }),
    ).toThrow(/past the end/);
  });

  it('gives stills a default length and honours duration_frames', () => {
    const { doc } = edit(
      start(),
      { tool: 'clip.add', args: { track_id: 't1', media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaapng' } },
      {
        tool: 'clip.add',
        args: { track_id: 't1', media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaapng', duration_frames: 10 },
      },
    );
    expect(layout(doc, 0)).toEqual([
      [0, 125, 0],
      [125, 135, 0],
    ]);
  });

  it('creates the other track for a linked clip when none exists', () => {
    const { doc } = edit(newTimeline('t', seq, { video: 1, audio: 0 }), {
      tool: 'clip.add',
      args: {
        track_id: 't1',
        media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaav',
        source: { in: 0, out: 10 },
      },
    });
    expect(doc.tracks.map((t) => t.kind)).toEqual(['video', 'audio']);
  });

  it('refuses edits on locked tracks', () => {
    const { doc } = edit(start(), { tool: 'track.set', args: { track_id: 't1', locked: true } });
    expect(() =>
      edit(doc, {
        tool: 'clip.add',
        args: { track_id: 't1', media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid' },
      }),
    ).toThrow(/locked/);
  });
});

describe('remove, move, trim, split', () => {
  function threeClips() {
    return edit(
      start(),
      {
        tool: 'clip.add',
        args: {
          track_id: 't1',
          media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaav',
          source: { in: 0, out: 50 },
        },
      },
      {
        tool: 'clip.add',
        args: {
          track_id: 't1',
          media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaav',
          source: { in: 50, out: 100 },
        },
      },
      {
        tool: 'clip.add',
        args: {
          track_id: 't1',
          media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaav',
          source: { in: 100, out: 150 },
        },
      },
    ).doc;
  }
  const id = (doc: TimelineDoc, track: number, i: number) => doc.tracks[track]?.clips[i]?.id ?? '';

  it('removes a link group, with and without ripple', () => {
    const doc = threeClips();
    const gap = edit(doc, { tool: 'clip.remove', args: { clip_id: id(doc, 0, 1) } }).doc;
    expect(layout(gap, 0)).toEqual([
      [0, 50, 0],
      [100, 150, 100],
    ]);
    expect(layout(gap, 1)).toEqual([
      [0, 50, 0],
      [100, 150, 100],
    ]);
    const rippled = edit(doc, {
      tool: 'clip.remove',
      args: { clip_id: id(doc, 0, 1), ripple: true },
    }).doc;
    expect(layout(rippled, 0)).toEqual([
      [0, 50, 0],
      [50, 100, 100],
    ]);
    expect(layout(rippled, 1)).toEqual([
      [0, 50, 0],
      [50, 100, 100],
    ]);
  });

  it('moves a link group together and overwrites at the destination', () => {
    const doc = threeClips();
    const moved = edit(doc, {
      tool: 'clip.move',
      args: { clip_id: id(doc, 0, 0), to_frame: 125 },
    }).doc;
    expect(layout(moved, 0)).toEqual([
      [50, 100, 50],
      [100, 125, 100],
      [125, 175, 0],
    ]);
    expect(layout(moved, 1)).toEqual(layout(moved, 0));
  });

  it('moves with ripple closing the origin gap', () => {
    const doc = threeClips();
    const moved = edit(doc, {
      tool: 'clip.move',
      args: { clip_id: id(doc, 0, 0), to_frame: 100, ripple: true, mode: 'insert' },
    }).doc;
    expect(layout(moved, 0)).toEqual([
      [0, 50, 50],
      [50, 100, 100],
      [100, 150, 0],
    ]);
  });

  it('trims the end, refusing overlap unless rippling', () => {
    const doc = threeClips();
    const shorter = edit(doc, {
      tool: 'clip.trim',
      args: { clip_id: id(doc, 0, 0), edge: 'end', to_frame: 40 },
    }).doc;
    expect(layout(shorter, 0)).toEqual([
      [0, 40, 0],
      [50, 100, 50],
      [100, 150, 100],
    ]);
    expect(() =>
      edit(doc, { tool: 'clip.trim', args: { clip_id: id(doc, 0, 0), edge: 'end', to_frame: 60 } }),
    ).toThrow(/overlap/);
    const rippled = edit(doc, {
      tool: 'clip.trim',
      args: { clip_id: id(doc, 0, 0), edge: 'end', to_frame: 60, ripple: true },
    }).doc;
    expect(layout(rippled, 0)).toEqual([
      [0, 60, 0],
      [60, 110, 50],
      [110, 160, 100],
    ]);
  });

  it('trims the start with ripple, keeping the clip in place', () => {
    const doc = threeClips();
    const t = edit(doc, {
      tool: 'clip.trim',
      args: { clip_id: id(doc, 0, 1), edge: 'start', to_frame: 60, ripple: true },
    }).doc;
    expect(layout(t, 0)).toEqual([
      [0, 50, 0],
      [50, 90, 60],
      [90, 140, 100],
    ]);
  });

  it('trims only the audio for an L cut', () => {
    const doc = threeClips();
    const t = edit(doc, {
      tool: 'clip.trim',
      args: { clip_id: id(doc, 0, 0), edge: 'end', to_frame: 45, side: 'video' },
    }).doc;
    expect(layout(t, 0)[0]).toEqual([0, 45, 0]);
    expect(layout(t, 1)[0]).toEqual([0, 50, 0]);
  });

  it('refuses trims past the media', () => {
    const doc = threeClips();
    expect(() =>
      edit(doc, {
        tool: 'clip.trim',
        args: { clip_id: id(doc, 0, 0), edge: 'start', to_frame: 0, ripple: true },
      }),
    ).not.toThrow();
    expect(() =>
      edit(doc, {
        tool: 'clip.trim',
        args: { clip_id: id(doc, 0, 2), edge: 'end', to_frame: 400, ripple: true },
      }),
    ).toThrow(/past the end/);
  });

  it('splits a link group into two link groups', () => {
    const doc = threeClips();
    const { doc: s, outcome } = edit(doc, {
      tool: 'clip.split',
      args: { clip_id: id(doc, 0, 0), at_frame: 20 },
    });
    expect(layout(s, 0).slice(0, 2)).toEqual([
      [0, 20, 0],
      [20, 50, 20],
    ]);
    expect(layout(s, 1).slice(0, 2)).toEqual([
      [0, 20, 0],
      [20, 50, 20],
    ]);
    const left = s.tracks[0]?.clips[0];
    const right = s.tracks[0]?.clips[1];
    expect(right?.id).toBe(outcome.clip_id);
    expect(left?.link).not.toBe(right?.link);
    expect(right?.link).toBe(s.tracks[1]?.clips[1]?.link);
    expect(() =>
      edit(doc, { tool: 'clip.split', args: { clip_id: id(doc, 0, 0), at_frame: 50 } }),
    ).toThrow(/not inside/);
  });

  it('links and unlinks', () => {
    const doc = threeClips();
    const un = edit(doc, { tool: 'clip.unlink', args: { clip_id: id(doc, 0, 0) } }).doc;
    expect(un.tracks[0]?.clips[0]?.link).toBeNull();
    const moved = edit(un, {
      tool: 'clip.move',
      args: { clip_id: id(un, 0, 0), to_frame: 200 },
    }).doc;
    expect(layout(moved, 1)[0]).toEqual([0, 50, 0]);
    const re = edit(un, {
      tool: 'clip.link',
      args: { clip_ids: [id(un, 0, 0), id(un, 1, 0)] },
    }).doc;
    expect(re.tracks[0]?.clips[0]?.link).toBe(re.tracks[1]?.clips[0]?.link);
  });
});

describe('edit.batch', () => {
  it('resolves $refs to ids made by earlier ops', () => {
    const { doc, results } = edit(
      start(),
      { tool: 'track.add', args: { kind: 'video', name: 'Titles' } },
      {
        tool: 'clip.add',
        args: {
          track_id: { $ref: 'ops[0].track_id' },
          media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaapng',
          at_frame: 10,
        },
      },
      {
        tool: 'clip.trim',
        args: { clip_id: { $ref: 'ops[1].clip_id' }, edge: 'end', to_frame: 30 },
      },
    );
    expect(results[0]?.track_id).toBe(doc.tracks[1]?.id);
    expect(layout(doc, 1)).toEqual([[10, 30, 0]]);
  });

  it('is all or nothing and names the failing op', () => {
    const base = start();
    const before = JSON.stringify(base);
    let error: unknown;
    try {
      edit(
        base,
        { tool: 'track.add', args: { kind: 'video' } },
        { tool: 'clip.remove', args: { clip_id: 'c99' } },
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CfError);
    expect((error as CfError).message).toMatch(/^ops\[1\]/);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('rejects forward refs', () => {
    expect(() =>
      edit(
        start(),
        { tool: 'clip.remove', args: { clip_id: { $ref: 'ops[1].clip_id' } } },
        { tool: 'track.add', args: { kind: 'audio' } },
      ),
    ).toThrow(/has not run yet/);
  });
});

describe('compositing', () => {
  const V = 'm_aaaaaaaaaaaaaaaaaaaaaaavid';
  const tpf = framesToTicks(1, fps);
  const base = () =>
    edit(start(), {
      tool: 'clip.add',
      args: { track_id: 't1', media_id: V, source: { in: 20, out: 60 } },
    }).doc;
  const clip = (doc: TimelineDoc, id: string) => {
    const c = doc.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
    if (!c) throw new Error(`no ${id}`);
    return c;
  };

  it('eases from 0 to 1, with back and elastic overshooting on the way', () => {
    for (const name of [
      'linear',
      'smooth',
      'cubic_in_out',
      'expo_out',
      'back_out',
      'bounce_in',
      'elastic_out',
    ] as const) {
      expect(easeFn(name)(0)).toBeCloseTo(0, 6);
      expect(easeFn(name)(1)).toBeCloseTo(1, 6);
    }
    expect(Math.max(...[0.6, 0.7, 0.8].map(easeFn('back_out')))).toBeGreaterThan(1);
    expect(easeFn('hold')(0.99)).toBe(0);
  });

  it('stores keyframes on the content, so they survive a head trim and a split', () => {
    let doc = edit(base(), {
      tool: 'clip.set_transform',
      args: {
        clip_id: 'c3',
        x: {
          keyframes: [
            { frame: 0, value: 0 },
            { frame: 20, value: 1, ease: 'linear' },
          ],
        },
      },
    }).doc;
    // Source frame 30 is clip frame 10 of a clip that starts at source frame 20: halfway.
    expect(transformAt(clip(doc, 'c3'), tpf, 10, 40).x).toBeCloseTo(0.5);
    doc = edit(doc, {
      tool: 'clip.trim',
      args: { clip_id: 'c3', edge: 'start', to_frame: 10 },
    }).doc;
    // After trimming 10 frames off the head, the same content is at clip frame 0.
    expect(transformAt(clip(doc, 'c3'), tpf, 0, 30).x).toBeCloseTo(0.5);
    const view = toView('tl_x', doc).tracks[0]?.clips[0];
    expect(view?.transform?.x).toEqual({
      keyframes: [
        { frame: -10, value: 0 },
        { frame: 10, value: 1 },
      ],
    });
    doc = edit(doc, { tool: 'clip.split', args: { clip_id: 'c3', at_frame: 20 } }).doc;
    const right = toView('tl_x', doc).tracks[0]?.clips[1];
    expect(right?.transform?.x).toEqual({
      keyframes: [
        { frame: -20, value: 0 },
        { frame: 0, value: 1 },
      ],
    });
  });

  it('omits defaults, so resetting returns to the same timeline', async () => {
    const plain = base();
    const moved = edit(plain, {
      tool: 'clip.set_transform',
      args: { clip_id: 'c3', scale: 0.5, fit: 'cover' },
    }).doc;
    expect(clip(moved, 'c3').transform).toEqual({ scale: 0.5, fit: 'cover' });
    const reset = edit(moved, {
      tool: 'clip.set_transform',
      args: { clip_id: 'c3', scale: null, fit: 'contain' },
    }).doc;
    expect(clip(reset, 'c3').transform).toBeUndefined();
    const strip = (d: TimelineDoc) => ({ ...d, parent: null, op: null });
    expect(await timelineIdOf(strip(reset))).toBe(await timelineIdOf(strip(plain)));
  });

  it('keeps an entrance on the left of a cut and an exit on the right', () => {
    let doc = edit(base(), {
      tool: 'clip.set_animation',
      args: {
        clip_id: 'c3',
        in: { name: 'fade', duration_frames: 5 },
        out: { name: 'slide_left', duration_frames: 5 },
      },
    }).doc;
    expect(transformAt(clip(doc, 'c3'), tpf, 0, 40).opacity).toBe(0);
    expect(transformAt(clip(doc, 'c3'), tpf, 39, 40).x).toBeLessThan(0);
    doc = edit(doc, { tool: 'clip.split', args: { clip_id: 'c3', at_frame: 20 } }).doc;
    const [left, right] = doc.tracks[0]?.clips ?? [];
    expect(Object.keys(left?.animation ?? {})).toEqual(['in']);
    expect(Object.keys(right?.animation ?? {})).toEqual(['out']);
  });

  it('refuses compositing on audio clips and names the linked video clip', () => {
    const { doc } = edit(start(), {
      tool: 'clip.add',
      args: {
        track_id: 't1',
        media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaav',
        source: { in: 0, out: 10 },
      },
    });
    expect(() =>
      edit(doc, { tool: 'clip.set_blend', args: { clip_id: 'c5', mode: 'screen' } }),
    ).toThrow(expect.objectContaining({ hint: 'Use its linked video clip c4' }));
  });

  it('checks masks and round-trips every setting through timeline.load', () => {
    expect(() =>
      edit(base(), { tool: 'clip.set_mask', args: { clip_id: 'c3', mask: { shape: 'polygon' } } }),
    ).toThrow(/needs points/);
    const { doc } = edit(
      base(),
      {
        tool: 'clip.set_transform',
        args: {
          clip_id: 'c3',
          rotation: {
            keyframes: [
              { frame: 0, value: 0 },
              { frame: 9, value: 45, ease: 'back_out' },
            ],
          },
          flip: 'horizontal',
          crop: { left: 0.1 },
        },
      },
      { tool: 'clip.set_blend', args: { clip_id: 'c3', mode: 'multiply' } },
      {
        tool: 'clip.set_mask',
        args: { clip_id: 'c3', mask: { shape: 'star', feather: 0.05, invert: true } },
      },
      {
        tool: 'clip.set_animation',
        args: { clip_id: 'c3', loop: { name: 'pulse', period_frames: 25 } },
      },
      { tool: 'track.set', args: { track_id: 't1', locked: true } },
    );
    const view = toView('tl_x', doc);
    const back = fromView(view, resolve);
    expect(toView('tl_x', back)).toEqual({ ...view, parent: null });
    expect(back.tracks[0]?.locked).toBe(true);
  });

  it("refuses values outside each field's range", () => {
    expect(() =>
      edit(base(), { tool: 'clip.set_transform', args: { clip_id: 'c3', opacity: 2 } }),
    ).toThrow(/opacity 2 is out of range/);
    expect(() =>
      edit(base(), {
        tool: 'clip.set_transform',
        args: {
          clip_id: 'c3',
          scale: {
            keyframes: [
              { frame: 0, value: 1 },
              { frame: 5, value: 50 },
            ],
          },
        },
      }),
    ).toThrow(/scale 50 is out of range/);
  });

  it('migrates version 1 documents', () => {
    const v2 = base();
    const v1 = {
      ...v2,
      version: 1 as const,
      tracks: v2.tracks.map((t) => ({ ...t, clips: t.clips.map(({ type: _t, ...c }) => c) })),
    };
    expect(migrate(v1 as never)).toEqual(v2);
  });
});

describe('timing', () => {
  const AV = 'm_aaaaaaaaaaaaaaaaaaaaaaaaav';
  const tpf = framesToTicks(1, fps);
  /** A linked A/V clip at 0–100 (source 50–150) followed by one at 100–150 (source 0–50). */
  const two = () =>
    edit(
      start(),
      { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 50, out: 150 } } },
      { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 0, out: 50 } } },
    ).doc;
  const clipView = (doc: TimelineDoc, id: string) =>
    toView('tl_x', doc)
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.id === id);
  const at = (doc: TimelineDoc, id: string, frame: number) => {
    const c = doc.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
    if (!c) throw new Error(`no ${id}`);
    return frameSource(c, tpf, frame) / tpf;
  };

  it('speeds a linked clip up and ripples what follows', () => {
    const doc = edit(two(), { tool: 'clip.set_speed', args: { clip_id: 'c4', rate: 2 } }).doc;
    expect(layout(doc, 0)).toEqual([
      [0, 50, 50],
      [50, 100, 0],
    ]);
    expect(layout(doc, 1)).toEqual([
      [0, 50, 50],
      [50, 100, 0],
    ]);
    expect(clipView(doc, 'c4')).toMatchObject({ speed: { rate: 2 }, source: { in: 50, out: 150 } });
    expect(at(doc, 'c4', 10)).toBe(70);
  });

  it('ramps keep their source exactly through a split', () => {
    let doc = edit(two(), {
      tool: 'clip.set_speed',
      args: {
        clip_id: 'c4',
        curve: [
          { at: 0, rate: 1 },
          { at: 0.5, rate: 3 },
          { at: 1, rate: 1 },
        ],
      },
    }).doc;
    // Mean rate 2: the 100 source frames take 50 timeline frames.
    expect(layout(doc, 0)[0]).toEqual([0, 50, 50]);
    // Each point says where it falls in the clip and what source frame shows there.
    expect(clipView(doc, 'c4')?.speed).toMatchObject({
      curve: [
        { at: 0, rate: 1, frame: 0, source_frame: 50 },
        { at: 0.5, rate: 3, frame: 25, source_frame: 100 },
        { at: 1, rate: 1, frame: 49 },
      ],
    });
    const before = [5, 20, 30, 45].map((f) => at(doc, 'c4', f));
    doc = edit(doc, { tool: 'clip.split', args: { clip_id: 'c4', at_frame: 25 } }).doc;
    const right = doc.tracks[0]?.clips[1]?.id ?? '';
    expect([at(doc, 'c4', 5), at(doc, 'c4', 20), at(doc, right, 5), at(doc, right, 20)]).toEqual(
      before.map((v) => expect.closeTo(v, 6)),
    );
    expect(
      span(doc.tracks[0]?.clips[0] as never) + span(doc.tracks[0]?.clips[1] as never),
    ).toBeCloseTo(100 * tpf, -2);
  });

  it('reverses: the clip plays its source from the end, and trims cut from the right end', () => {
    let doc = edit(two(), { tool: 'clip.set_speed', args: { clip_id: 'c4', reverse: true } }).doc;
    // Its first frame is the source's last frame (149), its last frame the first (50).
    expect(at(doc, 'c4', 0)).toBe(149);
    expect(at(doc, 'c4', 99)).toBe(50);
    doc = edit(doc, {
      tool: 'clip.trim',
      args: { clip_id: 'c4', edge: 'end', to_frame: 90, ripple: true },
    }).doc;
    // Trimming the tail of a reversed clip removes the start of its source.
    expect(clipView(doc, 'c4')?.source).toEqual({ in: 60, out: 150 });
    expect(at(doc, 'c4', 0)).toBe(149);
  });

  it('freezes a frame, splitting the clip and opening a gap in its sound', () => {
    const { doc, results } = edit(two(), {
      tool: 'clip.freeze',
      args: { clip_id: 'c4', at_frame: 40, duration_frames: 25 },
    });
    const frozen = results[0]?.clip_id ?? '';
    expect(layout(doc, 0)).toEqual([
      [0, 40, 50],
      [40, 65, 90],
      [65, 125, 90],
      [125, 175, 0],
    ]);
    expect(layout(doc, 1)).toEqual([
      [0, 40, 50],
      [65, 125, 90],
      [125, 175, 0],
    ]);
    expect(clipView(doc, frozen)).toMatchObject({ speed: { rate: 0 }, link: null });
    expect([at(doc, frozen, 0), at(doc, frozen, 24)]).toEqual([90, 90]);
  });

  it('rolls, slips and slides', () => {
    // The next clip starts at source 0, so the cut can only roll later.
    const rolled = edit(two(), { tool: 'clip.roll', args: { clip_id: 'c4', to_frame: 110 } }).doc;
    expect(layout(rolled, 0)).toEqual([
      [0, 110, 50],
      [110, 150, 10],
    ]);
    expect(layout(rolled, 1)).toEqual([
      [0, 110, 50],
      [110, 150, 10],
    ]);
    expect(() => edit(two(), { tool: 'clip.roll', args: { clip_id: 'c4', to_frame: 90 } })).toThrow(
      /before the beginning of its media/,
    );
    const slipped = edit(two(), { tool: 'clip.slip', args: { clip_id: 'c4', by_frames: -20 } }).doc;
    expect(layout(slipped, 0)[0]).toEqual([0, 100, 30]);
    expect(layout(slipped, 1)[0]).toEqual([0, 100, 30]);
    const three = edit(two(), { tool: 'clip.split', args: { clip_id: 'c4', at_frame: 50 } }).doc;
    const middle = three.tracks[0]?.clips[1]?.id ?? '';
    const slid = edit(three, { tool: 'clip.slide', args: { clip_id: middle, to_frame: 60 } }).doc;
    expect(layout(slid, 0)).toEqual([
      [0, 60, 50],
      [60, 110, 100],
      [110, 150, 10],
    ]);
    expect(layout(slid, 1)).toEqual([
      [0, 60, 50],
      [60, 110, 100],
      [110, 150, 10],
    ]);
  });

  it('replaces media in place', () => {
    const doc = edit(two(), {
      tool: 'clip.replace',
      args: { clip_id: 'c4', media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid', source_in: 0 },
    }).doc;
    expect(clipView(doc, 'c4')).toMatchObject({
      media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid',
      start: 0,
      end: 100,
    });
    expect(() =>
      edit(two(), {
        tool: 'clip.replace',
        args: { clip_id: 'c5', media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid' },
      }),
    ).toThrow(/has no audio/);
  });

  it('extracts a range across tracks, relinking what is cut off', () => {
    const { doc } = edit(two(), { tool: 'range.extract', args: { range: { start: 30, end: 60 } } });
    expect(layout(doc, 0)).toEqual([
      [0, 30, 50],
      [30, 70, 110],
      [70, 120, 0],
    ]);
    expect(layout(doc, 1)).toEqual([
      [0, 30, 50],
      [30, 70, 110],
      [70, 120, 0],
    ]);
    const [l1, r1] = doc.tracks[0]?.clips ?? [];
    const [l2, r2] = doc.tracks[1]?.clips ?? [];
    expect(l1?.link).toBe(l2?.link);
    expect(r1?.link).toBe(r2?.link);
    expect(l1?.link).not.toBe(r1?.link);
    const lifted = edit(two(), {
      tool: 'range.lift',
      args: { range: { start: 30, end: 60 }, track_ids: ['t1'] },
    }).doc;
    expect(layout(lifted, 0)).toEqual([
      [0, 30, 50],
      [60, 100, 110],
      [100, 150, 0],
    ]);
    expect(layout(lifted, 1)).toEqual([
      [0, 100, 50],
      [100, 150, 0],
    ]);
  });

  it('round-trips speed through timeline.load', () => {
    const { doc } = edit(
      two(),
      {
        tool: 'clip.set_speed',
        args: {
          clip_id: 'c4',
          curve: [
            { at: 0, rate: 0.5 },
            { at: 1, rate: 2 },
          ],
          reverse: true,
          preserve_pitch: false,
        },
      },
      { tool: 'clip.freeze', args: { clip_id: 'c7', at_frame: 90, duration_frames: 10 } },
    );
    const view = toView('tl_x', doc);
    expect(toView('tl_x', fromView(view, resolve))).toEqual({ ...view, parent: null });
  });
});

describe('nested timelines', () => {
  const AV = 'm_aaaaaaaaaaaaaaaaaaaaaaaaav';
  const inner = () =>
    edit(
      start(),
      { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 0, out: 40 } } },
      { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 100, out: 120 } } },
    ).doc;
  const nestIn = (outer: TimelineDoc, store: Record<string, TimelineDoc>, ...ops: BatchOp[]) =>
    runEdits(outer, 'tl_parent', ops, resolve, { tool: 'test', args: null }, (id) => store[id]);

  it('nests a timeline as a linked compound clip that stands alone', () => {
    const store = { tl_00000000000000000000000000000001: inner() };
    const { doc } = nestIn(start(), store, {
      tool: 'clip.add',
      args: { track_id: 't1', nested_timeline_id: 'tl_00000000000000000000000000000001' },
    });
    expect(layout(doc, 0)).toEqual([[0, 60, 0]]);
    expect(layout(doc, 1)).toEqual([[0, 60, 0]]);
    expect(Object.keys(doc.nested ?? {})).toEqual(['tl_00000000000000000000000000000001']);
    expect(doc.media).toEqual({});
    const view = toView('tl_x', doc);
    expect(view.tracks[0]?.clips[0]).toMatchObject({
      type: 'timeline',
      nested_timeline: 'tl_00000000000000000000000000000001',
    });
    expect(view.nested?.tl_00000000000000000000000000000001?.duration).toBe(60);
    expect(toView('tl_x', fromView(view, resolve))).toEqual({ ...view, parent: null });
  });

  it('nests only timelines of the same shape, and says how to place another shape', () => {
    const store: Record<string, TimelineDoc> = {
      tl_00000000000000000000000000000001: inner(),
    };
    const tall = { ...seq, width: seq.height, height: seq.width };
    expect(() =>
      nestIn(newTimeline('t', tall, { video: 1, audio: 1 }), store, {
        tool: 'clip.add',
        args: { track_id: 't1', nested_timeline_id: 'tl_00000000000000000000000000000001' },
      }),
    ).toThrow(/different shape/);
    // Same shape at another size nests; reshaping the parent afterwards is refused.
    const half = { ...seq, width: seq.width / 2, height: seq.height / 2 };
    const { doc } = nestIn(newTimeline('t', half, { video: 1, audio: 1 }), store, {
      tool: 'clip.add',
      args: { track_id: 't1', nested_timeline_id: 'tl_00000000000000000000000000000001' },
    });
    expect(() => edit(doc, { tool: 'timeline.set_sequence', args: { sequence: tall } })).toThrow(
      /different shape/,
    );
  });

  it('flattens nesting, edits compound clips like any clip, and drops what is no longer used', () => {
    const store: Record<string, TimelineDoc> = { tl_00000000000000000000000000000001: inner() };
    store.tl_00000000000000000000000000000002 = nestIn(start(), store, {
      tool: 'clip.add',
      args: { track_id: 't1', nested_timeline_id: 'tl_00000000000000000000000000000001' },
    }).doc;
    let { doc } = nestIn(start(), store, {
      tool: 'clip.add',
      args: {
        track_id: 't1',
        nested_timeline_id: 'tl_00000000000000000000000000000002',
        av: 'video',
      },
    });
    expect(Object.keys(doc.nested ?? {}).sort()).toEqual([
      'tl_00000000000000000000000000000001',
      'tl_00000000000000000000000000000002',
    ]);
    doc = edit(doc, {
      tool: 'clip.trim',
      args: { clip_id: 'c3', edge: 'start', to_frame: 10 },
    }).doc;
    doc = edit(doc, { tool: 'clip.set_transform', args: { clip_id: 'c3', scale: 0.5 } }).doc;
    expect(layout(doc, 0)).toEqual([[10, 60, 10]]);
    expect(() => edit(doc, { tool: 'clip.set_speed', args: { clip_id: 'c3', rate: 2 } })).toThrow(
      /nested timeline/,
    );
    doc = edit(doc, { tool: 'clip.replace', args: { clip_id: 'c3', media_id: AV } }).doc;
    expect(doc.tracks[0]?.clips[0]).toMatchObject({
      type: 'media',
      media_id: AV,
      transform: { scale: 0.5 },
    });
    expect(doc.nested).toBeUndefined();
  });

  it('refuses unknown and empty timelines', () => {
    expect(() =>
      nestIn(
        start(),
        {},
        {
          tool: 'clip.add',
          args: { track_id: 't1', nested_timeline_id: 'tl_00000000000000000000000000000009' },
        },
      ),
    ).toThrow(/No timeline/);
    expect(() =>
      nestIn(
        start(),
        { tl_00000000000000000000000000000003: start() },
        {
          tool: 'clip.add',
          args: { track_id: 't1', nested_timeline_id: 'tl_00000000000000000000000000000003' },
        },
      ),
    ).toThrow(/empty/);
  });
});

describe('transitions', () => {
  const AV = 'm_aaaaaaaaaaaaaaaaaaaaaaaaav';
  /** Linked A/V clips at 0–100 (source 50–150) and 100–150 (source 50–100). */
  const two = () =>
    edit(
      start(),
      { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 50, out: 150 } } },
      { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 50, out: 100 } } },
    ).doc;

  it('overlaps the clips by default, crossfading the linked sound at the same cut', () => {
    const { doc, results } = edit(two(), {
      tool: 'transition.add',
      args: { clip_id: 'c4', kind: 'dissolve', duration_frames: 20 },
    });
    // 10 frames come off each side of the cut and the second clip moves 20 earlier.
    expect(layout(doc, 0)).toEqual([
      [0, 90, 50],
      [90, 130, 60],
    ]);
    expect(layout(doc, 1)).toEqual([
      [0, 90, 50],
      [90, 130, 60],
    ]);
    const view = toView('tl_x', doc);
    expect(view.tracks[0]?.transitions).toEqual([
      {
        id: results[0]?.clip_ids?.[0],
        from_clip_id: 'c4',
        to_clip_id: 'c7',
        kind: 'dissolve',
        start: 80,
        end: 100,
      },
    ]);
    expect(view.tracks[1]?.transitions?.[0]).toMatchObject({
      kind: 'crossfade',
      start: 80,
      end: 100,
    });
    expect(toView('tl_x', fromView(view, resolve))).toEqual({ ...view, parent: null });
  });

  it('uses handles without moving anything, and refuses when there is no source past the cut', () => {
    const { doc } = edit(two(), {
      tool: 'transition.add',
      args: { clip_id: 'c4', kind: 'wipe_left', duration_frames: 20, mode: 'handles' },
    });
    expect(layout(doc, 0)).toEqual([
      [0, 100, 50],
      [100, 150, 50],
    ]);
    const tight = edit(
      start(),
      { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 200, out: 250 } } },
      { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 0, out: 50 } } },
    ).doc;
    expect(() =>
      edit(tight, {
        tool: 'transition.add',
        args: { clip_id: 'c4', kind: 'dissolve', duration_frames: 10, mode: 'handles' },
      }),
    ).toThrow(/too little source past its end/);
  });

  it('takes crossfades on audio only, and needs touching clips', () => {
    // On a linked video clip a crossfade goes on its sound; the picture cuts hard. Overlapping
    // the sound alone would pull it out of sync, so it needs handles.
    expect(() =>
      edit(two(), {
        tool: 'transition.add',
        args: { clip_id: 'c4', kind: 'crossfade', duration_frames: 10 },
      }),
    ).toThrow(/out of sync/);
    const before = two();
    const { doc } = edit(before, {
      tool: 'transition.add',
      args: { clip_id: 'c4', kind: 'crossfade', duration_frames: 4, mode: 'handles' },
    });
    expect(doc.tracks[0]?.transitions).toBeUndefined();
    expect(doc.tracks[1]?.transitions).toMatchObject([{ kind: 'crossfade' }]);
    // The edit says which transition it added, where, and what kind.
    expect(diff(before, doc)).toEqual([
      {
        id: doc.tracks[1]?.transitions?.[0]?.id,
        type: 'transition',
        change: 'added',
        track_id: doc.tracks[1]?.id,
        kind: 'crossfade',
        start: 98,
        end: 102,
      },
    ]);
    // A video clip with no sound linked to it takes no crossfade.
    const unlinked = edit(two(), { tool: 'clip.unlink', args: { clip_id: 'c4' } }).doc;
    expect(() =>
      edit(unlinked, {
        tool: 'transition.add',
        args: { clip_id: 'c4', kind: 'crossfade', duration_frames: 4, mode: 'handles' },
      }),
    ).toThrow(/for audio tracks/);
    const apart = edit(two(), { tool: 'clip.move', args: { clip_id: 'c7', to_frame: 120 } }).doc;
    expect(() =>
      edit(apart, {
        tool: 'transition.add',
        args: { clip_id: 'c4', kind: 'dissolve', duration_frames: 10 },
      }),
    ).toThrow(/no cut/);
  });

  it('shortens a transition a speed change leaves short of source, instead of dropping it', () => {
    // An overlap transition trims each clip by half its length to make handles; speeding the
    // second clip up then needs more source before its start than those handles hold.
    const placed = edit(
      start(),
      { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 200, out: 250 } } },
      { tool: 'clip.add', args: { track_id: 't1', media_id: AV, source: { in: 0, out: 50 } } },
    );
    const [a, b] = [placed.results[0]?.clip_id ?? '', placed.results[1]?.clip_id ?? ''];
    const withTransition = edit(placed.doc, {
      tool: 'transition.add',
      args: { clip_id: a, kind: 'dip_to_black', duration_frames: 12 },
    });
    const id = withTransition.results[0]?.clip_ids?.[0] ?? '';
    const faster = edit(withTransition.doc, {
      tool: 'clip.set_speed',
      args: { clip_id: b, rate: 1.5 },
    });
    expect(faster.outcome.warnings.join('\n')).toMatch(
      new RegExp(`Transition ${id} shortened from 12 to \\d+ frames`),
    );
    const kept = toView('tl_x', faster.doc).tracks[0]?.transitions?.[0];
    expect(kept?.id).toBe(id);
    expect((kept?.end ?? 0) - (kept?.start ?? 0)).toBeLessThan(12);
  });

  it('drops a transition an edit breaks, and says so', () => {
    const { doc, results } = edit(two(), {
      tool: 'transition.add',
      args: { clip_id: 'c4', kind: 'slide_left', duration_frames: 10 },
    });
    const id = results[0]?.clip_ids?.[0] ?? '';
    const moved = edit(doc, { tool: 'clip.move', args: { clip_id: 'c7', to_frame: 140 } });
    expect(moved.outcome.warnings).toContain(
      `Transition ${id} was removed: its clips no longer touch`,
    );
    expect(toView('tl_x', moved.doc).tracks[0]?.transitions).toBeUndefined();
    const longer = edit(doc, {
      tool: 'transition.set',
      args: { transition_id: id, kind: 'push_up', duration_frames: 16 },
    }).doc;
    expect(toView('tl_x', longer).tracks[0]?.transitions?.[0]).toMatchObject({
      kind: 'push_up',
      start: 87,
      end: 103,
    });
    const gone = edit(doc, { tool: 'transition.remove', args: { transition_id: id } }).doc;
    expect(toView('tl_x', gone).tracks[0]?.transitions).toBeUndefined();
  });
});

describe('text', () => {
  const textStart = () => newTimeline('t', seq, { video: 2, audio: 0 });

  it('previews a revealed title once it is fully shown', () => {
    const tpf = ticksPerFrame(seq.fps);
    const typed = edit(textStart(), {
      tool: 'title.add',
      args: {
        track_id: 't2',
        text: 'Hi',
        at_frame: 10,
        style: { reveal: 'typewriter', reveal_frames: 15 },
      },
    });
    expect(typed.outcome.focus / tpf).toBe(25);
    const plain = edit(textStart(), {
      tool: 'title.add',
      args: { track_id: 't2', text: 'Hi', at_frame: 10 },
    });
    expect(plain.outcome.focus / tpf).toBe(10);
  });

  it('says when a title or caption covers text already on its track', () => {
    const { outcome, doc } = edit(
      textStart(),
      {
        tool: 'title.add',
        args: { track_id: 't2', text: 'First', at_frame: 0, duration_frames: 70 },
      },
      {
        tool: 'title.add',
        args: { track_id: 't2', text: 'Second', at_frame: 14, duration_frames: 30 },
      },
      {
        tool: 'title.add',
        args: { track_id: 't2', text: 'Third', at_frame: 100, duration_frames: 10 },
      },
      {
        tool: 'title.add',
        args: { track_id: 't2', text: 'Fourth', at_frame: 95, duration_frames: 20 },
      },
    );
    expect(layout(doc, 1).map(([a, b]) => [a, b])).toEqual([
      [0, 14],
      [14, 44],
      [44, 70],
      [95, 115],
    ]);
    expect(outcome.warnings).toEqual([
      'c4 covers part of c3 on t2 (frames 0–70), which now plays 0–14 and 44–70. To show both, put one on another track or move it',
      'c7 replaced c6 on t2 (frames 100–110), which is gone. To show both, put one on another track or move it',
    ]);
    // Text that lands on an empty stretch says nothing.
    expect(
      edit(textStart(), { tool: 'title.add', args: { track_id: 't2', text: 'Alone' } }).outcome
        .warnings,
    ).toEqual([]);
  });

  it('adds a styled title and restyles it, with null resetting a field', () => {
    let { doc } = edit(textStart(), {
      tool: 'title.add',
      args: {
        track_id: 't2',
        text: 'Hello',
        at_frame: 10,
        style: { size: 0.1, box: { color: '#000000AA', padding: 0.3 } },
      },
    });
    expect(layout(doc, 1)).toEqual([[10, 85, 0]]);
    expect(doc.tracks[1]?.clips[0]).toMatchObject({
      type: 'title',
      text: 'Hello',
      style: { size: 0.1 },
    });
    doc = edit(doc, {
      tool: 'text.set',
      args: { clip_ids: ['c3'], text: 'Hi', style: { color: '#FF0000', box: null } },
    }).doc;
    expect(doc.tracks[1]?.clips[0]).toMatchObject({
      text: 'Hi',
      style: { size: 0.1, color: '#FF0000' },
    });
    expect(doc.tracks[1]?.clips[0]).toHaveProperty('style.box', null);
    expect(() =>
      edit(textStart(), { tool: 'title.add', args: { track_id: 't9', text: 'x' } }),
    ).toThrow(/No track/);
  });

  it('adds captions from segments with word timings that ride along with trims', () => {
    let { doc, results } = edit(textStart(), {
      tool: 'caption.add',
      args: {
        track_id: 't2',
        segments: [
          {
            start_frame: 0,
            end_frame: 50,
            text: 'one two',
            words: [
              { text: 'one', start_frame: 5, end_frame: 20 },
              { text: 'two', start_frame: 25, end_frame: 45 },
            ],
          },
          { start_frame: 60, end_frame: 90, text: 'three' },
        ],
        style: { highlight: { mode: 'word', color: '#FFE000' } },
      },
    });
    expect(results[0]?.clip_ids).toEqual(['c3', 'c4']);
    const view = () => toView('tl_x', doc).tracks[1]?.clips[0];
    expect(view()?.words).toEqual([
      { text: 'one', start: 5, end: 20 },
      { text: 'two', start: 25, end: 45 },
    ]);
    doc = edit(doc, {
      tool: 'clip.trim',
      args: { clip_id: 'c3', edge: 'start', to_frame: 10 },
    }).doc;
    // The words stay on the same timeline frames, so from the new start they are 10 earlier.
    expect(view()?.words).toEqual([
      { text: 'one', start: -5, end: 10 },
      { text: 'two', start: 15, end: 35 },
    ]);
    const v = toView('tl_x', doc);
    expect(toView('tl_x', fromView(v, resolve))).toEqual({ ...v, parent: null });
    doc = edit(doc, { tool: 'text.set', args: { track_id: 't2', style: { size: 0.05 } } }).doc;
    expect(
      doc.tracks[1]?.clips.map((c) => (c as { style?: { size?: number } }).style?.size),
    ).toEqual([0.05, 0.05]);
  });

  it('reads SubRip and WebVTT, including WebVTT word timestamps', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:02,000\n<i>Hello</i> there\n\n2\n00:00:02,500 --> 00:00:04,000\nSecond line\n';
    const { doc } = edit(textStart(), {
      tool: 'caption.add',
      args: { track_id: 't2', srt, offset_frames: 5 },
    });
    expect(layout(doc, 1)).toEqual([
      [30, 55, 0],
      [68, 105, 0],
    ]);
    expect(toView('tl_x', doc).tracks[1]?.clips[0]?.text).toBe('Hello there');
    const vtt =
      'WEBVTT\n\n00:01.000 --> 00:02.000\n<00:01.000>Hello <00:01.400>big <00:01.800>world\n';
    const fromVtt = edit(textStart(), { tool: 'caption.add', args: { track_id: 't2', vtt } }).doc;
    expect(toView('tl_x', fromVtt).tracks[1]?.clips[0]?.words).toEqual([
      { text: 'Hello', start: 0, end: 10 },
      { text: 'big', start: 10, end: 20 },
      { text: 'world', start: 20, end: 25 },
    ]);
    expect(() =>
      edit(textStart(), { tool: 'caption.add', args: { track_id: 't2', vtt: 'nope' } }),
    ).toThrow(/WEBVTT/);
    expect(() =>
      edit(textStart(), { tool: 'caption.add', args: { track_id: 't2', srt, vtt } }),
    ).toThrow(/exactly one/);
  });
});

describe('audio', () => {
  const AV = 'm_aaaaaaaaaaaaaaaaaaaaaaaaav';
  const AUD = 'm_aaaaaaaaaaaaaaaaaaaaaaaaud';
  const base = () =>
    edit(start(), {
      tool: 'clip.add',
      args: { track_id: 't1', media_id: AV, source: { in: 0, out: 100 } },
    }).doc;

  it("sets gain on a video clip's linked sound, pans and fades", () => {
    const { doc, outcome } = edit(
      base(),
      { tool: 'audio.set_gain', args: { clip_id: 'c4', gain_db: -6 } },
      {
        tool: 'audio.set_pan',
        args: {
          clip_id: 'c5',
          pan: 0.5,
        },
      },
      { tool: 'audio.fade', args: { clip_id: 'c5', in_frames: 10, out_frames: 20 } },
    );
    const view = toView('tl_x', doc).tracks[1]?.clips[0];
    expect(view).toMatchObject({
      gain: -6,
      pan: 0.5,
      fade: { in_frames: 10, out_frames: 20 },
    });
    expect(toView('tl_x', doc).tracks[0]?.clips[0]).not.toHaveProperty('gain');
    expect(outcome.audio).toEqual({ start: 0, end: framesToTicks(100, fps) });
    const reset = edit(doc, { tool: 'audio.set_gain', args: { clip_id: 'c5', gain_db: null } }).doc;
    expect(reset.tracks[1]?.clips[0]).not.toHaveProperty('gain');
    expect(
      () =>
        edit(start(), {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid' },
        }) &&
        edit(
          edit(start(), {
            tool: 'clip.add',
            args: { track_id: 't1', media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid' },
          }).doc,
          { tool: 'audio.set_gain', args: { clip_id: 'c3', gain_db: -3 } },
        ),
    ).toThrow(/has no sound/);
  });

  it('sets the master and round-trips everything through timeline.load', () => {
    const { doc } = edit(
      base(),
      { tool: 'audio.set_master', args: { gain_db: 4.5, limit_db: -1.5 } },
      {
        tool: 'audio.set_gain',
        args: {
          clip_id: 'c5',
          gain_db: {
            keyframes: [
              { frame: 0, value: 0 },
              { frame: 99, value: -20 },
            ],
          },
        },
      },
      { tool: 'audio.fade', args: { clip_id: 'c5', out_frames: 12 } },
    );
    const view = toView('tl_x', doc);
    expect(view.master).toEqual({ gain_db: 4.5, limit_db: -1.5 });
    expect(toView('tl_x', fromView(view, resolve))).toEqual({ ...view, parent: null });
    const cleared = edit(doc, {
      tool: 'audio.set_master',
      args: { gain_db: null, limit_db: null },
    }).doc;
    expect(cleared.master).toBeUndefined();
  });
});

describe('effects', () => {
  const AV = 'm_aaaaaaaaaaaaaaaaaaaaaaaaav';
  const LUT = 'm_aaaaaaaaaaaaaaaaaaaaaaalut';
  const withLut: MediaResolver = (id) =>
    id === LUT
      ? { name: 'look.cube', duration: null, video: false, audio: false, kind: 'lut' }
      : resolve(id);
  const run = (doc: TimelineDoc, ...ops: BatchOp[]) =>
    runEdits(doc, 'tl_parent', ops, withLut, { tool: 'test', args: null });
  const base = () =>
    run(newTimeline('t', seq, { video: 2, audio: 1 }), {
      tool: 'clip.add',
      args: { track_id: 't1', media_id: AV, source: { in: 0, out: 100 } },
    }).doc;

  it('adds effects to a clip, a track and the timeline, checked against the registry', () => {
    const { doc, results } = run(
      base(),
      {
        tool: 'filter.add',
        args: {
          clip_id: 'c5',
          name: 'blur',
          params: {
            radius: {
              keyframes: [
                { frame: 0, value: 0 },
                { frame: 50, value: 0.05 },
              ],
            },
          },
        },
      },
      { tool: 'filter.add', args: { track_id: 't1', name: 'lut', params: { media_id: LUT } } },
      { tool: 'filter.add', args: { timeline: true, name: 'vignette', params: {} } },
      { tool: 'filter.add', args: { clip_id: 'c6', name: 'compressor', params: { ratio: 6 } } },
    );
    const ids = results.map((r) => r.clip_id);
    expect(new Set(ids).size).toBe(4);
    const view = toView('tl_x', doc);
    expect(view.tracks[0]?.clips[0]?.effects).toEqual([
      {
        id: ids[0],
        name: 'blur',
        params: {
          radius: {
            keyframes: [
              { frame: 0, value: 0 },
              { frame: 50, value: 0.05 },
            ],
          },
        },
      },
    ]);
    expect(view.tracks[0]?.effects?.[0]).toMatchObject({ name: 'lut', params: { media_id: LUT } });
    expect(view.effects?.[0]).toMatchObject({ name: 'vignette' });
    expect(toView('tl_x', fromView(view, withLut))).toEqual({ ...view, parent: null });
    expect(() =>
      run(base(), { tool: 'filter.add', args: { clip_id: 'c5', name: 'nope' } }),
    ).toThrow(/No effect named/);
    expect(() =>
      run(base(), { tool: 'filter.add', args: { clip_id: 'c6', name: 'blur' } }),
    ).toThrow(/video effect/);
    expect(() =>
      run(base(), {
        tool: 'filter.add',
        args: { clip_id: 'c5', name: 'saturation', params: { amount: 9 } },
      }),
    ).toThrow(/amount/);
    expect(() =>
      run(base(), {
        tool: 'filter.add',
        args: { clip_id: 'c5', name: 'lut', params: { media_id: AV } },
      }),
    ).toThrow(/not an imported LUT/);
  });

  it('sets, turns off and removes an effect, and gives split halves their own ids', () => {
    let { doc, results } = run(base(), {
      tool: 'filter.add',
      args: { clip_id: 'c5', name: 'saturation', params: { amount: 0.5 } },
    });
    const id = results[0]?.clip_id ?? '';
    doc = run(doc, {
      tool: 'filter.set',
      args: { filter_id: id, params: { amount: 2 }, enabled: false },
    }).doc;
    expect(toView('tl_x', doc).tracks[0]?.clips[0]?.effects).toEqual([
      { id, name: 'saturation', params: { amount: 2 }, enabled: false },
    ]);
    doc = run(doc, { tool: 'clip.split', args: { clip_id: 'c5', at_frame: 40 } }).doc;
    const [left, right] = toView('tl_x', doc).tracks[0]?.clips ?? [];
    expect(left?.effects?.[0]?.id).toBe(id);
    expect(right?.effects?.[0]?.id).not.toBe(id);
    doc = run(doc, { tool: 'filter.remove', args: { filter_id: id } }).doc;
    expect(toView('tl_x', doc).tracks[0]?.clips[0]?.effects).toBeUndefined();
  });

  it('adds adjustment clips, and keeps effect and transition ids unique after a load', () => {
    let { doc } = run(base(), {
      tool: 'adjustment.add',
      args: { track_id: 't2', at_frame: 10, duration_frames: 30 },
    });
    doc = run(doc, { tool: 'filter.add', args: { clip_id: 'c7', name: 'grayscale' } }).doc;
    expect(toView('tl_x', doc).tracks[1]?.clips[0]).toMatchObject({
      type: 'adjustment',
      start: 10,
      end: 40,
    });
    const loaded = fromView(toView('tl_x', doc), withLut);
    const next = run(loaded, { tool: 'filter.add', args: { clip_id: 'c7', name: 'sepia' } });
    const effectIds = toView('tl_x', next.doc).tracks[1]?.clips[0]?.effects?.map((e) => e.id);
    expect(new Set(effectIds).size).toBe(2);
  });
});

describe('transcripts', () => {
  const AV = 'm_aaaaaaaaaaaaaaaaaaaaaaaaav';
  // Ten words, each 0.4 s long with 0.1 s between, from 1 s.
  const words = Array.from({ length: 10 }, (_, i) => ({
    text: i === 4 ? 'end.' : `w${i}`,
    start: 1 + i * 0.5,
    end: 1 + i * 0.5 + 0.4,
  }));
  const facts = (id: string) => (id === AV ? { words } : undefined);
  const run = (doc: TimelineDoc, ...ops: BatchOp[]) =>
    runEdits(doc, 'tl_parent', ops, resolve, { tool: 'test', args: null }, undefined, facts);
  const textStart = () => newTimeline('t', seq, { video: 2, audio: 1 });

  it('cuts a clip to a range of words', () => {
    const { doc } = run(textStart(), {
      tool: 'clip.add',
      args: { track_id: 't1', media_id: AV, source: { words: [2, 3] } },
    });
    // Word 2 starts at 2 s (frame 50); word 3 ends at 2.9 s (frame 72.5, rounded up).
    expect(layout(doc, 0)).toEqual([[0, 23, 50]]);
    expect(() =>
      run(textStart(), {
        tool: 'clip.add',
        args: { track_id: 't1', media_id: AV, source: { words: [3, 20] } },
      }),
    ).toThrow(/not in the transcript/);
  });

  it('captions in source seconds, placed where they play through a speed change', () => {
    let { doc } = run(textStart(), {
      tool: 'clip.add',
      args: { track_id: 't1', media_id: AV, source: { in: 0, out: 200 } },
    });
    doc = run(doc, { tool: 'clip.set_speed', args: { clip_id: 'c5', rate: 2 } }).doc;
    const { doc: captioned, results } = run(doc, {
      tool: 'caption.add',
      args: {
        track_id: 't2',
        in_clip: {
          clip_id: 'c5',
          segments: [
            { start: 1, end: 2.9, text: 'w0 w1 w2 w3', words: words.slice(0, 4) },
            { start: 3, end: 3.4, text: 'end.' },
          ],
        },
      },
    });
    const clips = toView('tl_x', captioned).tracks[1]?.clips ?? [];
    expect(clips.map((c) => c.text)).toEqual(['w0 w1 w2 w3', 'end.']);
    // At 2× source 1 s (frame 25) plays from timeline frame 12 or 13.
    expect(clips[0]?.start).toBeGreaterThanOrEqual(12);
    expect(clips[0]?.start).toBeLessThanOrEqual(13);
    expect(clips[0]?.words?.length).toBe(4);
    expect(results[0]?.clip_ids).toHaveLength(2);
  });

  it('leaves out what does not play and trims what partly plays', () => {
    // Source 1.36–3.04 s plays: the end of w0, and the first 0.04 s of "end.".
    let { doc } = run(textStart(), {
      tool: 'clip.add',
      args: { track_id: 't1', media_id: AV, source: { in: 34, out: 76 } },
    });
    doc = run(doc, {
      tool: 'caption.add',
      args: {
        track_id: 't2',
        in_clip: {
          clip_id: 'c5',
          segments: [
            { start: 0, end: 1, text: 'before' },
            { start: 1, end: 2.9, text: 'w0 w1 w2 w3' },
            { start: 3, end: 3.4, text: 'end.' },
          ],
        },
      },
    }).doc;
    const clips = toView('tl_x', doc).tracks[1]?.clips ?? [];
    expect(clips.map((c) => [c.text, c.start, c.end])).toEqual([
      ['w0 w1 w2 w3', 0, 39],
      ['end.', 41, 42],
    ]);
  });
});

describe('time and views', () => {
  it('keeps clip times when the frame rate changes', () => {
    let { doc } = edit(start(), {
      tool: 'clip.add',
      args: {
        track_id: 't1',
        media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaavid',
        at_frame: 50,
        source: { in: 0, out: 25 },
      },
    });
    ({ doc } = edit(doc, {
      tool: 'timeline.set_sequence',
      args: { sequence: { ...seq, fps: { num: 50, den: 1 } } },
    }));
    expect(layout(doc, 0)).toEqual([[100, 150, 0]]);
    ({ doc } = edit(doc, {
      tool: 'timeline.set_sequence',
      args: { sequence: { ...seq, fps: { num: 30000, den: 1001 } } },
    }));
    expect(layout(doc, 0)).toEqual([[60, 90, 0]]);
  });

  it('refuses a loaded caption whose words and text disagree', () => {
    const { doc } = edit(newTimeline('t', seq, { video: 2, audio: 0 }), {
      tool: 'caption.add',
      args: {
        track_id: 't2',
        segments: [
          {
            start_frame: 0,
            end_frame: 20,
            text: 'Hello there',
            words: [
              { text: 'Hello', start_frame: 0, end_frame: 10 },
              { text: 'there', start_frame: 10, end_frame: 20 },
            ],
          },
        ],
      },
    });
    const view = toView('tl_x', doc);
    const caption = view.tracks[1]?.clips[0] as { text: string; words: Array<{ text: string }> };
    caption.text = 'HELLO THERE';
    expect(() => fromView(view, resolve)).toThrow(
      /words spell "Hello there" but its text is "HELLO THERE"/,
    );
    for (const w of caption.words) w.text = w.text.toUpperCase();
    expect(() => fromView(view, resolve)).not.toThrow();
  });

  it('round-trips through the view and reports a structural diff', () => {
    const { doc } = edit(
      start(),
      {
        tool: 'clip.add',
        args: {
          track_id: 't1',
          media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaav',
          source: { in: 0, out: 50 },
        },
      },
      { tool: 'clip.split', args: { clip_id: { $ref: 'ops[0].clip_id' }, at_frame: 10 } },
    );
    const view = toView('tl_x', doc);
    const back = fromView(view, resolve);
    expect(toView('tl_x', back).tracks).toEqual(view.tracks);
    const { doc: next } = edit(back, {
      tool: 'clip.remove',
      args: { clip_id: view.tracks[0]?.clips[1]?.id ?? '' },
    });
    const changed = diff(back, next);
    expect(changed.filter((c) => c.change === 'removed')).toHaveLength(2);
    // Added and modified clips say where they now sit.
    const moved = edit(back, {
      tool: 'clip.move',
      args: { clip_id: view.tracks[0]?.clips[1]?.id ?? '', to_frame: 100 },
    });
    expect(diff(back, moved.doc).find((c) => c.type === 'clip')).toMatchObject({
      change: 'modified',
      track_id: 't1',
      start: 100,
      end: 140,
    });
    expect(() => fromView(view, () => undefined)).toThrow(/not available/);
  });
});

describe('TimelineStore', () => {
  it('stores by content hash and expires', async () => {
    const ws = new Workspace(await mkdtemp(join(tmpdir(), 'cf-')));
    const store = new TimelineStore(ws);
    const doc = start();
    const id = await store.put('local', doc);
    expect(await store.put('local', doc)).toBe(id);
    expect(await store.get('local', id)).toEqual(doc);
    await expect(store.get('someone-else', id)).rejects.toThrow(/not available/);
    expect(await store.sweep(-1)).toBe(1);
    await expect(store.get('local', id)).rejects.toMatchObject({
      code: 'expired',
      hint: expect.stringMatching(/timeline.load/),
    });
  });
});
