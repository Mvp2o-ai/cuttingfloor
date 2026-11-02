import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  colourStats,
  detectFaces,
  detectScenes,
  diarize,
  lengthFrames,
  measureVoice,
  pictureSeries,
  pngsToRgb,
  type RgbFrame,
  renderPictureFile,
  renderTimelineFrames,
  trackRegion,
  type VoiceSeries,
} from '@cuttingfloor/engine';
import {
  CfError,
  COLOUR_LIMITS,
  type RegionBox,
  TIMELINE_PICTURE_ANALYSES,
  type TimelineDoc,
} from '@cuttingfloor/schema';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { askFrames, sampleTimes } from '../frames.ts';
import { JEV_MODEL, JEV_URL } from '../jev.ts';
import { admitJob } from '../meter.ts';
import { assertOnline, sourcesFor } from '../render.ts';
import { jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import type { Sound } from '../sound.ts';
import { addUsage, checkQuota } from '../usage.ts';
import { JUDGMENTS, PICTURE } from './judge.ts';

// The measured facts of media.analyze kept apart from media.ts: speakers and voice on a sound,
// colour and picture on a picture, and every picture kind on a timeline as it renders.

/** Analysis data longer than this comes back as a note instead of filling the result. */
export const INLINE_CHARS = 20_000;

/** The longest stretch of a timeline one picture analysis renders: protects the server. */
export const TIMELINE_PICTURE_SECONDS = 1800;

/** Timeline renders for the picture kinds: plenty for the face and region models (640 px). */
const TIMELINE_LONG_EDGE = 1280;

/** Timeline frames melt renders in one run. */
const TIMELINE_BATCH = 40;

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface MeasureArgs {
  kind: string;
  media_id?: string | undefined;
  timeline_id?: string | undefined;
  from_seconds?: number | undefined;
  until_seconds?: number | undefined;
  every_seconds?: number | undefined;
  at_seconds?: number[] | undefined;
  with_previous?: boolean | undefined;
  speakers?: number | undefined;
  cluster_threshold?: number | undefined;
  regions?: Record<string, RegionBox> | undefined;
  percentiles?: number[] | undefined;
  region?: (RegionBox & { at_seconds: number }) | undefined;
  threshold?: number | undefined;
  questions?: Record<string, unknown> | undefined;
  state?: Record<string, unknown> | undefined;
  idempotency_key?: string | undefined;
}

/** Checks the settings a new kind needs, before any job exists. */
export function checkMeasureArgs(args: MeasureArgs): void {
  if (args.kind === 'speakers') {
    if ((args.speakers === undefined) === (args.cluster_threshold === undefined)) {
      throw new CfError('bad_request', 'speakers needs speakers or cluster_threshold, not both', {
        hint: 'Say how many people speak, e.g. {speakers: 2}; if you do not know, {cluster_threshold: 0.7} (lower finds more people)',
      });
    }
  }
  if (args.kind === 'colour' && Object.keys(args.regions ?? {}).length > COLOUR_LIMITS.regions) {
    throw new CfError(
      'limit_exceeded',
      `colour measures up to ${COLOUR_LIMITS.regions} regions a call`,
      { hint: 'Split the regions across calls over the same times' },
    );
  }
  if (args.kind === 'colour' && args.regions && 'frame' in args.regions) {
    throw new CfError('bad_request', 'colour names the whole picture frame itself', {
      hint: 'Give your regions other names, e.g. wall or skin',
    });
  }
}

/** A caller's box in fractions of a picture `size`, checked to lie inside it. */
export function boxFraction(
  name: string,
  box: RegionBox,
  size: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const px = box.units === 'pixels';
  const f = {
    x: px ? box.x / size.width : box.x,
    y: px ? box.y / size.height : box.y,
    w: px ? box.w / size.width : box.w,
    h: px ? box.h / size.height : box.h,
  };
  const eps = 1e-6;
  if (f.x + f.w > 1 + eps || f.y + f.h > 1 + eps) {
    throw new CfError('bad_request', `${name} runs past the edge of the picture`, {
      hint: px
        ? `The picture is ${size.width}x${size.height} pixels: x + w and y + h must fit inside it`
        : 'In fractions, x + w and y + h must be at most 1 (units: "pixels" takes pixels)',
    });
  }
  return f;
}

/** Colour statistics of every picture, for the whole frame and each named region. */
export function colourFrames(
  frames: RgbFrame[],
  times: number[],
  regions: Record<string, RegionBox>,
  percentiles: number[],
) {
  return {
    percentiles,
    frames: frames.map((f, i) => {
      const size = { width: f.width, height: f.height };
      const boxes = {
        frame: { x: 0, y: 0, w: 1, h: 1 },
        ...Object.fromEntries(
          Object.entries(regions).map(([n, b]) => [n, boxFraction(`regions.${n}`, b, size)]),
        ),
      };
      return {
        time: times[i] as number,
        regions: Object.fromEntries(
          Object.entries(boxes).map(([n, b]) => [
            n,
            colourStats(f.rgb, f.width, f.height, b, percentiles),
          ]),
        ),
      };
    }),
  };
}

/** Pace from a transcript over the stretch a voice series covers. */
export function withPace(
  series: VoiceSeries,
  words: Array<{ start: number; end: number }> | undefined,
) {
  const lo = series.from;
  const hi = series.from + series.summary.seconds;
  const n = words?.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return mid >= lo && mid < hi;
  }).length;
  return {
    ...series,
    summary: {
      ...series.summary,
      words: n ?? null,
      words_per_second:
        n === undefined || !series.summary.seconds
          ? null
          : Math.round((n / series.summary.seconds) * 100) / 100,
    },
  };
}

/** speakers or voice on a sound, with times on the source's own clock. */
export async function measureVoices(
  sound: Sound,
  args: MeasureArgs,
  signal: AbortSignal,
  progress: (f: number, m: string) => void,
  words?: Array<{ start: number; end: number }>,
) {
  const range = {
    ...(sound.from !== undefined ? { from: sound.from } : {}),
    ...(sound.until !== undefined ? { until: sound.until } : {}),
    label: sound.label,
  };
  if (args.kind === 'speakers') {
    progress(0.05, 'speakers: listening');
    const found = await diarize(sound.file, {
      ...range,
      ...(args.speakers !== undefined ? { speakers: args.speakers } : {}),
      ...(args.cluster_threshold !== undefined ? { clusterThreshold: args.cluster_threshold } : {}),
      signal,
      onProgress: (f) => progress(0.05 + 0.9 * f, 'speakers: listening'),
    });
    const shift = (t: number) => r3(t + sound.shift);
    const ranged = args.from_seconds !== undefined || args.until_seconds !== undefined;
    const { from: _f, until: _u, ...rest } = found;
    return {
      ...rest,
      turns: found.turns.map((t) => ({ ...t, start: shift(t.start), end: shift(t.end) })),
      ...(ranged ? { from: args.from_seconds ?? 0, until: args.until_seconds ?? null } : {}),
    };
  }
  progress(0.1, 'voice: listening');
  const series = await measureVoice(sound.file, { ...range, signal });
  return withPace(
    {
      ...series,
      from: r3(series.from + sound.shift),
      frames: series.frames.map((f) => ({ ...f, time: r3(f.time + sound.shift) })),
    },
    words,
  );
}

/** The data for a result: whole when short enough, else a note saying where to read it. */
export function inlineOr(
  kind: string,
  data: unknown,
  mediaId: string | undefined,
): Record<string, unknown> {
  const chars = JSON.stringify(data).length;
  if (chars <= INLINE_CHARS) return { [kind]: data };
  return {
    note: mediaId
      ? `The ${kind} is ${chars} characters, too long to return here. It is stored with the media: read it in pieces with media.get {media_id: '${mediaId}', include: ['${kind}'], from_seconds, to_seconds} for a stretch of the media, or offset and limit for a page.`
      : `The ${kind} is ${chars} characters, too long to return here; ask again over a shorter from_seconds to until_seconds (summary has the whole stretch).`,
  };
}

/** Frames [start, end) of a timeline for a range in its seconds, checked. */
function timelineRange(doc: TimelineDoc, from?: number, until?: number) {
  const length = lengthFrames(doc);
  const fps = doc.sequence.fps;
  const seconds = (f: number) => (f * fps.den) / fps.num;
  if (!length) {
    throw new CfError('bad_request', 'The timeline is empty', {
      hint: 'Add a clip with clip.add first',
    });
  }
  const start = Math.max(0, Math.floor(((from ?? 0) * fps.num) / fps.den + 1e-6));
  const end = Math.min(
    length,
    until === undefined ? length : Math.ceil((until * fps.num) / fps.den - 1e-6),
  );
  if (start >= length) {
    throw new CfError('bad_request', `The timeline is ${r3(seconds(length))} s long`, {
      hint: 'Give from_seconds inside it (timeline.get duration is in frames)',
    });
  }
  if (end <= start) throw new CfError('bad_request', 'until_seconds must be after from_seconds');
  if (seconds(end - start) > TIMELINE_PICTURE_SECONDS) {
    throw new CfError(
      'limit_exceeded',
      `That reads ${Math.round(seconds(end - start))} s of the timeline's picture; a call reads up to ${TIMELINE_PICTURE_SECONDS} s`,
      { hint: 'Give from_seconds and until_seconds around the stretch you need' },
    );
  }
  return { start, end, length, seconds };
}

/**
 * media.analyze of a picture kind on a timeline, as it renders: the edit's picture is rendered
 * (frames for look and colour, a file for the rest) and read like media, on the timeline's clock.
 */
export async function analyzeTimelinePicture(
  deps: ServerDeps,
  args: MeasureArgs,
  ctx: unknown,
  lookDigest: (questions: Record<string, { type: string }>, frames: never[]) => unknown,
): Promise<CallToolResult> {
  const rt = deps.runtime;
  const owner = deps.owner();
  const store = rt.jobs.store;
  const timelineId = args.timeline_id as string;
  if (!(TIMELINE_PICTURE_ANALYSES as readonly string[]).includes(args.kind)) {
    throw new CfError('bad_request', `${args.kind} is not a picture analysis`);
  }
  const doc = await rt.timelines.get(owner, timelineId);
  const { width, height } = doc.sequence;
  const size = { width, height };
  const sampled = args.kind === 'look' || args.kind === 'colour';
  const range = sampled
    ? undefined
    : timelineRange(
        doc,
        args.kind === 'track' ? (args.region?.at_seconds ?? 0) : args.from_seconds,
        args.until_seconds,
      );
  let times: number[] = [];
  if (sampled) {
    const length = lengthFrames(doc);
    if (!length) {
      throw new CfError('bad_request', 'The timeline is empty', {
        hint: 'Add a clip with clip.add first',
      });
    }
    const duration = (length * doc.sequence.fps.den) / doc.sequence.fps.num;
    const s = sampleTimes(duration, args, 'timeline');
    times = s.times;
    if (args.kind === 'look') {
      await checkQuota(
        rt.ws,
        owner,
        JUDGMENTS,
        s.asked,
        (await deps.limits?.())?.judgmentsPerDay ?? rt.config.judgmentsPerDay,
        {
          unit: 'judgments (one a frame)',
          hint: 'Sample fewer frames (a larger every_seconds, or at_seconds around the moments you need)',
        },
      );
    }
  }
  if (args.kind === 'track') {
    if (!args.region) {
      throw new CfError('bad_request', 'track needs a region: {at_seconds, x, y, w, h}');
    }
    boxFraction('region', args.region, size);
  }
  if (args.kind === 'colour') {
    for (const [n, b] of Object.entries(args.regions ?? {})) boxFraction(`regions.${n}`, b, size);
  }
  if (args.kind === 'scenes' && args.threshold === undefined) {
    throw new CfError('bad_request', 'scenes needs a threshold (0–100)', {
      hint: 'Lower finds subtler cuts, e.g. {threshold: 10}',
    });
  }
  // Only the clips this reads need their copies (fills, in-between frames).
  const fpsNow = doc.sequence.fps;
  const { sources, offline } = await sourcesFor(rt, owner, doc, 'export', false, true, {
    timelineId,
    ...(range
      ? { range: { start: range.start, end: range.end } }
      : sampled
        ? {
            frames: times.map((t) =>
              Math.min(lengthFrames(doc) - 1, Math.floor((t * fpsNow.num) / fpsNow.den + 1e-6)),
            ),
          }
        : {}),
  });
  assertOnline(offline);
  const admit = await admitJob(deps.limits);
  const job = await store.create({
    owner,
    tool: 'media.analyze',
    meta: { timeline_id: timelineId, kind: args.kind },
    statusMessage: `${args.kind}: starting`,
    ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
  });
  const fps = doc.sequence.fps;
  const frameAt = (t: number) =>
    Math.min(lengthFrames(doc) - 1, Math.floor((t * fps.num) / fps.den + 1e-6));
  rt.jobs.start(
    job,
    async ({ signal, progress }) => {
      const head = { timeline_id: timelineId, kind: args.kind };
      if (args.kind === 'look' || args.kind === 'colour') {
        const look = args.kind === 'look';
        // Jev takes pictures at least 280 px on each side; colour reads the full sequence size.
        const longEdge = look
          ? Math.max(
              PICTURE.longEdge,
              Math.ceil((PICTURE.minEdge * Math.max(width, height)) / Math.min(width, height) / 2) *
                2,
            )
          : Math.max(width, height);
        const pictures: Buffer[] = [];
        const numbers = times.map(frameAt);
        for (let i = 0; i < numbers.length; i += TIMELINE_BATCH) {
          const batch = await renderTimelineFrames(
            doc,
            numbers.slice(i, i + TIMELINE_BATCH),
            sources,
            {
              longEdge,
              format: look ? 'jpeg' : 'png',
              quality: 90,
              layout: 'single',
              signal,
            },
          );
          pictures.push(...batch);
          progress(
            (look ? 0.3 : 0.9) * (pictures.length / numbers.length),
            `${args.kind}: frame ${pictures.length} of ${numbers.length}`,
          );
        }
        if (!look) {
          const rgb = await pngsToRgb(pictures, size, signal);
          const colour = colourFrames(
            rgb,
            times,
            args.regions ?? {},
            args.percentiles ?? [5, 50, 95],
          );
          return ok({
            ...head,
            picture_size: size,
            summary: {
              frames: colour.frames.length,
              regions: ['frame', ...Object.keys(args.regions ?? {})],
            },
            ...inlineOr('colour', colour, undefined),
          }) as never;
        }
        const key = await deps.credentials.resolve(owner, 'typesafe');
        if (!key) throw new CfError('credential_required', 'The TypeSafe API key went away');
        const questions = args.questions as Record<string, never>;
        const frames = await askFrames({
          base: rt.config.typesafeUrl ?? JEV_URL,
          key,
          times,
          stills: pictures,
          withPrevious: Boolean(args.with_previous),
          state: args.state,
          questions,
          signal,
          onFrame: (done, of) =>
            progress(0.3 + (0.7 * done) / of, `look: asked ${done} of ${of} frames`),
        });
        await addUsage(rt.ws, owner, JUDGMENTS, job.id, frames.length);
        const run = {
          id: job.id,
          model: JEV_MODEL,
          questions,
          with_previous: Boolean(args.with_previous),
          ...(args.state ? { state: args.state } : {}),
          frames,
        };
        return ok({
          ...head,
          model: JEV_MODEL,
          frames: frames.length,
          summary: lookDigest(questions, frames as never[]),
          ...inlineOr('look', run, undefined),
        }) as never;
      }
      const span = range as NonNullable<typeof range>;
      const shift = span.seconds(span.start);
      const at = (t: number) => r3(t + shift);
      const dir = await mkdtemp(join(tmpdir(), 'cf-tlpicture-'));
      try {
        progress(0.02, `${args.kind}: rendering the edit`);
        const rendered = await renderPictureFile(doc, sources, dir, span, {
          longEdge: TIMELINE_LONG_EDGE,
          signal,
        });
        progress(0.5, `${args.kind}: looking`);
        if (args.kind === 'faces') {
          const faces = await detectFaces(rendered.file, rendered, { signal });
          const out = { ...faces, frames: faces.frames.map((f) => ({ ...f, time: at(f.time) })) };
          return ok({
            ...head,
            picture_size: size,
            summary: {
              rate: out.rate,
              frames_with_faces: out.frames.filter((f) => f.faces.length).length,
            },
            ...inlineOr('faces', out, undefined),
          }) as never;
        }
        if (args.kind === 'track') {
          const region = args.region as NonNullable<MeasureArgs['region']>;
          const box = boxFraction('region', region, size);
          const rate = Math.min(30, fps.num / fps.den);
          const points = await trackRegion(rendered.file, rendered, {
            start: Math.max(0, region.at_seconds - shift),
            box,
            ...(args.until_seconds !== undefined ? { until: args.until_seconds - shift } : {}),
            rate,
            signal,
          });
          return ok({
            ...head,
            picture_size: size,
            track: { rate, points: points.map((p) => ({ ...p, time: at(p.time) })) },
          }) as never;
        }
        if (args.kind === 'scenes') {
          const scenes = await detectScenes(rendered.file, {
            threshold: args.threshold as number,
            signal,
          });
          return ok({
            ...head,
            scenes: scenes.map((c) => at(c.time)),
            scene_scores: scenes.map((c) => c.score),
          }) as never;
        }
        const series = await pictureSeries(rendered.file, { signal });
        const picture = {
          ...series,
          from: at(0),
          columns: { ...series.columns, time: (series.columns.time ?? []).map(at) },
        };
        return ok({
          ...head,
          summary: { frames: picture.columns.time.length, from: picture.from },
          ...inlineOr('picture', picture, undefined),
        }) as never;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    admit,
  );
  return jobReply(job, ctx);
}
