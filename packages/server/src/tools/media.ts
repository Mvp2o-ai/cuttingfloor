import {
  analyseBeats,
  detectFaces,
  fingerprint,
  mediaInfo,
  renderSource,
  trackRegion,
  transcribe,
} from '@cuttingfloor/engine';
import {
  CfError,
  MediaAnalyzeInput,
  MediaImportInput,
  MediaInfo,
  MediaRefInput,
} from '@cuttingfloor/schema';
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
    'media.analyze',
    {
      title: 'Analyze media',
      description: [
        'Find what is in imported media, as data for edits. transcript: every word with its time (whisper.cpp on the CPU; the model downloads once). beats: tempo, beat and downbeat times. faces: face boxes over time plus a smoothed focus point for reframing (e.g. to 9:16 with clip.set_transform keyframes). track: follow a region you give from a moment on.',
        'Times are media seconds; boxes are fractions of the picture. Results stay with the media (media.get include) except track, which comes back in the result.',
        'Long-running: returns a task, or a job_id for job.get.',
      ].join(' '),
      inputSchema: MediaAnalyzeInput,
      annotations: {
        title: 'Analyze media',
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
      const needsPicture = args.kind === 'faces' || args.kind === 'track';
      if (needsPicture ? !p?.video || p.kind === 'image' : !p?.audio) {
        throw new CfError(
          'bad_request',
          `Media ${args.media_id} has no ${needsPicture ? 'moving picture' : 'sound'} to analyze`,
        );
      }
      if (args.kind === 'track' && !args.region) {
        throw new CfError('bad_request', 'track needs a region: {at_seconds, x, y, w, h}');
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
        const size = v
          ? v.rotation % 180
            ? { width: v.height, height: v.width }
            : { width: v.width, height: v.height }
          : { width: 0, height: 0 };
        // Store a result with the media, re-reading it first so concurrent analyses keep each other's.
        const keep = async (patch: NonNullable<typeof record.analyses>) => {
          const latest = await rt.media.get(owner, args.media_id);
          latest.analyses = { ...latest.analyses, ...patch };
          await rt.media.save(owner, latest);
          return latest;
        };
        switch (args.kind) {
          case 'transcript': {
            const transcript = await transcribe(file, {
              model: args.model,
              modelsDir: rt.modelsDir,
              language: args.language,
              signal,
              onProgress: (f, m) => progress(f, `transcript: ${m}`),
            });
            const latest = await keep({ transcript });
            return ok({
              media_id: args.media_id,
              kind: args.kind,
              summary: mediaInfo(latest).analyses?.transcript,
              transcript,
            }) as never;
          }
          case 'beats': {
            progress(0.1, 'beats: listening');
            const beats = await analyseBeats(file, signal);
            const latest = await keep({ beats });
            return ok({
              media_id: args.media_id,
              kind: args.kind,
              summary: mediaInfo(latest).analyses?.beats,
              beats,
            }) as never;
          }
          case 'faces': {
            progress(0.1, 'faces: looking');
            const faces = await detectFaces(file, size, { signal });
            const latest = await keep({ faces });
            return ok({
              media_id: args.media_id,
              kind: args.kind,
              summary: mediaInfo(latest).analyses?.faces,
              faces,
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
        'Status, streams, duration, frame rate, conform reasons, scene cuts, loudness, silences and summaries of media.analyze results; include returns those results in full.',
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
    guard(async (args) =>
      ok(mediaInfo(await rt.media.get(deps.owner(), args.media_id), args.include ?? [])),
    ),
  );
}
