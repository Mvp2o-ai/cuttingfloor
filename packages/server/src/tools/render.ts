import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type OutputRecord, ticksPerFrame, toView } from '@cuttingfloor/core';
import {
  exportTimeline,
  fingerprint,
  imageExtension,
  lengthFrames,
  mayBeTransparent,
  notReady,
  qaCheck,
  renderMediaFrames,
  resolvePreset,
} from '@cuttingfloor/engine';
import { inlineJobContext, type Job, type JobContext } from '@cuttingfloor/jobs';
import {
  CfError,
  DEPRECATED_PRESETS,
  DEPRECATED_PRESETS_END,
  ExportResult,
  ExportVideoInput,
  expiry,
  JobGetInput,
  JobGetResult,
  JobListInput,
  JobListResult,
  JobRef,
  JobView,
  KEEP_MS,
  KEEP_THEN,
  QaCheckInput,
  QaCheckResult,
  RenderFramesInput,
  RenderFramesResult,
  span,
  type TimelineDoc,
  withJob,
} from '@cuttingfloor/schema';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { EDITOR_TOOL_META } from '../editor.ts';
import { admitJob } from '../meter.ts';
import {
  addPasses,
  assertOnline,
  framesUri,
  sourceMap,
  sourcesFor,
  timelineImage,
} from '../render.ts';
import { doneReply, guard, jobFor, jobReply, jobView, ok, waitForChange } from '../result.ts';
import type { ServerDeps } from '../server.ts';

/** QA on a timeline this short answers inline; longer ones become a job. */
const QA_INLINE_SECONDS = 20;

export function registerRenderTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  server.registerTool(
    'render.frames',
    {
      title: 'Render frames',
      description:
        'Look at a timeline (or a media file): up to 16 frames as one contact-sheet image (layout grid) or one image each (single). Media frames are numbered at the media frame rate; a picture that can be see-through (alpha or a palette) is shown over a light checkerboard, so transparency shows as checks and a background baked into the file as itself. size full: up to 4 frames at the sequence (or media) size from the original media, for thumbnails and stills to keep. format webp (default), png or jpeg, with quality for webp and jpeg. Each image comes inline and with a signed download url.',
      inputSchema: RenderFramesInput,
      outputSchema: RenderFramesResult,
      annotations: { ...readOnly, title: 'Render frames' },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const signal = (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal;
      const mime = `image/${args.format}`;
      const groups = args.layout === 'grid' ? [args.frames] : args.frames.map((f) => [f]);
      const images: z.infer<typeof RenderFramesResult>['images'] = [];
      const content: CallToolResult['content'] = [];
      const quality = args.format === 'png' ? undefined : args.quality;
      /** The image inline, and kept under outputs/ for its signed link. */
      const add = async (uri: string, frames: number[], data: Buffer) => {
        content.push({ type: 'image', data: data.toString('base64'), mimeType: mime });
        const key = `${uri}\0${args.size}\0${args.long_edge}\0${quality ?? ''}`;
        const dir = `f_${createHash('sha256').update(key).digest('hex').slice(0, 26)}`;
        const name = `${uri.split('/')[3]}-${frames.join('_')}.${imageExtension(args.format)}`;
        await rt.outputs.write(owner, dir, name, data, 'frames');
        const { url, expiresAt } = await rt.signOutput(owner, dir, name);
        images.push({
          uri,
          frames,
          url,
          expires_at: expiresAt,
          mime_type: mime,
          bytes: data.length,
        });
      };
      if (args.timeline_id) {
        const doc = await rt.timelines.get(owner, args.timeline_id);
        for (const frames of groups) {
          const data = await timelineImage(rt, owner, args.timeline_id, doc, frames, {
            longEdge: args.long_edge,
            full: args.size === 'full',
            format: args.format,
            ...(quality ? { quality } : {}),
            ...(signal ? { signal } : {}),
          });
          await add(framesUri('timeline', args.timeline_id, frames, args.format), frames, data);
        }
      } else if (args.media_id) {
        const record = await rt.media.get(owner, args.media_id);
        // Not probed yet: whether it has a picture isn't known until its job says processing.
        if (record.status === 'importing' || record.status === 'failed')
          throw notReady(record, null);
        const fps = record.probe?.video?.fps;
        if (!record.probe?.video || !fps)
          throw new CfError('bad_request', `Media ${args.media_id} has no picture`);
        const full = args.size === 'full';
        const file = await rt.media.sourceFile(record, full ? 'export' : 'preview');
        const v = record.probe.video;
        const rendered = await renderMediaFrames(file, fps, args.frames, {
          longEdge: full ? Math.max(v.width ?? 0, v.height ?? 0) || args.long_edge : args.long_edge,
          format: args.format,
          ...(quality ? { quality } : {}),
          layout: args.layout,
          checker: mayBeTransparent(record.probe),
          ...(signal ? { signal } : {}),
        });
        for (const [i, data] of rendered.entries()) {
          const frames = groups[i] ?? [];
          await add(framesUri('media', args.media_id, frames, args.format), frames, data);
        }
      }
      return ok({ images }, content);
    }),
  );

  server.registerTool(
    'export.video',
    {
      title: 'Export video',
      description: [
        'Render the timeline to a file, at the sequence size and frame rate. Formats: mp4_h264 (MP4), mp4_h264_fast (MP4, quick and small with sound, to watch a cut), mp4_av1 (MP4, AV1/Opus), mov_prores_422hq (MOV), gif (15 fps), wav, mp3. overrides sets another size (a box, aspect kept), fps, bitrate or crf (video://catalog/presets). Scaling up adds no detail: a picture made larger than its source looks soft.',
        `Long-running: returns a task, or {job_id} for job.get. The result links the file (a resource_link to video://jobs/{job_id}/output, which reads as the file, or its signed URL when large), has a signed download URL and a page_url that plays it in any browser (the link to give a person to watch or share), both working for ${Math.round(rt.config.outputUrlTtlMs / 3_600_000)} h (job.get gives fresh ones). The file itself is deleted ${span(KEEP_MS.job)} after the export finishes (kept_until, and expiry in words): save it from url to keep it${rt.config.exportsDir ? `, and the file is in the exports folder (${rt.config.exportsDir})` : ''}.`,
        'The server keeps the file 7 days, as a working copy: when the user has a finished piece to keep, offer to save it from the url where they keep their files, and media.import it to use it again.',
        'qa.check measures a render (gaps, frames, loudness) before you export. sha256 and fingerprint tell two renders apart without downloading them (fingerprint matches media.get of the file once imported).',
      ].join(' '),
      inputSchema: ExportVideoInput,
      outputSchema: withJob(ExportResult),
      _meta: EDITOR_TOOL_META,
      annotations: {
        title: 'Export video',
        readOnlyHint: false,
        // overwrite: true replaces an earlier file in the exports folder.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (input, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      const { preset, renamed } = currentPreset(input.preset);
      const args = { ...input, preset };
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'export.video', args.idempotency_key);
        if (existing) return withWarning(jobReply(existing, ctx), renamed);
      }
      const doc = await rt.timelines.get(owner, args.timeline_id);
      if (!lengthFrames(doc))
        throw new CfError('bad_request', 'The timeline is empty', {
          hint: 'Add clips with clip.add first',
        });
      // Copies some clips play (cleaned sound, in-between frames) are made inside the job.
      const { sources, offline } = await sourcesFor(rt, owner, doc, 'export', true, false);
      assertOnline(offline);
      // Checks the preset fits the sequence and the overrides fit the preset, before any job.
      const { spec, width, height } = resolvePreset(args.preset, doc.sequence, args.overrides);
      const limits = await deps.limits?.();
      const cap = limits?.shortSide;
      if (cap && !spec.audioOnly && Math.min(width, height) > cap) {
        const fit = width >= height ? `{height: ${cap}}` : `{width: ${cap}}`;
        throw new CfError(
          'limit_exceeded',
          `This export would be ${width}x${height}; this account exports up to ${cap}p`,
          {
            hint: `Pass overrides ${fit} to export at ${cap}p${limits?.account ? `. Export sizes: ${limits.account}` : ''}`,
            detail: {
              width,
              height,
              short_side_limit: cap,
              ...(limits?.account ? { pricing: limits.account } : {}),
            },
          },
        );
      }
      const name = `${args.filename ?? defaultName(doc, args.timeline_id)}.${spec.extension}`;
      const exportsDir = rt.config.exportsDir;
      if (exportsDir && !args.overwrite && (await exists(join(exportsDir, name)))) {
        throw new CfError('output_exists', `${name} already exists in the exports folder`, {
          hint: 'Pass overwrite: true, or a different filename',
        });
      }
      const admit = await admitJob(deps.limits);
      const job = await store.create({
        owner,
        tool: 'export.video',
        // What it renders, so media imported from it can say where it came from.
        meta: {
          timeline_id: args.timeline_id,
          preset: args.preset,
          ...(args.range
            ? { range_start: String(args.range.start), range_end: String(args.range.end) }
            : {}),
          // Kept with the job, so it outlives the timeline (24 h) for as long as the file lives.
          sources: JSON.stringify(sourceMap(toView(args.timeline_id, doc), args.range)),
        },
        statusMessage: 'starting',
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(
        job,
        async ({ signal, progress, status, waiting, aside }: JobContext) => {
          const out = await rt.outputs.reserve(owner, job.id, name);
          progress(0, 'preparing sources');
          await addPasses(rt, owner, doc, sources, 'export', true, signal, {
            timelineId: args.timeline_id,
            // While a fill (a job of its own) is made, this job waits for it: its stall clock
            // stops, and its status says how far the fill is.
            waiting: (on, message) => {
              waiting(on);
              status(message);
            },
            // ...and gives its job slot to other work meanwhile.
            aside,
          });
          const started = Date.now();
          const { frames, width, height } = await exportTimeline(doc, args.preset, sources, out, {
            ...(args.range ? { range: args.range } : {}),
            ...(args.overrides ? { overrides: args.overrides } : {}),
            signal,
            onProgress: (f) => {
              const elapsed = (Date.now() - started) / 1000;
              const left = f > 0.02 ? Math.round((elapsed / f) * (1 - f)) : null;
              progress(
                f * 0.98,
                `encoding ${Math.round(f * 100)}%${left !== null ? ` · ${left}s left` : ''}`,
              );
            },
          });
          const rate = doc.sequence.fps.num / doc.sequence.fps.den;
          const span = args.range ? args.range.end - args.range.start : lengthFrames(doc);
          // The file's identity: its SHA-256, and the fingerprint media.import gives it.
          const sha256 = await new Promise<string>((resolve, reject) => {
            const hash = createHash('sha256');
            createReadStream(out)
              .on('data', (d) => hash.update(d))
              .on('error', reject)
              .on('end', () => resolve(hash.digest('hex')));
          });
          const result = {
            ...(await publish(rt, owner, job.id, out, name, { page: true, kind: 'export' })),
            sha256,
            fingerprint: await fingerprint(out),
            frames,
            width,
            height,
            ...(spec.audioOnly ? {} : { fps: args.overrides?.fps ?? spec.gif?.fps ?? rate }),
            duration_seconds: Math.round((span / rate) * 1000) / 1000,
            preset: args.preset,
            mime_type: spec.mime,
          };
          // A review is for the model to watch; any other render is for the person. The https link
          // lets a host that can show video to its model fetch it without reading MCP resources.
          const audience: Array<'user' | 'assistant'> =
            args.preset === 'mp4_h264_fast' ? ['assistant'] : ['user'];
          return ok(result, [
            {
              type: 'resource_link',
              uri: result.uri,
              name,
              mimeType: spec.mime,
              annotations: { audience },
            },
            {
              type: 'resource_link',
              uri: result.url,
              name,
              mimeType: spec.mime,
              description: `Signed download, valid until ${result.expires_at}`,
              annotations: { audience },
            },
          ]) as never;
        },
        {
          ...admit,
          work:
            ((args.range ? args.range.end - args.range.start : lengthFrames(doc)) *
              doc.sequence.fps.den) /
            doc.sequence.fps.num,
          kept: 'Copies of clips it had finished making (cleaned sound, in-between frames, fills) are kept and reused, so the new job starts from them',
        },
      );
      return withWarning(jobReply(job, ctx), renamed);
    }),
  );

  server.registerTool(
    'qa.check',
    {
      title: 'QA check',
      description: `Measure the rendered timeline: gaps in the picture, offline media, rendered against expected frame count, integrated loudness (LUFS) and true peak (dBTP), plus black and silent stretches when you give their settings. With speech {min_probability}, every cut is listed with speech facts: the speech probability of the mix just before and after it (Silero VAD), the seconds without speech each side, and, per clip edge, the transcript word it cuts through and how much of that word is lost (from the media's transcript, when it has one). Facts only, no verdicts. A timeline up to ${QA_INLINE_SECONDS} s is checked within the call (which waits its turn for a render when the server is busy) and answers as a completed job, the report in result; longer ones return a task or job.`,
      inputSchema: QaCheckInput,
      outputSchema: withJob(QaCheckResult),
      // A long timeline queues a job, which counts as a write.
      annotations: { ...readOnly, readOnlyHint: false, title: 'QA check' },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const doc = await rt.timelines.get(owner, args.timeline_id);
      const run = async ({ signal, progress }: JobContext) => {
        const { sources, offline } = await sourcesFor(rt, owner, doc, 'preview');
        // Cut facts name the transcript words clip edges cut through, from each media's own.
        const words = new Map<
          string,
          Array<{ text: string; start: number; end: number; confidence: number }>
        >();
        if (args.speech) {
          const ids = new Set(
            doc.tracks.flatMap((t) =>
              t.clips.flatMap((c) => (c.type === 'media' ? [c.media_id] : [])),
            ),
          );
          for (const id of ids) {
            const record = await rt.media.find(owner, id).catch(() => undefined);
            const list = record?.analyses?.transcript?.words;
            if (list?.length) words.set(id, list);
          }
        }
        const report = await qaCheck(doc, sources, offline, {
          ...(args.speech
            ? { speech: { minProbability: args.speech.min_probability, words } }
            : {}),
          ...(args.range ? { range: args.range } : {}),
          ...(args.black
            ? {
                black: {
                  pixelThreshold: args.black.pixel_threshold,
                  pictureShare: args.black.picture_share,
                  minSeconds: args.black.min_seconds,
                },
              }
            : {}),
          ...(args.silence
            ? {
                silence: {
                  thresholdDb: args.silence.threshold_db,
                  minSeconds: args.silence.min_seconds,
                },
              }
            : {}),
          signal,
          onProgress: (f) => progress(f, `checking ${Math.round(f * 100)}%`),
        });
        return ok(report);
      };
      const seconds = (lengthFrames(doc) * ticksPerFrame(doc.sequence.fps)) / 705_600_000;
      if (seconds <= QA_INLINE_SECONDS) {
        const signal =
          (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal ??
          new AbortController().signal;
        return doneReply(
          rt.jobs.store,
          { owner, tool: 'qa.check', meta: { timeline_id: args.timeline_id } },
          await run(inlineJobContext(signal)),
          ctx,
        );
      }
      const admit = await admitJob(deps.limits);
      const job = await rt.jobs.store.create({
        owner,
        tool: 'qa.check',
        meta: { timeline_id: args.timeline_id },
        statusMessage: 'starting',
      });
      rt.jobs.start(job, run as never, { ...admit, work: seconds });
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'job.get',
    {
      title: 'Get job',
      description:
        'Status, progress and, once completed, the result of long-running calls (media.import, media.analyze, create.*, export.video, qa.check). Same record as tasks/get. status_message says what it is doing, or where it stands in the queue; for names the media or timeline. wait_seconds (up to 50) answers when any job asked for finishes, fails or is cancelled, or when the wait runs out (then with its progress), so one call waits instead of many polls. seconds_left and starts_in_seconds come only when progress so far allows. job_ids reads many and answers {jobs, not_found}, each result in brief (result_summary: lists cut to their first items, with what was cut) unless result is full; result summary does the same for one job. A job whose progress stops for minutes ends with a stalled error, freeing its slot.',
      inputSchema: JobGetInput,
      outputSchema: JobGetResult,
      annotations: { ...readOnly, title: 'Get job' },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      if (Boolean(args.job_id) === Boolean(args.job_ids)) {
        throw new CfError('bad_request', 'Give either job_id or job_ids', {
          hint: 'job.get {job_id: "j_…"} for one job, or {job_ids: ["j_…", "j_…"]} for many',
        });
      }
      const ids = args.job_id ? [args.job_id] : [...new Set(args.job_ids)];
      await waitForChange(
        rt.jobs.store,
        owner,
        ids,
        args.wait_seconds,
        (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal,
      );
      // One job is read for its result; many at once are a status check, kept small.
      const mode = args.result ?? (args.job_id ? 'full' : 'summary');
      const view = (job: Job) => jobView(job, { result: mode, estimate: rt.jobs.estimate(job.id) });
      // A finished job's links and media come along, as they would from tasks/result.
      const extra = (job: Job) => {
        if (mode !== 'full') return [];
        const done = job.result as
          | { isError?: boolean; content?: CallToolResult['content'] }
          | undefined;
        return done && !done.isError ? (done.content ?? []).filter((c) => c.type !== 'text') : [];
      };
      if (args.job_id) {
        // Its links signed again, so a job read days later still hands out working ones.
        const job = await rt.freshLinks(await rt.jobs.store.get(args.job_id, owner));
        if (!job)
          throw new CfError('not_found', `No job ${args.job_id}`, {
            hint: `Finished jobs are kept ${span(KEEP_MS.job)}`,
          });
        return ok(view(job), extra(job));
      }
      const found = await rt.freshLinks(
        await Promise.all(ids.map((id) => rt.jobs.store.get(id, owner))),
      );
      const jobs = found.filter((j): j is Job => Boolean(j));
      return ok(
        {
          jobs: jobs.map(view),
          not_found: ids.filter((_, i) => !found[i]),
        },
        jobs.flatMap(extra),
      );
    }),
  );

  server.registerTool(
    'job.list',
    {
      title: 'List jobs',
      description:
        'Your recent jobs, newest first, each with its status, progress and for (the media or timeline it is for), filtered by status, tool or media_id. Results are left out unless you ask (result summary or full); job.get reads one.',
      inputSchema: JobListInput,
      outputSchema: JobListResult,
      annotations: { ...readOnly, title: 'List jobs' },
    },
    guard(async (args) => {
      const media = args.media_id;
      const jobs = await rt.jobs.store.list(deps.owner(), {
        ...(args.status ? { status: args.status } : {}),
        limit: args.limit,
        ...(args.tool || media
          ? {
              where: (job: Job) => {
                if (args.tool && job.tool !== args.tool) return false;
                if (!media) return true;
                const f = jobFor(job);
                return Boolean(
                  f &&
                    (f.media_id === media ||
                      f.media_ids?.includes(media) ||
                      f.inputs?.includes(media)),
                );
              },
            }
          : {}),
      });
      const views = (args.result === 'none' ? jobs : await rt.freshLinks(jobs)).map((job) =>
        jobView(job, { result: args.result, estimate: rt.jobs.estimate(job.id) }),
      );
      return ok({ jobs: views });
    }),
  );

  server.registerTool(
    'job.cancel',
    {
      title: 'Cancel job',
      description:
        'Stop a job, queued or running, within seconds: its engines are killed and its slot goes to the next job. Finished jobs are left as they are.',
      inputSchema: JobRef,
      outputSchema: JobView,
      annotations: {
        title: 'Cancel job',
        readOnlyHint: false,
        // A stopped job's work is lost; it cannot be resumed.
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args) => {
      const job = await rt.jobs.cancel(args.job_id, deps.owner());
      if (!job) throw new CfError('not_found', `No job ${args.job_id}`);
      return ok(jobView(job));
    }),
  );
}

/**
 * A finished output: hard-linked (or copied) into the exports folder in local mode, and a signed
 * download URL either way.
 */
export async function publish(
  rt: ServerDeps['runtime'],
  owner: string,
  jobId: string,
  out: string,
  name: string,
  options: { page?: boolean; kind?: OutputRecord['kind'] } = {},
) {
  await rt.outputs.publish(owner, jobId, name, out, options.kind ?? 'timeline');
  let file: string | undefined;
  const exportsDir = rt.config.exportsDir;
  if (exportsDir) {
    await mkdir(exportsDir, { recursive: true });
    const target = join(exportsDir, name);
    await rm(target, { force: true });
    await link(out, target).catch(() => copyFile(out, target));
    file = join(process.env.CUTTINGFLOOR_EXPORTS_HOST_PATH ?? exportsDir, name);
  }
  const { url, pageUrl, expiresAt } = await rt.signOutput(owner, jobId, name);
  // The job finishes as this is written; it and its output go KEEP_MS.job after.
  const until = Date.now() + KEEP_MS.job;
  return {
    url,
    ...(options.page ? { page_url: pageUrl } : {}),
    expires_at: expiresAt,
    kept_until: new Date(until).toISOString(),
    expiry: expiry(until, KEEP_THEN.job),
    uri: `video://jobs/${jobId}/output`,
    ...(file ? { file } : {}),
    bytes: (await stat(out)).size,
  };
}

export function defaultName(doc: TimelineDoc, id: string): string {
  const slug =
    doc.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'timeline';
  return `${slug}-${id.slice(3, 11)}`;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

type Preset = z.infer<typeof ExportVideoInput>['preset'];
type OldPreset = keyof typeof DEPRECATED_PRESETS;

/** What an out-of-date client should hear about an old preset name. */
function refresh(old: OldPreset): string {
  return `Preset ${old} is an old name: use ${DEPRECATED_PRESETS[old]}. This app has an out-of-date cuttingfloor tool list; ask the user to refresh the cuttingfloor connection (or remove and add it again) to get the current tools.`;
}

/**
 * The current name for a preset. A deprecated name runs as its format until
 * DEPRECATED_PRESETS_END, logged so we know when nobody sends it; from then on it is refused.
 */
export function currentPreset(
  preset: Preset,
  now = new Date(),
): { preset: Exclude<Preset, OldPreset>; renamed?: OldPreset } {
  if (!Object.hasOwn(DEPRECATED_PRESETS, preset))
    return { preset: preset as Exclude<Preset, OldPreset> };
  const old = preset as OldPreset;
  if (now.toISOString().slice(0, 10) >= DEPRECATED_PRESETS_END)
    throw new CfError('bad_request', `Preset ${old} no longer exists`, { hint: refresh(old) });
  process.stderr.write(`deprecated: export.video preset ${old}\n`);
  return { preset: DEPRECATED_PRESETS[old], renamed: old };
}

/** Puts the deprecation first in the reply's hint, where the agent reads what to do next. */
function withWarning(reply: CallToolResult, renamed: OldPreset | undefined): CallToolResult {
  const structured = reply.structuredContent;
  if (!renamed || !structured || reply.isError) return reply;
  const hint =
    `Deprecated: ${refresh(renamed)} Old names stop working on ${DEPRECATED_PRESETS_END}. ${String((structured as { hint?: string }).hint ?? '')}`.trim();
  const text = JSON.stringify(structured);
  const next = { ...structured, hint };
  return {
    ...reply,
    structuredContent: next,
    content: reply.content.map((c) =>
      c.type === 'text' && c.text === text ? { type: 'text', text: JSON.stringify(next) } : c,
    ),
  };
}
