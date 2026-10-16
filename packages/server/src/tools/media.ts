import { fingerprint, mediaInfo } from '@cuttingfloor/engine';
import { MediaImportInput, MediaInfo, MediaRefInput } from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { guard, jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';

export function registerMediaTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;

  server.registerTool(
    'media.import',
    {
      title: 'Import media',
      description: [
        'Import a video, audio or image file: probe, fingerprint, conform if needed (VFR, rotation, HDR → BT.709), 540p proxy, scene and loudness analysis.',
        'Long-running: returns a task, or {job_id, media_id} for job.get. The media_id is usable in edits as soon as the job reports processing.',
        `Sources: ${rt.config.mediaRoots.length ? `a path under ${rt.config.mediaRoots.join(', ')}, or ` : ''}an http(s) URL.`,
        'Importing the same file again returns the same media_id.',
      ].join(' '),
      inputSchema: MediaImportInput,
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
      // Path imports fail fast (outside the roots, missing) and dedupe by fingerprint.
      if ('path' in args.source) {
        const real = await rt.media.resolvePath(args.source.path);
        const known = await rt.media.findByFingerprint(owner, await fingerprint(real));
        if (known) {
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
      const record = await rt.media.create(owner, args.source, args.name);
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
    'media.get',
    {
      title: 'Get media',
      description:
        'Status, streams, duration, frame rate, conform reasons, scene cuts, loudness and silences for imported media.',
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
    guard(async (args) => ok(mediaInfo(await rt.media.get(deps.owner(), args.media_id)))),
  );
}
