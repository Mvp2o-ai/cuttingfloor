import { copyFile, link, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ticksPerFrame } from '@cuttingfloor/core';
import {
  exportTimeline,
  lengthFrames,
  qaCheck,
  renderMediaFrames,
  renderSource,
  resolvePreset,
} from '@cuttingfloor/engine';
import type { JobContext } from '@cuttingfloor/jobs';
import {
  CfError,
  ExportVideoInput,
  JobListInput,
  JobListResult,
  JobRef,
  JobView,
  QaCheckInput,
  QaCheckResult,
  RenderFramesInput,
  RenderFramesResult,
  type TimelineDoc,
} from '@cuttingfloor/schema';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
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
        'Look at a timeline (or a media file): up to 16 frames as one contact-sheet image (layout grid) or one image each (single). Media frames are numbered at the media frame rate. size full: up to 4 frames at the sequence (or media) size from the original media, for thumbnails and stills to keep.',
      inputSchema: RenderFramesInput,
      outputSchema: RenderFramesResult,
      annotations: { ...readOnly, title: 'Render frames' },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const signal = (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal;
      const mime = args.format === 'png' ? 'image/png' : 'image/webp';
      const groups = args.layout === 'grid' ? [args.frames] : args.frames.map((f) => [f]);
      const images: Array<{ uri: string; frames: number[] }> = [];
      const content: CallToolResult['content'] = [];
      if (args.timeline_id) {
        const doc = await rt.timelines.get(owner, args.timeline_id);
        for (const frames of groups) {
          const data = await timelineImage(rt, owner, args.timeline_id, doc, frames, {
            longEdge: args.long_edge,
            full: args.size === 'full',
            format: args.format,
            ...(signal ? { signal } : {}),
          });
          content.push({ type: 'image', data: data.toString('base64'), mimeType: mime });
          images.push({
            uri: framesUri('timeline', args.timeline_id, frames, args.format),
            frames,
          });
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
          layout: args.layout,
          ...(signal ? { signal } : {}),
        });
        rendered.forEach((data, i) => {
          const frames = groups[i] ?? [];
          content.push({ type: 'image', data: data.toString('base64'), mimeType: mime });
          images.push({
            uri: framesUri('media', args.media_id ?? '', frames, args.format),
            frames,
          });
        });
      }
      return ok({ images }, content);
    }),
  );

  server.registerTool(
    'export.video',
    {
      title: 'Export video',
      description: [
        'Render the timeline to a file. Presets: web_1080p_h264 (MP4, fits 1920x1080), master_prores_422hq (MOV, sequence size), social_9x16_h264 (9:16 sequences, 1080x1920), web_1080p_av1 (MP4, AV1/Opus), gif (640 px, 15 fps), audio_wav_48k, audio_mp3. overrides changes size, fps, bitrate or crf (video://catalog/presets).',
        'Long-running: returns a task, or {job_id} for job.get. The result has a signed download URL',
        rt.config.exportsDir
          ? `and the file in the exports folder (${rt.config.exportsDir}).`
          : '.',
        'Run qa.check first if you want the exact checks.',
      ].join(' '),
      inputSchema: ExportVideoInput,
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
      const { spec } = resolvePreset(args.preset, doc.sequence, args.overrides);
      const name = `${args.filename ?? defaultName(doc, args.timeline_id)}.${spec.extension}`;
      const exportsDir = rt.config.exportsDir;
      if (exportsDir && !args.overwrite && (await exists(join(exportsDir, name)))) {
        throw new CfError('output_exists', `${name} already exists in the exports folder`, {
          hint: 'Pass overwrite: true, or a different filename',
        });
      }
      const job = await store.create({
        owner,
        tool: 'export.video',
        statusMessage: 'starting',
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(job, async ({ signal, progress }: JobContext) => {
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
        const result = {
          ...(await publish(rt, owner, job.id, out, name)),
          frames,
          width,
          height,
          preset: args.preset,
          mime_type: spec.mime,
        };
        return ok(result, [
          { type: 'resource_link', uri: result.uri, name, mimeType: spec.mime },
        ]) as never;
      });
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'qa.check',
    {
      title: 'QA check',
      description:
        'Exact checks on the rendered timeline: gaps in the picture, offline media, black frames, silence, loudness against a target (default -14 LUFS, true peak -1 dBTP) and the rendered frame count. Short timelines answer at once; longer ones return a task or job.',
      inputSchema: QaCheckInput,
      outputSchema: QaCheckResult,
      annotations: { ...readOnly, title: 'QA check' },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const doc = await rt.timelines.get(owner, args.timeline_id);
      const run = async ({ signal, progress }: JobContext) => {
        const { sources, offline } = await sourcesFor(rt, owner, doc, 'preview');
        const report = await qaCheck(doc, sources, offline, {
          ...(args.range ? { range: args.range } : {}),
          targetLufs: args.loudness_target_lufs,
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
        return run({ signal, progress: () => undefined });
      }
      const job = await rt.jobs.store.create({
        owner,
        tool: 'qa.check',
        statusMessage: 'starting',
      });
      rt.jobs.start(job, run as never);
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'job.get',
    {
      title: 'Get job',
      description:
        'Status, progress and, once completed, the result of a long-running call (media.import, export.video, qa.check). Same record as tasks/get.',
      inputSchema: JobRef,
      outputSchema: JobView,
      annotations: { ...readOnly, title: 'Get job' },
    },
    guard(async (args) => {
      const job = await rt.jobs.store.get(args.job_id, deps.owner());
      if (!job)
        throw new CfError('not_found', `No job ${args.job_id}`, {
          hint: 'Finished jobs are kept 7 days',
        });
      return ok(jobView(job));
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
  const { url, expiresAt } = await rt.signOutput(owner, jobId, name);
  return {
    url,
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
