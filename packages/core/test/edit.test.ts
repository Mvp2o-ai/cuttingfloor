import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BatchOp,
  diff,
  easeFn,
  framesToTicks,
  fromView,
  type MediaResolver,
  migrate,
  newTimeline,
  runEdits,
  TimelineStore,
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
