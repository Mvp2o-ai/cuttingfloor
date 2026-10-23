import {
  type FrameScores,
  listenFor,
  listenText,
  peakOf,
  renderSource,
  SOUND_MODELS,
  scoreSeries,
  seriesStep,
  soundSpans,
} from '@cuttingfloor/engine';
import {
  CfError,
  MediaListenInput,
  MediaListenResult,
  SOUND_LABELS,
  SOUNDS_LIMITS,
  type SoundsAnalysis,
  withJob,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { admitJob } from '../meter.ts';
import { guard, jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';

// Sounds: media.analyze sounds (the 447 AudioSet-strong sounds by name) and media.listen (a
// sound described in words), both per 40 ms frame. The cut-off is always the agent's; spans are
// only the runs of frames at or above it, and every probability comes back for a second look.

const LOWER = new Map(SOUND_LABELS.map((l, i) => [l.toLowerCase(), i]));

/** Column indexes for sound names, matched without regard to case; unknown names refused. */
export function soundLabelIndexes(labels: string[]): number[] {
  const out: number[] = [];
  for (const label of labels) {
    const at = LOWER.get(label.trim().toLowerCase());
    if (at === undefined) {
      // Close names share a word's start: "laughing" finds Laughter and Belly laugh.
      const words = label
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length > 2)
        .map((w) => w.slice(0, 5));
      const near = SOUND_LABELS.filter((l) => words.some((w) => l.toLowerCase().includes(w)));
      throw new CfError('bad_request', `No sound named "${label}"`, {
        hint: near.length
          ? `Names from video://catalog/sounds, e.g. ${near
              .slice(0, 8)
              .map((n) => `"${n}"`)
              .join(', ')}; or media.listen for a sound in your own words`
          : 'Use names from video://catalog/sounds, or media.listen for a sound in your own words',
      });
    }
    if (!out.includes(at)) out.push(at);
  }
  return out;
}

type Analysis = z.infer<typeof SoundsAnalysis>;

/**
 * The stored analysis (every frame) and the result (scores coarsened only if they would pass
 * the result's limit), for `columns` or, without them, every column that reaches `min`.
 */
export function soundsReport(
  scores: FrameScores,
  options: { model: string; min: number; columns?: number[] },
): { stored: Analysis; result: Analysis } {
  const columns =
    options.columns ??
    scores.columns.map((_, i) => i).filter((i) => peakOf(scores, i) >= options.min);
  const names = columns.map((i) => scores.columns[i] as string);
  const base = {
    model: options.model,
    min_probability: options.min,
    spans: Object.fromEntries(
      columns.map((i, k) => [names[k], soundSpans(scores, i, options.min)]),
    ),
    peaks: Object.fromEntries(
      columns.map((i, k) => [names[k], Math.round(peakOf(scores, i) * 100) / 100]),
    ),
  };
  const series = (step: number) => ({
    start_seconds: scores.start,
    step_seconds: step,
    values: Object.fromEntries(columns.map((i, k) => [names[k], scoreSeries(scores, i, step)])),
  });
  const full = series(0.04);
  const step = seriesStep(scores.frames, columns.length, SOUNDS_LIMITS.values);
  return {
    stored: { ...base, scores: full },
    result: { ...base, scores: step === 0.04 ? full : series(step) },
  };
}

export function registerListenTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;

  server.registerTool(
    'media.listen',
    {
      title: 'Find sounds by description',
      description: [
        'Find when something can be heard in a video or audio file, from what you describe in plain words, so you go straight to it instead of listening to it all: laughter, applause, a cough, a door slamming, a phone ringing, a dog barking, music starting, someone typing, a car passing. Name each sound and say what it is; you get back the stretches of time where each one can be heard, with the moment it is clearest.',
        'Use it to:',
        '- Find reactions and moments: where the crew or the audience laughs, where people clap or cheer, a gasp, a scream.',
        '- Find trouble to cut or cover: a cough, a sneeze, a phone going off, a door, a siren, wind on the microphone, a click or a bump.',
        '- Find sound to cut on: a clap, a bang, a hit, the music starting or stopping.',
        '',
        `HOW IT WORKS. FlexSED, an open-vocabulary sound detection model (local, on the CPU; about 15 to 20 times faster than real time), listens to every 40 ms of the sound and gives each description the probability that it can be heard there. Describe the sound itself, briefly, as you would caption it ("laughter", "a crowd cheering", "glass breaking"), not the scene or a judgment; it is asked as "The sound of <your words>". Short, common sound names work best; put each sound you want in its own entry, up to ${SOUNDS_LIMITS.queries} a call, all listened for at once.`,
        'READING THE RESULT. matches gives, per sound, each run of frames at or above min_probability (default 0.5) with its start, end (media seconds), peak_seconds and, for video, frame (for render.frames). peaks gives the highest probability each sound reaches, and scores every probability (step_seconds apart), for your own cut-off. A sound whose peak stays well under your cut-off is most likely not there; one hovering near it is worth a listen or a lower cut-off.',
        'For the 447 sounds with names (Laughter, Applause, Cough, Speech, Music…) as stored data, media.analyze kind sounds. Long-running: returns a task, or a job_id for job.get.',
      ].join('\n'),
      inputSchema: MediaListenInput,
      outputSchema: withJob(MediaListenResult),
      annotations: {
        title: 'Find sounds by description',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      const names = Object.keys(args.sounds);
      if (!names.length || names.length > SOUNDS_LIMITS.queries) {
        throw new CfError(
          'bad_request',
          `media.listen takes 1 to ${SOUNDS_LIMITS.queries} sounds; got ${names.length}`,
          {
            hint: names.length
              ? 'Split the sounds across calls'
              : 'sounds: {laugh: "laughter", door: "a door slams"}',
          },
        );
      }
      if (
        args.from_seconds !== undefined &&
        args.until_seconds !== undefined &&
        args.until_seconds <= args.from_seconds
      ) {
        throw new CfError('bad_request', 'until_seconds must come after from_seconds');
      }
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'media.listen', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }
      const record = await rt.media.get(owner, args.media_id);
      if (record.status !== 'ready') {
        throw new CfError('media_not_ready', `Media ${args.media_id} is still importing`, {
          hint: 'Wait for its media.import job to finish',
        });
      }
      const p = record.probe;
      if (!p?.audio) {
        throw new CfError('bad_request', `Media ${args.media_id} has no sound to listen to`);
      }
      if (args.from_seconds !== undefined && p.duration && args.from_seconds >= p.duration) {
        throw new CfError('bad_request', `from_seconds is past the end (${p.duration} s)`);
      }
      const fps = p.video && p.kind !== 'image' ? p.video.fps : undefined;
      const asked = Object.fromEntries(names.map((n) => [n, listenText(args.sounds[n] as string)]));
      const admit = await admitJob(deps.limits);
      const job = await store.create({
        owner,
        tool: 'media.listen',
        meta: { media: args.media_id },
        statusMessage: 'listen: starting',
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(
        job,
        async ({ signal, progress }) => {
          const scores = await listenFor(renderSource(record, 'export'), args.sounds, {
            ...(args.from_seconds !== undefined ? { from: args.from_seconds } : {}),
            ...(args.until_seconds !== undefined ? { until: args.until_seconds } : {}),
            signal,
            onProgress: (f) => progress(0.02 + 0.96 * f, 'listen: listening'),
          });
          const step = seriesStep(
            scores.frames,
            names.length,
            SOUNDS_LIMITS.values,
            args.step_seconds ?? 0,
          );
          const frameAt = (seconds: number) =>
            fps ? { frame: Math.floor((seconds * fps.num) / fps.den + 1e-6) } : {};
          return ok({
            media_id: args.media_id,
            model: SOUND_MODELS.listen,
            asked,
            matches: Object.fromEntries(
              names.map((n, i) => [
                n,
                soundSpans(scores, i, args.min_probability).map((s) => ({
                  ...s,
                  ...frameAt(s.peak_seconds),
                })),
              ]),
            ),
            peaks: Object.fromEntries(
              names.map((n, i) => [n, Math.round(peakOf(scores, i) * 100) / 100]),
            ),
            scores: {
              start_seconds: scores.start,
              step_seconds: step,
              values: Object.fromEntries(names.map((n, i) => [n, scoreSeries(scores, i, step)])),
            },
          }) as never;
        },
        admit,
      );
      return jobReply(job, ctx);
    }),
  );
}
