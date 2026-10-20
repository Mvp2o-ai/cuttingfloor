import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ticksPerFrame } from '@cuttingfloor/core';
import {
  exportTimeline,
  imageExtension,
  lengthFrames,
  qaCheck,
  renderMediaFrames,
  renderSource,
  resolvePreset,
} from '@cuttingfloor/engine';
import type { JobContext } from '@cuttingfloor/jobs';
import {
  CfError,
  ExportResult,
  ExportVideoInput,
  JobGetInput,
  JobListInput,
  JobListResult,
  JobRef,
  JobView,
  QaCheckInput,
  QaCheckResult,
  RenderFramesInput,
  RenderFramesResult,
  type TimelineDoc,
  withJob,
} from '@cuttingfloor/schema';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { admitJob } from '../meter.ts';
import { PLAYER_TOOL_META } from '../player.ts';
import { assertOnline, framesUri, sourcesFor, timelineImage } from '../render.ts';
import { guard, jobReply, jobView, ok } from '../result.ts';
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
        'Look at a timeline (or a media file): up to 16 frames as one contact-sheet image (layout grid) or one image each (single). Media frames are numbered at the media frame rate. size full: up to 4 frames at the sequence (or media) size from the original media, for thumbnails and stills to keep. format webp (default), png or jpeg, with quality for webp and jpeg. Each image comes inline and with a signed download url.',
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
        const folder = rt.ws.ownerDir(owner, 'outputs', dir);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, name), data);
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
        const fps = record.probe?.video?.fps;
        if (!record.probe?.video || !fps)
          throw new CfError('bad_request', `Media ${args.media_id} has no picture`);
        const full = args.size === 'full';
        const file = renderSource(record, full ? 'export' : 'preview');
        const v = record.probe.video;
        const rendered = await renderMediaFrames(file, fps, args.frames, {
          longEdge: full ? Math.max(v.width ?? 0, v.height ?? 0) || args.long_edge : args.long_edge,
          format: args.format,
          ...(quality ? { quality } : {}),
          layout: args.layout,
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
        'Render the timeline to a file. Presets: web_1080p_h264 (MP4, fits 1920x1080), master_prores_422hq (MOV, sequence size), social_9x16_h264 (9:16 sequences, 1080x1920), web_1080p_av1 (MP4, AV1/Opus), gif (640 px, 15 fps), review_h264 (MP4, fits 854x854 with sound: small and quick, to watch a cut), audio_wav_48k, audio_mp3. overrides changes size, fps, bitrate or crf (video://catalog/presets).',
        `Long-running: returns a task, or {job_id} for job.get. The result links the file (a resource_link to video://jobs/{job_id}/output, which reads as the file, or its signed URL when large), has a signed download URL and a page_url that plays it in any browser (the link to give a person to watch or share), both working for ${Math.round(rt.config.outputUrlTtlMs / 3_600_000)} h`,
        rt.config.exportsDir
          ? `and the file in the exports folder (${rt.config.exportsDir}).`
          : '.',
        'qa.check measures a render (gaps, frames, loudness) before you export.',
      ].join(' '),
      inputSchema: ExportVideoInput,
      outputSchema: withJob(ExportResult),
      _meta: PLAYER_TOOL_META,
      annotations: {
        title: 'Export video',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'export.video', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }
      const doc = await rt.timelines.get(owner, args.timeline_id);
      if (!lengthFrames(doc))
        throw new CfError('bad_request', 'The timeline is empty', {
          hint: 'Add clips with clip.add first',
        });
      const { sources, offline } = await sourcesFor(rt, owner, doc, 'export');
      assertOnline(offline);
      // Checks the preset fits the sequence and the overrides fit the preset, before any job.
      const { spec, width, height } = resolvePreset(args.preset, doc.sequence, args.overrides);
      const cap = (await deps.limits?.())?.shortSide;
      if (cap && !spec.audioOnly && Math.min(width, height) > cap) {
        const fit = width >= height ? `{height: ${cap}}` : `{width: ${cap}}`;
        throw new CfError(
          'limit_exceeded',
          `This export would be ${width}x${height}; your plan exports up to ${cap}p`,
          {
            hint: `Pass overrides ${fit} to export at ${cap}p, or move to a plan with larger exports`,
            detail: { width, height, short_side_limit: cap },
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
        statusMessage: 'starting',
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(
        job,
        async ({ signal, progress }: JobContext) => {
          const outDir = rt.ws.ownerDir(owner, 'outputs', job.id);
          await mkdir(outDir, { recursive: true });
          const out = join(outDir, name);
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
          const result = {
            ...(await publish(rt, owner, job.id, out, name, { page: true })),
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
            args.preset === 'review_h264' ? ['assistant'] : ['user'];
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
        admit,
      );
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'qa.check',
    {
      title: 'QA check',
      description:
        'Measure the rendered timeline: gaps in the picture, offline media, rendered against expected frame count, integrated loudness (LUFS) and true peak (dBTP), plus black and silent stretches when you give their settings. Facts only, no verdicts. Short timelines answer at once; longer ones return a task or job.',
      inputSchema: QaCheckInput,
      outputSchema: withJob(QaCheckResult),
      annotations: { ...readOnly, title: 'QA check' },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const doc = await rt.timelines.get(owner, args.timeline_id);
      const run = async ({ signal, progress }: JobContext) => {
        const { sources, offline } = await sourcesFor(rt, owner, doc, 'preview');
        const report = await qaCheck(doc, sources, offline, {
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
        return run({ signal, progress: () => undefined, status: () => undefined });
      }
      const admit = await admitJob(deps.limits);
      const job = await rt.jobs.store.create({
        owner,
        tool: 'qa.check',
        statusMessage: 'starting',
      });
      rt.jobs.start(job, run as never, admit);
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'job.get',
    {
      title: 'Get job',
      description:
        'Status, progress and, once completed, the result of a long-running call (media.import, create.*, export.video, qa.check, code.run). Same record as tasks/get. status_message says what it is doing, or, while it waits, where it stands in the queue and what it waits for. wait_seconds holds the call until the job finishes or the time is up, so one call usually covers a short job.',
      inputSchema: JobGetInput,
      outputSchema: JobView,
      annotations: { ...readOnly, title: 'Get job' },
    },
    guard(async (args) => {
      const owner = deps.owner();
      const deadline = Date.now() + args.wait_seconds * 1000;
      let job = await rt.jobs.store.get(args.job_id, owner);
      if (!job)
        throw new CfError('not_found', `No job ${args.job_id}`, {
          hint: 'Finished jobs are kept 7 days',
        });
      // Reads the stored record, so it waits the same whichever node runs the job.
      while (job.status === 'working' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(250, deadline - Date.now())));
        job = (await rt.jobs.store.get(args.job_id, owner)) ?? job;
      }
      // A finished job's links and media come along, as they would from tasks/result.
      const done = job.result as
        | { isError?: boolean; content?: CallToolResult['content'] }
        | undefined;
      const extra =
        done && !done.isError ? (done.content ?? []).filter((c) => c.type !== 'text') : [];
      return ok(jobView(job), extra);
    }),
  );

  server.registerTool(
    'job.list',
    {
      title: 'List jobs',
      description: 'Your recent jobs, newest first.',
      inputSchema: JobListInput,
      outputSchema: JobListResult,
      annotations: { ...readOnly, title: 'List jobs' },
    },
    guard(async (args) => {
      const jobs = await rt.jobs.store.list(deps.owner(), {
        ...(args.status ? { status: args.status } : {}),
        limit: args.limit,
      });
      return ok({ jobs: jobs.map(jobView) });
    }),
  );

  server.registerTool(
    'job.cancel',
    {
      title: 'Cancel job',
      description: 'Stop a running job. Finished jobs are left as they are.',
      inputSchema: JobRef,
      outputSchema: JobView,
      annotations: {
        title: 'Cancel job',
        readOnlyHint: false,
        destructiveHint: false,
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
  options: { page?: boolean } = {},
) {
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
  return {
    url,
    ...(options.page ? { page_url: pageUrl } : {}),
    expires_at: expiresAt,
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
