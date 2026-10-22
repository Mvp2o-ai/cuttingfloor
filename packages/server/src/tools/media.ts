import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
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
  MEDIA_LIMITS,
  MediaAnalyzeInput,
  MediaAnalyzeResult,
  MediaImportInput,
  MediaInfo,
  MediaListInput,
  MediaListResult,
  MediaRefInput,
  MediaUploadInput,
  MediaUploadResult,
  withJob,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { askFrames, checkFrameState, type JudgedFrame, sampleTimes } from '../frames.ts';
import { JEV_MODEL, JEV_URL } from '../jev.ts';
import { admitJob } from '../meter.ts';
import { PLAYER_TOOL_META } from '../player.ts';
import { guard, jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { listHeld, startUpload, storageRoom } from '../storage.ts';
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

type LookFrame = JudgedFrame;

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
        hint: 'Import it once job.get {job_id} says completed',
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
        'Long-running: returns a task, or {job_id, media_id} for job.get. The media_id is usable in edits as soon as the job reports processing, so with many files, start every import first and edit while they finish.',
        `Sources: ${rt.config.mediaRoots.length ? `a path under ${rt.config.mediaRoots.join(', ')}, ` : ''}an http(s) URL (Dropbox and Google Drive share links work as they are), the upload_id of a file sent through media.upload, a small file as a data: URI (up to ${MEDIA_LIMITS.inlineBytes / 1024 ** 2} MB, with its sha256 so a garbled copy is refused), or the job_id of a completed export.video (its render becomes media). A URL is fetched once, when the import starts: it only has to work until then (a short-lived signed link from the user's own storage is enough), and the copy stays here 7 days after last use. A file the user attached in the chat comes as file, when the client passes it.`,
        'Importing the same file again returns the same media_id.',
      ].join(' '),
      inputSchema: MediaImportInput,
      outputSchema: withJob(MediaInfo),
      // ChatGPT passes a file the user attached as this argument.
      _meta: { 'openai/fileParams': ['file'] },
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
      if (Boolean(args.source) === Boolean(args.file)) {
        throw new CfError('bad_request', 'Give either source or file', {
          hint: 'media.import {source: {url: "https://…"}}, or file as the client attached it',
        });
      }
      // An attached file downloads from its URL; a data: URI becomes an upload that is already in.
      const given = args.file
        ? { url: args.file.download_url }
        : (args.source as NonNullable<typeof args.source>);
      const source =
        'data' in given
          ? {
              upload_id: await rt.uploads.put(
                owner,
                args.name ?? `inline${extensionFor(dataUriType(given.data))}`,
                decodeDataUri(given.data, given.sha256),
              ),
            }
          : given;
      const named = args.name ?? (args.file?.file_name || undefined);
      // Path, upload and render imports fail fast (outside the roots, missing, unfinished) and
      // dedupe by fingerprint.
      const upload =
        'upload_id' in source ? await rt.uploads.take(owner, source.upload_id) : undefined;
      const local =
        'path' in source
          ? await rt.media.resolvePath(source.path)
          : 'job_id' in source
            ? await renderedFile(owner, source.job_id)
            : upload?.file;
      if (local) {
        const known = await rt.media.findByFingerprint(owner, await fingerprint(local));
        if (known) {
          if ('upload_id' in source) await rt.uploads.remove(owner, source.upload_id);
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
      // A download or a copied render adds to what the account holds; an upload is already in.
      const room =
        'url' in source
          ? await storageRoom(rt.ws, owner, await deps.limits?.())
          : local && 'job_id' in source
            ? await storageRoom(rt.ws, owner, await deps.limits?.(), (await stat(local)).size)
            : undefined;
      const admit = await admitJob(deps.limits);
      const record = await rt.media.create(
        owner,
        'job_id' in source
          ? { job: source.job_id }
          : 'upload_id' in source
            ? { upload: source.upload_id }
            : source,
        named ?? upload?.name ?? (local && 'job_id' in source ? basename(local) : undefined),
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
      rt.jobs.start(
        job,
        async ({ signal, progress }) => {
          const done = await rt.media.ingest(
            owner,
            record,
            (f, m) => progress(f, `${record.media_id}: ${m}`),
            signal,
            room === undefined
              ? {}
              : {
                  maxBytes: room,
                  tooBigHint:
                    "That is more than the account's storage has left. Files expire on their own (uploads after a day, media and exports 7 days after last use); media.list shows what is held",
                },
          );
          return ok(mediaInfo(done)) as never;
        },
        admit,
      );
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
        'Without a way to send it yourself, give the user the url: opened in a browser it is a page to drop the file on, which sends it and resumes on its own. media.import says whether the file is all in yet.',
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
      const upload = await startUpload(
        rt,
        deps.owner(),
        args.name,
        args.bytes,
        await deps.limits?.(),
      );
      return ok({
        ...upload,
        how: `curl --fail -T ${shellQuote(args.name)} '${upload.url}' (or the user opens the url in a browser and drops the file), then media.import {source: {upload_id: "${upload.upload_id}"}}`,
      });
    }),
  );

  server.registerTool(
    'media.list',
    {
      title: 'List media',
      description: [
        "What the user has here: imported and created media, and files they sent that aren't imported yet (through media.upload, or dropped on their account page at cuttingfloor.ai/account), with names, sizes and when each expires, plus the account's storage used and its cap.",
        'When the user mentions a file they sent or dropped ("the interview I uploaded"), find it here by name and media.import {source: {upload_id}} it; complete says it is all in. Listing does not count as a use, so nothing here lasts longer for being listed.',
      ].join(' '),
      inputSchema: MediaListInput,
      outputSchema: MediaListResult,
      annotations: {
        title: 'List media',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async () => ok(await listHeld(rt, deps.owner(), await deps.limits?.()))),
  );

  server.registerTool(
    'media.analyze',
    {
      title: 'Analyze media',
      description: [
        'Find what is in imported media, as data for edits. transcript: every word with its time (whisper.cpp on the CPU; the model downloads once). The words are reliable; their times are not exact: they can be off by up to about a second, the start of a word can sit in the silence before it, its end can run on over the pause after it, and short ums and uhs are often left out. To cut on speech, take the edges from kind silence and move each cut to the nearest one. beats: tempo, beat and downbeat times. faces: face boxes over time, e.g. to reframe to 9:16 with clip.set_transform keyframes. track: follow a region you give from a moment on. look: your own typed questions about what is on screen, answered on every sampled frame (to find where something happens from plain words, media.seek). silence: stretches quieter than threshold_db for at least min_seconds. scenes: times the picture changes by more than threshold (0–100).',
        'Times are media seconds; boxes are fractions of the picture. Results stay with the media (media.get include) except track, silence and scenes, which come back in the result. A result too long to return (a long transcript) comes back as its summary and a note on reading it in code.run.',
        'Long-running: returns a task, or a job_id for job.get.',
        '',
        'HOW LOOK WORKS. TypeSafe Jev, a fast judgment model (preview), answers your questions about frames sampled from the media. Each sampled frame is its own request: Jev sees that one picture, named `frame`, and with with_previous also the frame sampled just before it, named `previous`, plus any state you give: text or JSON entries by name, the same on every frame (the script, what a term means). Every question is answered on every frame, independently and in parallel (about 0.15 s a frame), as typed data you then combine in your own code.',
        'Choose the type by the answer you need. noul: yes or no, answered as noul, the probability of yes from 0 to 1. choice: one of options you name, answered as choice plus probabilities and confidence. score: a degree on levels you order, answered as score (0 is the first level; it can land between levels) plus confidence. box: where one thing is, answered as box {x, y, w, h} in fractions of the picture plus confidence.',
        'Write each question about the picture as it looks. Name the picture in backticks ("in `frame`"), ask about one thing, word it so yes means the thing is there, and describe it as it appears: "Does `frame` show a human being, even if only their face fills the picture?", "Is one large word laid over `frame`, much bigger than any other text?". To compare, name both pictures and the thing that differs: "Is there a button in `frame` that is not in `previous`?". To locate, name the one thing so only it fits ("the \'Get started for free\' button under the headline in `frame`") and, in the same call, a noul asking whether it is there; use the box on frames where that noul is high. Give a choice a none option for frames where nothing fits, and each score level a concrete situation.',
        'Read the answers this way: a noul of 0.5 or more reads as yes, and you can set your own cut-off; confidence tells you how far to trust a choice, a score or a box, and a loose box shows as low confidence. Work in passes: every_seconds 1 over the whole media, then at_seconds around the times where answers change. media.get scenes give when the picture cuts; look tells you what is on it.',
        `The result gives each question's spans (when a noul reads yes, which choice holds when); every frame's answers stay with the media (media.get include ['look'], the last 10 runs). Up to ${JUDGE_LIMITS.frames} frames and ${JUDGE_LIMITS.lookQuestions} questions a call. To find the moments that match a description, media.seek takes it in plain words and returns where it holds. For one judgment about text, a still or a single frame, judge.ask answers at once. Full guide to writing questions: https://docs.typesafe.ai/primitives and https://docs.typesafe.ai/images.`,
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
        checkFrameState('look', args.state);
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
        const sampled = sampleTimes(p?.kind === 'image' ? 0 : (p?.duration ?? 0), args);
        times = sampled.times;
        const asked = sampled.asked;
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
      const admit = await admitJob(deps.limits);
      const job = await store.create({
        owner,
        tool: 'media.analyze',
        meta: { media_id: args.media_id, kind: args.kind },
        statusMessage: `${args.kind}: starting`,
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(
        job,
        async ({ signal, progress }) => {
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
                  progress(0.3 + (0.7 * done) / of, `look: asked ${done} of ${of} frames`),
              });
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
        },
        admit,
      );
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'media.get',
    {
      title: 'Get media',
      description:
        'Status, a signed download url for the file and a page_url that plays or shows it in any browser (to give a person), streams, duration, frame rate, conform reasons, integrated loudness and summaries of media.analyze results under analyses (counts only: analyses.transcript.words is how many words). include returns those results in full at the top level, e.g. include ["transcript"] gives transcript.words, the list of words with times (for long media that is a lot: read it in code.run with cf.media.get and print only what you need).',
      inputSchema: MediaRefInput,
      outputSchema: MediaInfo,
      _meta: PLAYER_TOOL_META,
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
        ...(link ? { url: link.url, page_url: link.pageUrl, expires_at: link.expiresAt } : {}),
      });
    }),
  );
}

/** A file name as one shell word, for the example command. */
function shellQuote(name: string): string {
  return /^[\w.@%+=:,/-]+$/.test(name) ? name : `'${name.replace(/'/g, "'\\''")}'`;
}

/** The MIME type a data: URI declares, or '' for none. */
function dataUriType(uri: string): string {
  return /^data:([^;,]*)/i.exec(uri)?.[1]?.toLowerCase() ?? '';
}

/** A data: URI's bytes (RFC 2397), checked against the SHA-256 the caller gave. */
function decodeDataUri(uri: string, sha256: string | undefined): Buffer {
  const m = /^data:[^,]*?(;base64)?,(.*)$/is.exec(uri);
  if (!m) {
    throw new CfError('bad_request', 'data must be a data: URI', {
      hint: 'data:<type>;base64,<the file in base64>, e.g. data:image/png;base64,iVBORw0…',
    });
  }
  const body = m[2] ?? '';
  let bytes: Buffer;
  if (m[1]) {
    const clean = body.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) {
      throw new CfError('bad_request', 'The base64 in data has characters base64 never uses', {
        hint: 'Send the file again, base64-encoded exactly; for anything long, media.upload is safer',
      });
    }
    bytes = Buffer.from(clean, 'base64');
  } else {
    bytes = Buffer.from(decodeURIComponent(body), 'utf8');
  }
  if (!bytes.length) throw new CfError('bad_request', 'data holds no bytes');
  if (bytes.length > MEDIA_LIMITS.inlineBytes) {
    throw new CfError(
      'limit_exceeded',
      `data holds ${bytes.length} bytes; a data: URI takes up to ${MEDIA_LIMITS.inlineBytes}`,
      { hint: 'Send it with media.upload instead' },
    );
  }
  if (sha256) {
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== sha256) {
      throw new CfError(
        'bad_request',
        `data decodes to a file with SHA-256 ${got}, not ${sha256}`,
        {
          hint: 'The copy was changed on the way; send it again, or use media.upload for the file itself',
        },
      );
    }
  }
  return bytes;
}

/** A file extension for a MIME type, so the stored file reads as what it is. */
function extensionFor(type: string): string {
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mp4': '.m4a',
    'audio/ogg': '.ogg',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'font/ttf': '.ttf',
    'font/otf': '.otf',
    'text/plain': '.txt',
  };
  return known[type] ?? '';
}
