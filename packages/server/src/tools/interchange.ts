import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { INTERCHANGE_FILES, type InterchangeMedia, writeInterchange } from '@cuttingfloor/core';
import { BIN, run } from '@cuttingfloor/engine';
import {
  CfError,
  ExportTimelineInput,
  ExportTimelineResult,
  TICKS_PER_SECOND,
  type TimelineDoc,
  withJob,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { guard, jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { defaultName, exists, publish } from './render.ts';

// export.timeline: the edit as an NLE or caption file. Best effort (spec §21.6): the warnings
// say what the format couldn't carry; timeline.get is the lossless way to keep work. `collect`
// zips the file with the media it refers to, so it opens on another machine.

/** Every media id the timeline uses, nested timelines included. */
function mediaIds(doc: TimelineDoc): string[] {
  const ids = new Set(Object.keys(doc.media));
  for (const n of Object.values(doc.nested ?? {}))
    for (const id of Object.keys(n.media)) ids.add(id);
  return [...ids];
}

/**
 * Where an NLE on this machine finds a file: in local mode, the container's /media/videos is the
 * folder compose mounted from the host (CUTTINGFLOOR_MEDIA_HOST_PATH says which).
 */
function hostPath(path: string): string {
  const host = process.env.CUTTINGFLOOR_MEDIA_HOST_PATH;
  return host && path.startsWith('/media/videos/')
    ? join(host, path.slice('/media/videos/'.length))
    : path;
}

export function registerInterchangeTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;
  server.registerTool(
    'export.timeline',
    {
      title: 'Export timeline',
      description: [
        'Write the edit for another editor: fcpxml (Final Cut Pro, DaVinci Resolve), otio (Premiere, Resolve, OpenTimelineIO apps), edl (CMX 3600, one video track), or srt/vtt (the captions).',
        'Best effort: warnings lists what the format could not carry (masks, blend modes, effects, animated transforms, ramps, text styling). timeline.get is the lossless copy.',
        'media collect makes a .zip with the media files next to the timeline file.',
        'Long-running: a task, or {job_id} for job.get; the result has a signed download URL.',
      ].join(' '),
      inputSchema: ExportTimelineInput,
      outputSchema: withJob(ExportTimelineResult),
      annotations: {
        title: 'Export timeline',
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
        const existing = await store.findIdempotent(owner, 'export.timeline', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }
      const doc = await rt.timelines.get(owner, args.timeline_id);
      const captions = args.format === 'srt' || args.format === 'vtt';
      const collect = args.media === 'collect' && !captions;
      const ext = INTERCHANGE_FILES[args.format].ext;
      const base = args.filename ?? defaultName(doc, args.timeline_id);
      const name = `${base}.${collect ? 'zip' : ext}`;
      const exportsDir = rt.config.exportsDir;
      if (exportsDir && !args.overwrite && (await exists(join(exportsDir, name)))) {
        throw new CfError('output_exists', `${name} already exists in the exports folder`, {
          hint: 'Pass overwrite: true, or a different filename',
        });
      }
      // Every media item, resolved now so a missing one fails before the job starts.
      const records = captions
        ? []
        : await Promise.all(mediaIds(doc).map((id) => rt.media.get(owner, id)));
      const job = await store.create({
        owner,
        tool: 'export.timeline',
        statusMessage: 'writing',
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(job, async ({ signal, progress }) => {
        const warnings: string[] = [];
        const media = new Map<string, InterchangeMedia>();
        const files = new Map<string, string>();
        const used = new Set<string>();
        for (const r of records) {
          const original = r.file ?? ('path' in r.source ? r.source.path : undefined);
          if (!original) {
            warnings.push(
              `${r.name} (${r.media_id}) has no file to refer to; its clips are left out`,
            );
            continue;
          }
          let path = hostPath(original);
          if (collect) {
            // media/<name>.<ext>, unique in the bundle.
            const stem = basename(r.name, extname(r.name)).replace(/[^\w .-]+/g, '_') || r.media_id;
            const fileExt = extname(original).slice(0, 8);
            let file = `${stem}${fileExt}`;
            for (let i = 2; used.has(file.toLowerCase()); i++) file = `${stem}-${i}${fileExt}`;
            used.add(file.toLowerCase());
            files.set(file, original);
            path = `media/${file}`;
          } else if (path === original && rt.config.mode === 'hosted') {
            warnings.push(
              `${r.name} is referred to by its server path; use media: collect to take the files along`,
            );
          }
          const p = r.probe;
          media.set(r.media_id, {
            name: r.name,
            path,
            duration: p?.duration ? Math.round(p.duration * TICKS_PER_SECOND) : null,
            ...(p?.video ? { width: p.video.width, height: p.video.height, fps: p.video.fps } : {}),
            ...(p?.audio ? { channels: p.audio.channels, sample_rate: p.audio.sample_rate } : {}),
          });
        }
        const written = writeInterchange(args.format, doc, (id) => media.get(id));
        warnings.push(...written.warnings);
        const outDir = rt.ws.ownerDir(owner, 'outputs', job.id);
        await mkdir(outDir, { recursive: true });
        const out = join(outDir, name);
        if (!collect) {
          await writeFile(out, written.text);
        } else {
          const dir = await mkdtemp(join(tmpdir(), 'cf-collect-'));
          try {
            await writeFile(join(dir, `${base}.${ext}`), written.text);
            await mkdir(join(dir, 'media'));
            let i = 0;
            for (const [file, from] of files) {
              progress(0.1 + (0.6 * i++) / Math.max(1, files.size), `collecting ${file}`);
              await copyFile(from, join(dir, 'media', file));
            }
            progress(0.75, 'zipping');
            // Stored, not compressed: media is compressed already.
            await run(BIN.zip, ['-q', '-0', '-r', out, `${base}.${ext}`, 'media'], {
              cwd: dir,
              signal,
              timeoutMs: 4 * 60 * 60_000,
            });
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
        const result = {
          ...(await publish(rt, owner, job.id, out, name)),
          format: args.format,
          mime_type: collect ? 'application/zip' : INTERCHANGE_FILES[args.format].type,
          media: media.size,
          warnings,
        };
        return ok(result, [
          { type: 'resource_link', uri: result.uri, name, mimeType: result.mime_type },
        ]) as never;
      });
      return jobReply(job, ctx);
    }),
  );
}
