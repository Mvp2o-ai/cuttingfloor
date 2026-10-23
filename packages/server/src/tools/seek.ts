import { timelineEnd } from '@cuttingfloor/core';
import {
  lengthFrames,
  mayBeTransparent,
  mediaStills,
  renderSource,
  renderTimelineFrames,
} from '@cuttingfloor/engine';
import {
  CfError,
  JUDGE_LIMITS,
  MediaSeekInput,
  MediaSeekResult,
  withJob,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { askFrames, checkFrameState, type JudgedFrame, sampleTimes } from '../frames.ts';
import { JEV_MODEL, JEV_URL } from '../jev.ts';
import { admitJob } from '../meter.ts';
import { assertOnline, framesUri, sourcesFor } from '../render.ts';
import { guard, jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { addUsage, checkQuota } from '../usage.ts';
import { checkText, JUDGMENTS, jevKeyRequired, PICTURE, pictureSize } from './judge.ts';

// media.seek: plain-language criteria, each asked of sampled frames as a Jev noul, and the runs
// of time where each holds. It finds moments; media.analyze look measures every frame.

type Criterion = z.infer<typeof MediaSeekInput>['criteria'][string];
type Noul = { type: 'noul'; instructions: unknown; criteria?: unknown };

/** Timeline frames melt renders in one run: well inside its timeout at preview size. */
const TIMELINE_BATCH = 40;

/**
 * A criterion as the noul Jev is asked. Text that names no picture or state entry in backticks
 * is about `frame`, so it says so: Jev judges the part of the state a question names.
 */
export function seekQuestion(criterion: Criterion, names: string[]): Noul {
  const fields = typeof criterion === 'string' ? { instructions: criterion } : criterion;
  const text = fields.instructions;
  const named = typeof text === 'string' && names.some((n) => text.includes(`\`${n}\``));
  return {
    type: 'noul',
    ...fields,
    instructions: typeof text === 'string' && !named ? `In \`frame\`: ${text}` : text,
  };
}

/** Per criterion, runs of consecutive samples at or above the cut-off, with their best sample. */
export function seekMatches(
  names: string[],
  frames: JudgedFrame[],
  min: number,
  locate: (seconds: number) => { frame: number; uri: string },
): z.infer<typeof MediaSeekResult>['matches'] {
  const p = (f: JudgedFrame | undefined, name: string) =>
    ((f?.answers[name] as { noul?: number } | undefined)?.noul ?? 0) as number;
  return Object.fromEntries(
    names.map((name) => {
      const runs: Array<{ start: number; end: number; peak: JudgedFrame }> = [];
      let open = false;
      for (const f of frames) {
        if (p(f, name) < min) {
          open = false;
          continue;
        }
        const run = runs.at(-1);
        if (open && run) {
          run.end = f.time;
          if (p(f, name) > p(run.peak, name)) run.peak = f;
        } else runs.push({ start: f.time, end: f.time, peak: f });
        open = true;
      }
      return [
        name,
        runs.map((r) => ({
          start: r.start,
          end: r.end,
          peak_seconds: r.peak.time,
          peak_probability: p(r.peak, name),
          ...locate(r.peak.time),
        })),
      ];
    }),
  );
}

export function registerSeekTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;

  server.registerTool(
    'media.seek',
    {
      title: 'Seek by natural language',
      description: [
        'Find the moments in a video, or in an edit as it renders, that match what you describe in plain words, so you go straight to them instead of watching it all. Name each criterion and say what a matching frame shows; you get back the stretches of time where each one holds, with the time and picture of the best frame in each.',
        'Use it to:',
        '- Check quality: find frames that are too dark or blown out, out of focus, black or blank (a gap in an edit), with a microphone or crew in shot, with text cut off at the edge, or with a caption over a face. With timeline_id it checks the edit as it renders, titles, effects and gaps included.',
        '- Watch efficiently: looking through a whole video costs you a picture for every moment. Seek judges the frames for you and says where things are, so you look only there: where the demo starts, where the speaker holds up the product, where the second location begins.',
        '- Pick shots: B-roll or a thumbnail moment that fits a description ("a wide shot of a city street at night", "she smiles straight at the camera with her eyes open").',
        '- Find changes: with with_previous, where the slide changes, someone walks in or the camera angle switches ("`frame` shows a different slide from `previous`").',
        '- Find room or trouble for overlays: where the lower third stays empty for a title, or where a logo, a licence plate or a face appears that needs a blur.',
        '',
        'HOW TO WRITE CRITERIA. TypeSafe Jev, a fast judgment model (preview), judges each sampled frame on its own, as a picture named `frame` (about 512 px on its long edge; with with_previous also `previous`, the frame sampled before), and gives each criterion the probability that it is true. A criterion is a statement or a question about how the picture looks. Keep one judgment to a criterion, and say what shows rather than a verdict: not "bad lighting" but "the faces are too dark to make out their eyes"; not "a good thumbnail" but "a person looks straight at the camera with eyes open and mouth closed". Criteria that name no picture or state entry in backticks are asked about `frame` ("In `frame`: <your words>"); name `frame`, `previous` or your state entries yourself to judge them together ("`frame` shows the button `line` talks about"). Jev answers most accurately from examples: give {instructions, criteria: {true: "…", false: "…"}} with a case of each ({true: "the face is a dark silhouette against a bright window", false: "the face is evenly lit, a little dim"}). Detail too small to see at that size (fine print, slight softness) answers poorly; check it with render.frames at full size.',
        'READING THE RESULT. matches gives, per criterion, each run of consecutive samples at or above min_probability (default 0.5), with its start, end and best sample: peak_seconds, frame (for render.frames) and uri (a resource to read the picture). samples has every probability, for your own cut-off. A probability near 0.5 means Jev cannot tell, not that the thing is half there: reword a criterion that keeps landing there. asked shows the question each criterion became.',
        `COST. Each frame is one judgment however many criteria it carries, so ask everything you are looking for in one call (up to ${JUDGE_LIMITS.lookQuestions} criteria). Work in passes: every_seconds 2 to 5 over the whole video, then at_seconds around a match to find more exactly where it starts. Up to ${JUDGE_LIMITS.frames} frames a call. Long-running: returns a task, or a job_id for job.get.`,
        'media.analyze look asks typed questions (a choice, a score, a box) of every frame when you need measurements rather than moments; judge.ask judges one picture at once.',
      ].join('\n'),
      inputSchema: MediaSeekInput,
      outputSchema: withJob(MediaSeekResult),
      annotations: {
        title: 'Seek by natural language',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      if (!(await deps.credentials.status(owner, 'typesafe')).configured) {
        throw jevKeyRequired('media.seek');
      }
      const count = Object.keys(args.criteria).length;
      if (!count || count > JUDGE_LIMITS.lookQuestions) {
        throw new CfError(
          'bad_request',
          `media.seek takes 1 to ${JUDGE_LIMITS.lookQuestions} criteria; got ${count}`,
          {
            hint: count
              ? 'Split the criteria across calls over the same times'
              : 'criteria: {too_dark: "the faces are too dark to make out their eyes"}',
          },
        );
      }
      checkFrameState('media.seek', args.state);
      checkText(args.state ?? {});
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'media.seek', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }

      // What to sample: the media file, or the timeline as it renders.
      let duration: number;
      let fps: { num: number; den: number } | null;
      let stillsOf: (
        times: number[],
        signal: AbortSignal,
        onFrame: (n: number) => void,
      ) => Promise<Buffer[]>;
      if (args.timeline_id) {
        const tl = await rt.timelines.get(owner, args.timeline_id);
        if (!timelineEnd(tl)) {
          throw new CfError('bad_request', 'The timeline is empty', {
            hint: 'Add a clip with clip.add first',
          });
        }
        fps = tl.sequence.fps;
        const length = lengthFrames(tl);
        duration = (length * fps.den) / fps.num;
        const { sources, offline } = await sourcesFor(rt, owner, tl, 'preview');
        assertOnline(offline);
        const { width, height } = tl.sequence;
        // Jev takes pictures at least 280 px on each side.
        const longEdge = Math.max(
          PICTURE.longEdge,
          Math.ceil((PICTURE.minEdge * Math.max(width, height)) / Math.min(width, height) / 2) * 2,
        );
        stillsOf = async (times, signal, onFrame) => {
          const numbers = times.map((t) =>
            Math.min(
              length - 1,
              Math.floor((t * tl.sequence.fps.num) / tl.sequence.fps.den + 1e-6),
            ),
          );
          const out: Buffer[] = [];
          for (let i = 0; i < numbers.length; i += TIMELINE_BATCH) {
            const batch = await renderTimelineFrames(
              tl,
              numbers.slice(i, i + TIMELINE_BATCH),
              sources,
              { longEdge, format: 'jpeg', quality: 90, layout: 'single', signal },
            );
            out.push(...batch);
            onFrame(out.length);
          }
          return out;
        };
      } else {
        const mediaId = args.media_id as string;
        const record = await rt.media.get(owner, mediaId);
        if (record.status !== 'ready') {
          throw new CfError('media_not_ready', `Media ${mediaId} is still importing`, {
            hint: 'Wait for its media.import job to finish',
          });
        }
        const p = record.probe;
        if (!p?.video) throw new CfError('bad_request', `Media ${mediaId} has no picture to seek`);
        fps = p.video.fps ?? null;
        duration = p.kind === 'image' ? 0 : (p.duration ?? 0);
        const file = renderSource(record, 'export');
        const size = pictureSize(record);
        stillsOf = (times, signal, onFrame) =>
          mediaStills(file, size, times, {
            ...PICTURE,
            signal,
            onFrame,
            checker: mayBeTransparent(p),
          });
      }

      const { times, asked } = sampleTimes(duration, args, args.timeline_id ? 'timeline' : 'media');
      await checkQuota(
        rt.ws,
        owner,
        JUDGMENTS,
        asked,
        (await deps.limits?.())?.judgmentsPerDay ?? rt.config.judgmentsPerDay,
        {
          unit: 'judgments (one a frame)',
          hint: 'Sample fewer frames (a larger every_seconds, or at_seconds around the moments you need)',
        },
      );
      const names = ['frame', 'previous', ...Object.keys(args.state ?? {})];
      const questions = Object.fromEntries(
        Object.entries(args.criteria).map(([id, c]) => [id, seekQuestion(c, names)]),
      );
      const target = args.timeline_id
        ? { timeline_id: args.timeline_id }
        : { media_id: args.media_id as string };
      const locate = (seconds: number) => {
        const n = fps ? Math.floor((seconds * fps.num) / fps.den + 1e-6) : 0;
        return args.timeline_id
          ? { frame: n, uri: framesUri('timeline', args.timeline_id, [n]) }
          : { frame: n, uri: framesUri('media', args.media_id as string, [n]) };
      };

      const admit = await admitJob(deps.limits);
      const job = await store.create({
        owner,
        tool: 'media.seek',
        meta: { ...target },
        statusMessage: 'seek: starting',
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(
        job,
        async ({ signal, progress }) => {
          const key = await deps.credentials.resolve(owner, 'typesafe');
          if (!key) throw new CfError('credential_required', 'The TypeSafe API key went away');
          progress(0.02, `seek: taking ${times.length} frames`);
          const stills = await stillsOf(times, signal, (n) =>
            progress(0.02 + (0.28 * n) / times.length, `seek: frame ${n} of ${times.length}`),
          );
          const frames = await askFrames({
            base: rt.config.typesafeUrl ?? JEV_URL,
            key,
            times,
            stills,
            withPrevious: args.with_previous,
            state: args.state,
            questions,
            signal,
            onFrame: (done, of) =>
              progress(0.3 + (0.7 * done) / of, `seek: judged ${done} of ${of} frames`),
          });
          await addUsage(rt.ws, owner, JUDGMENTS, job.id, frames.length);
          const ids = Object.keys(questions);
          return ok({
            ...target,
            model: JEV_MODEL,
            frames: frames.length,
            asked: questions,
            matches: seekMatches(ids, frames, args.min_probability, locate),
            samples: frames.map((f) => ({
              seconds: f.time,
              probabilities: Object.fromEntries(
                ids.map((id) => [id, (f.answers[id] as { noul?: number } | undefined)?.noul ?? 0]),
              ),
            })),
          }) as never;
        },
        admit,
      );
      return jobReply(job, ctx);
    }),
  );
}
