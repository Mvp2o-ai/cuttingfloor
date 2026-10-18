import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  analyseBeats,
  detectFaces,
  detectScenes,
  detectSilences,
  fingerprint,
  mediaInfo,
  mediaStills,
  renderSource,
  trackRegion,
  transcribe,
} from '@cuttingfloor/engine';
import {
  CfError,
  JUDGE_LIMITS,
  type JudgeAnswer,
  MediaAnalyzeInput,
  MediaAnalyzeResult,
  MediaImportInput,
  MediaInfo,
  MediaRefInput,
  MediaUploadInput,
  MediaUploadResult,
  withJob,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { askJev, JEV_MODEL, JEV_URL } from '../jev.ts';
import { guard, jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { addUsage, checkQuota } from '../usage.ts';
import {
  checkQuestions,
  checkText,
  JUDGMENTS,
  jevKeyRequired,
  PICTURE,
  pictureSize,
} from './judge.ts';

/** Analysis data longer than this stays with the media instead of filling the result. */
const INLINE_CHARS = 20_000;

/** An analysis for the result: whole when short, or a note on where to read it when long. */
function inline(mediaId: string, kind: string, data: unknown): Record<string, unknown> {
  const chars = JSON.stringify(data).length;
  if (chars <= INLINE_CHARS) return { [kind]: data };
  return {
    note: `The ${kind} is ${chars} characters, too long to return here. It is stored with the media: in code.run, cf.media.get({media_id: '${mediaId}', include: ['${kind}']}) gives all of it to search, and the script prints only what you need; media.get {include: ['${kind}']} returns it whole.`,
  };
}

/** look: frames a call may ask about. Questions per frame are judge.ask's limit. */
const LOOK_MAX_FRAMES = 600;
/** State names look fills itself on every frame. */
const LOOK_NAMES = ['frame', 'previous', 'seconds_between'];

type LookFrame = { time: number; answers: Record<string, JudgeAnswer> };

/** Per question, where its answers sit: yes spans, choice spans, score range. */
function lookDigest(questions: Record<string, { type: string }>, frames: LookFrame[]) {
  const spans = (pick: (f: LookFrame) => string | null) => {
    const out: Array<{ value: string; from: number; to: number }> = [];
    for (const f of frames) {
      const v = pick(f);
      const last = out.at(-1);
      if (v !== null && last?.value === v && last.to === frames[frames.indexOf(f) - 1]?.time)
        last.to = f.time;
      else if (v !== null) out.push({ value: v, from: f.time, to: f.time });
    }
    return out;
  };
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      const a = (f: LookFrame) => f.answers[id] as Record<string, number & string> | undefined;
      if (q.type === 'noul') {
        const yes = spans((f) => ((a(f)?.noul ?? 0) >= 0.5 ? 'yes' : null));
        return [id, { yes_at: yes.map(({ from, to }) => ({ from, to })) }];
      }
      if (q.type === 'choice') {
        return [
          id,
          {
            spans: spans((f) => a(f)?.choice ?? null).map(({ value, from, to }) => ({
              choice: value,
              from,
              to,
            })),
          },
        ];
      }
      if (q.type === 'score') {
        const s = frames.map((f) => ({ time: f.time, score: a(f)?.score ?? 0 }));
        const lo = s.reduce((m, x) => (x.score < m.score ? x : m), s[0] ?? { time: 0, score: 0 });
        const hi = s.reduce((m, x) => (x.score > m.score ? x : m), s[0] ?? { time: 0, score: 0 });
        return [id, { lowest: lo, highest: hi }];
      }
      const sure = frames.filter((f) => (a(f)?.confidence ?? 0) >= 0.6).length;
      return [id, { frames_confident: sure }];
    }),
  );
}

export function registerMediaTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;

  /** The file a completed export.video rendered, for importing it as media. */
  const renderedFile = async (owner: string, jobId: string): Promise<string> => {
    const job = await rt.jobs.store.get(jobId, owner);
    if (!job) {
      throw new CfError('not_found', `No job ${jobId}`, { hint: 'Finished jobs are kept 7 days' });
    }
    if (job.tool !== 'export.video') {
      throw new CfError('bad_request', `Job ${jobId} is a ${job.tool}, not an export.video`, {
        hint: 'Only rendered videos import as media',
      });
    }
    if (job.status === 'working') {
      throw new CfError('media_not_ready', `Export ${jobId} is still rendering`, {
        hint: 'job.get {job_id, wait_seconds: 50} until it completes, then import it',
      });
    }
    const result = job.result as { isError?: boolean } | undefined;
    if (job.status !== 'completed' || result?.isError) {
      throw new CfError('bad_request', `Export ${jobId} did not finish (${job.status})`);
    }
    const dir = rt.ws.ownerDir(owner, 'outputs', jobId);
    const [name] = (await readdir(dir).catch(() => [] as string[])).filter(
      (n) => !n.startsWith('.'),
    );
    if (!name) {
      throw new CfError('not_found', `Export ${jobId} has no file any more`, {
        hint: 'Outputs expire 7 days after the export; export the timeline again',
      });
    }
    return join(dir, name);
  };

  server.registerTool(
    'media.import',
    {
      title: 'Import media',
      description: [
        "Import the user's own video, audio, image or font to edit with or place as is: probe, fingerprint, conform if needed (VFR, rotation, HDR → BT.709), 540p proxy and integrated loudness. A reference image to recreate needs no import: rebuild it with create.motion or create.still.",
        'Long-running: returns a task, or {job_id, media_id} for job.get. The media_id is usable in edits as soon as the job reports processing.',
        `Sources: ${rt.config.mediaRoots.length ? `a path under ${rt.config.mediaRoots.join(', ')}, ` : ''}an http(s) URL, the upload_id of a file sent through media.upload, or the job_id of a completed export.video (its render becomes media).`,
        'Importing the same file again returns the same media_id.',
      ].join(' '),
      inputSchema: MediaImportInput,
      outputSchema: withJob(MediaInfo),
      annotations: {
        title: 'Import media',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'media.import', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }
      // Path, upload and render imports fail fast (outside the roots, missing, unfinished) and
      // dedupe by fingerprint.
      const upload =
        'upload_id' in args.source
          ? await rt.uploads.take(owner, args.source.upload_id)
          : undefined;
      const local =
        'path' in args.source
          ? await rt.media.resolvePath(args.source.path)
          : 'job_id' in args.source
            ? await renderedFile(owner, args.source.job_id)
            : upload?.file;
      if (local) {
        const known = await rt.media.findByFingerprint(owner, await fingerprint(local));
        if (known) {
          if ('upload_id' in args.source) await rt.uploads.remove(owner, args.source.upload_id);
          const done = await store.create({
            owner,
            tool: 'media.import',
            meta: { media_id: known.media_id },
            ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
          });
          const result = ok(mediaInfo(known));
          return jobReply(
            await store.update(done, {
              status: 'completed',
              progress: 1,
              statusMessage: 'already imported',
              result: result as never,
            }),
            ctx,
          );
        }
      }
      const source = args.source;
      const record = await rt.media.create(
        owner,
        'job_id' in source
          ? { job: source.job_id }
          : 'upload_id' in source
            ? { upload: source.upload_id }
            : source,
        args.name ?? upload?.name ?? (local && 'job_id' in source ? basename(local) : undefined),
      );
      if (local && 'job_id' in source) {
        // The render is copied: outputs and media expire on their own clocks.
        record.file = await rt.media.adopt(owner, record, local);
        await rt.media.save(owner, record);
      } else if (local && 'upload_id' in source) {
        record.file = await rt.media.adopt(owner, record, local, { move: true });
        await rt.media.save(owner, record);
        await rt.uploads.remove(owner, source.upload_id);
      }
      const job = await store.create({
        owner,
        tool: 'media.import',
        meta: { media_id: record.media_id },
        statusMessage: `importing ${record.media_id}`,
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(job, async ({ signal, progress }) => {
        const done = await rt.media.ingest(
          owner,
          record,
          (f, m) => progress(f, `${record.media_id}: ${m}`),
          signal,
        );
        return ok(mediaInfo(done)) as never;
      });
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'media.upload',
    {
      title: 'Upload media',
      description: [
        "A signed URL to send one of the user's files to this server, for files on their machine that the server can't read: PUT the file there (curl --fail -T interview.mp4 '<url>'), then media.import {source: {upload_id}}. The URL needs no other credentials and works for a day.",
        'A broken upload resumes: HEAD the url for Upload-Offset (the bytes received), then PUT the rest with Content-Range: bytes <offset>-<last>/<total>. Large files can go in parts the same way.',
      ].join(' '),
      inputSchema: MediaUploadInput,
      outputSchema: MediaUploadResult,
      annotations: {
        title: 'Upload media',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guard(async (args) => {
      const upload = await rt.uploads.create(deps.owner(), args.name, args.bytes);
      return ok({
        ...upload,
        max_bytes: rt.uploads.maxBytes,
        how: `curl --fail -T ${shellQuote(args.name)} '${upload.url}' then media.import {source: {upload_id: "${upload.upload_id}"}}`,
      });
    }),
  );

  server.registerTool(
    'media.analyze',
    {
      title: 'Analyze media',
      description: [
        'Find what is in imported media, as data for edits. transcript: every word with its time (whisper.cpp on the CPU; the model downloads once). beats: tempo, beat and downbeat times. faces: face boxes over time, e.g. to reframe to 9:16 with clip.set_transform keyframes. track: follow a region you give from a moment on. look: your own questions about what is on screen, answered on sampled frames. silence: stretches quieter than threshold_db for at least min_seconds. scenes: times the picture changes by more than threshold (0–100).',
        'Times are media seconds; boxes are fractions of the picture. Results stay with the media (media.get include) except track, silence and scenes, which come back in the result. A result too long to return (a long transcript) comes back as its summary and a note on reading it in code.run.',
        'Long-running: returns a task, or a job_id for job.get.',
        '',
        'HOW LOOK WORKS. TypeSafe Jev, a fast judgment model (preview), answers your questions about frames sampled from the media. Each sampled frame is its own request: Jev sees that one picture, named `frame`, and with with_previous also the frame sampled just before it, named `previous`, plus any state you give: text or JSON entries by name, the same on every frame (the script, what a term means). Every question is answered on every frame, independently and in parallel (about 0.15 s a frame), as typed data you then combine in your own code.',
        'Choose the type by the answer you need. noul: yes or no, answered as noul, the probability of yes from 0 to 1. choice: one of options you name, answered as choice plus probabilities and confidence. score: a degree on levels you order, answered as score (0 is the first level; it can land between levels) plus confidence. box: where one thing is, answered as box {x, y, w, h} in fractions of the picture plus confidence.',
        'Write each question about the picture as it looks. Name the picture in backticks ("in `frame`"), ask about one thing, word it so yes means the thing is there, and describe it as it appears: "Does `frame` show a human being, even if only their face fills the picture?", "Is one large word laid over `frame`, much bigger than any other text?". To compare, name both pictures and the thing that differs: "Is there a button in `frame` that is not in `previous`?". To locate, name the one thing so only it fits ("the \'Get started for free\' button under the headline in `frame`") and, in the same call, a noul asking whether it is there; use the box on frames where that noul is high. Give a choice a none option for frames where nothing fits, and each score level a concrete situation.',
        'Read the answers this way: a noul of 0.5 or more reads as yes, and you can set your own cut-off; confidence tells you how far to trust a choice, a score or a box, and a loose box shows as low confidence. Work in passes: every_seconds 1 over the whole media, then at_seconds around the times where answers change. media.get scenes give when the picture cuts; look tells you what is on it.',
        `The result gives each question's spans (when a noul reads yes, which choice holds when); every frame's answers stay with the media (media.get include ['look'], the last 10 runs). Up to ${LOOK_MAX_FRAMES} frames and ${JUDGE_LIMITS.lookQuestions} questions a call. For one judgment about text, a still or a single frame, judge.ask answers at once. Full guide to writing questions: https://docs.typesafe.ai/primitives and https://docs.typesafe.ai/images.`,
      ].join('\n'),
      inputSchema: MediaAnalyzeInput,
      outputSchema: withJob(MediaAnalyzeResult),
      annotations: {
        title: 'Analyze media',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      if (args.kind === 'look') {
        if (!(await deps.credentials.status(owner, 'typesafe')).configured) {
          throw jevKeyRequired('look');
        }
        checkQuestions('look', args.questions, JUDGE_LIMITS.lookQuestions);
        const taken = Object.keys(args.state ?? {}).filter((n) => LOOK_NAMES.includes(n));
        if (taken.length) {
          throw new CfError('bad_request', `look names ${taken.join(', ')} itself`, {
            hint: 'Give your state entries other names, e.g. script or definition',
          });
        }
        checkText(args.state ?? {});
      }
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'media.analyze', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }
      const record = await rt.media.get(owner, args.media_id);
      if (record.status !== 'ready') {
        throw new CfError('media_not_ready', `Media ${args.media_id} is still importing`, {
          hint: 'Wait for its media.import job to finish',
        });
      }
      const p = record.probe;
      const needsPicture = args.kind === 'faces' || args.kind === 'track' || args.kind === 'scenes';
      if (
        args.kind === 'look'
          ? !p?.video
          : needsPicture
            ? !p?.video || p.kind === 'image'
            : !p?.audio
      ) {
        throw new CfError(
          'bad_request',
          `Media ${args.media_id} has no ${args.kind === 'look' ? 'picture' : needsPicture ? 'moving picture' : 'sound'} to analyze`,
        );
      }
      // look: the sample times, checked before any job exists.
      let times: number[] = [];
      if (args.kind === 'look') {
        const duration = p?.kind === 'image' ? 0 : (p?.duration ?? 0);
        const step = args.every_seconds ?? 1;
        const from = args.from_seconds ?? 0;
        const to = Math.min(args.until_seconds ?? duration, duration);
        if (p?.kind === 'image' || !duration) times = [0];
        else if (args.at_seconds) times = [...new Set(args.at_seconds)].sort((a, b) => a - b);
        else for (let t = from; t < to - 1e-6; t += step) times.push(Math.round(t * 1000) / 1000);
        const late = times.find((t) => duration && t >= duration);
        if (late !== undefined) {
          throw new CfError(
            'bad_request',
            `${late} s is past the end of the media (${duration} s)`,
            {
              hint: `Sample times from 0 up to ${duration} s`,
            },
          );
        }
        if (!times.length) {
          throw new CfError('bad_request', `Nothing to sample between ${from} s and ${to} s`, {
            hint: `The media runs ${duration} s; from_seconds must come before until_seconds`,
          });
        }
        const asked = times.length - (args.with_previous && times.length > 1 ? 1 : 0);
        if (asked > LOOK_MAX_FRAMES) {
          throw new CfError(
            'limit_exceeded',
            `That samples ${asked} frames; a call takes up to ${LOOK_MAX_FRAMES}`,
            {
              hint: `every_seconds ${Math.ceil(((to - from) / LOOK_MAX_FRAMES) * 100) / 100} covers it in one call, or split it with from_seconds and until_seconds`,
            },
          );
        }
        await checkQuota(rt.ws, owner, JUDGMENTS, asked, rt.config.judgmentsPerDay, {
          unit: 'judgments (one a frame)',
          hint: 'Sample fewer frames (a larger every_seconds, or at_seconds around the moments you need)',
        });
      }
      if (args.kind === 'track' && !args.region) {
        throw new CfError('bad_request', 'track needs a region: {at_seconds, x, y, w, h}');
      }
      if (
        args.kind === 'silence' &&
        (args.threshold_db === undefined || args.min_seconds === undefined)
      ) {
        throw new CfError('bad_request', 'silence needs threshold_db and min_seconds', {
          hint: 'Say what counts as quiet, e.g. {threshold_db: -40, min_seconds: 0.3}',
        });
      }
      if (args.kind === 'scenes' && args.threshold === undefined) {
        throw new CfError('bad_request', 'scenes needs a threshold (0–100)', {
          hint: 'Lower finds subtler cuts, e.g. {threshold: 10}',
        });
      }
      const job = await store.create({
        owner,
        tool: 'media.analyze',
        meta: { media_id: args.media_id, kind: args.kind },
        statusMessage: `${args.kind}: starting`,
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(job, async ({ signal, progress }) => {
        const file = renderSource(record, 'export');
        const v = p?.video;
        const size = pictureSize(record);
        const keep = (kind: 'transcript' | 'beats' | 'faces', value: unknown) =>
          rt.media.saveAnalysis(owner, args.media_id, kind, value);
        switch (args.kind) {
          case 'transcript': {
            const transcript = await transcribe(file, {
              model: args.model,
              modelsDir: rt.modelsDir,
              language: args.language,
              signal,
              onProgress: (f, m) => progress(f, `transcript: ${m}`),
            });
            const latest = await keep('transcript', transcript);
            return ok({
              media_id: args.media_id,
              kind: args.kind,
              summary: mediaInfo(latest).analyses?.transcript,
              ...inline(args.media_id, 'transcript', transcript),
            }) as never;
          }
          case 'beats': {
            progress(0.1, 'beats: listening');
            const beats = await analyseBeats(file, signal);
            const latest = await keep('beats', beats);
            return ok({
              media_id: args.media_id,
              kind: args.kind,
              summary: mediaInfo(latest).analyses?.beats,
              ...inline(args.media_id, 'beats', beats),
            }) as never;
          }
          case 'faces': {
            progress(0.1, 'faces: looking');
            const faces = await detectFaces(file, size, { signal });
            const latest = await keep('faces', faces);
            return ok({
              media_id: args.media_id,
              kind: args.kind,
              summary: mediaInfo(latest).analyses?.faces,
              ...inline(args.media_id, 'faces', faces),
            }) as never;
          }
          case 'look': {
            const key = await deps.credentials.resolve(owner, 'typesafe');
            if (!key) throw new CfError('credential_required', 'The TypeSafe API key went away');
            const questions = args.questions as NonNullable<typeof args.questions>;
            progress(0.02, `look: taking ${times.length} frames`);
            const stills = await mediaStills(file, size, times, {
              ...PICTURE,
              signal,
              onFrame: (n) =>
                progress(0.02 + (0.28 * n) / times.length, `look: frame ${n} of ${times.length}`),
            });
            // with_previous: the first frame is only ever shown as `previous`.
            const first = args.with_previous && times.length > 1 ? 1 : 0;
            const frames: LookFrame[] = new Array(times.length - first);
            let next = first;
            let done = 0;
            const worker = async () => {
              while (next < times.length) {
                const i = next++;
                const t = times[i] as number;
                const prev = i > 0 && args.with_previous ? i - 1 : -1;
                const { answers } = await askJev({
                  base: rt.config.typesafeUrl ?? JEV_URL,
                  key,
                  images: [
                    ...(prev >= 0 ? [{ name: 'previous', jpeg: stills[prev] as Buffer }] : []),
                    { name: 'frame', jpeg: stills[i] as Buffer },
                  ],
                  state: {
                    ...args.state,
                    ...(prev >= 0
                      ? {
                          seconds_between: Math.round((t - (times[prev] as number)) * 1000) / 1000,
                        }
                      : {}),
                  },
                  questions,
                  signal,
                });
                frames[i - first] = { time: t, answers };
                done++;
                progress(
                  0.3 + (0.7 * done) / frames.length,
                  `look: asked ${done} of ${frames.length} frames`,
                );
              }
            };
            await Promise.all(Array.from({ length: Math.min(8, frames.length) }, worker));
            const run = {
              id: job.id,
              model: JEV_MODEL,
              questions,
              with_previous: args.with_previous,
              ...(args.state ? { state: args.state } : {}),
              frames,
            };
            await rt.media.saveAnalysis(owner, args.media_id, 'look', run);
            await addUsage(rt.ws, owner, JUDGMENTS, job.id, frames.length);
            return ok({
              media_id: args.media_id,
              kind: args.kind,
              model: JEV_MODEL,
              frames: frames.length,
              summary: lookDigest(questions, frames),
              ...inline(args.media_id, 'look', run),
            }) as never;
          }
          case 'track': {
            progress(0.1, 'track: following');
            const region = args.region as NonNullable<typeof args.region>;
            const fps = v?.fps ? Math.min(30, v.fps.num / v.fps.den) : 25;
            const points = await trackRegion(file, size, {
              start: region.at_seconds,
              box: { x: region.x, y: region.y, w: region.w, h: region.h },
              ...(args.until_seconds !== undefined ? { until: args.until_seconds } : {}),
              rate: fps,
              signal,
            });
            return ok({
              media_id: args.media_id,
              kind: args.kind,
              track: { rate: fps, points },
            }) as never;
          }
          case 'silence': {
            progress(0.1, 'silence: listening');
            const silences = await detectSilences(file, {
              thresholdDb: args.threshold_db as number,
              minSeconds: args.min_seconds as number,
              ...(p?.duration ? { duration: p.duration } : {}),
              signal,
            });
            return ok({ media_id: args.media_id, kind: args.kind, silences }) as never;
          }
          case 'scenes': {
            progress(0.1, 'scenes: looking');
            const scenes = await detectScenes(file, {
              threshold: args.threshold as number,
              signal,
            });
            return ok({ media_id: args.media_id, kind: args.kind, scenes }) as never;
          }
        }
      });
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'media.get',
    {
      title: 'Get media',
      description:
        'Status, a signed download url for the file, streams, duration, frame rate, conform reasons, integrated loudness and summaries of media.analyze results under analyses (counts only: analyses.transcript.words is how many words). include returns those results in full at the top level, e.g. include ["transcript"] gives transcript.words, the list of words with times (for long media that is a lot: read it in code.run with cf.media.get and print only what you need).',
      inputSchema: MediaRefInput,
      outputSchema: MediaInfo,
      annotations: {
        title: 'Get media',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args) => {
      const owner = deps.owner();
      const record = await rt.media.get(owner, args.media_id);
      const link = await rt.signMedia(owner, record);
      return ok({
        ...mediaInfo(record, args.include ?? []),
        ...(link ? { url: link.url, expires_at: link.expiresAt } : {}),
      });
    }),
  );
}

/** A file name as one shell word, for the example command. */
function shellQuote(name: string): string {
  return /^[\w.@%+=:,/-]+$/.test(name) ? name : `'${name.replace(/'/g, "'\\''")}'`;
}
