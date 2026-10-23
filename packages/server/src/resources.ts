import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PROVIDER_ENV, type ProviderId } from '@cuttingfloor/credentials';
import { engineVersions, renderLoad, renderMediaFrames, renderSource } from '@cuttingfloor/engine';
import { CfError } from '@cuttingfloor/schema';
import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { outputMime } from './mime.ts';
import { timelineImage, timelineWaveform } from './render.ts';
import { jobView } from './result.ts';
import type { ServerDeps } from './server.ts';
import { SERVER_VERSION } from './version.ts';

export const HEALTH_URI = 'video://server/health';

let versions: Promise<Record<string, string | null>> | undefined;

export function registerResources(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;

  server.registerResource(
    'health',
    HEALTH_URI,
    {
      title: 'Server health',
      description:
        'Server and engine versions, mode, limits, and which providers have a key configured (never the key).',
      mimeType: 'application/json',
    },
    async (uri) => {
      const owner = deps.owner();
      versions ??= engineVersions();
      const providers = Object.fromEntries(
        await Promise.all(
          (Object.keys(PROVIDER_ENV) as ProviderId[]).map(
            async (p) => [p, await deps.credentials.status(owner, p)] as const,
          ),
        ),
      );
      const body = {
        server: 'cuttingfloor',
        version: SERVER_VERSION,
        mode: rt.config.mode,
        engines: await versions,
        media_roots: rt.config.mediaRoots,
        exports_dir: rt.config.exportsDir,
        retention: { timelines_hours: 24, media_days: 7, jobs_days: 7 },
        max_concurrent_jobs: rt.config.maxJobs,
        renders: renderLoad(),
        providers,
      };
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body) }],
      };
    },
  );

  server.registerResource(
    'timeline-waveform',
    new ResourceTemplate('video://timeline/{timeline_id}/waveform/{spec}', { list: undefined }),
    {
      title: 'Timeline waveform',
      description:
        'The mix of a timeline span as a waveform image: {spec} is start_end frames plus .webp or .png, e.g. 0_250.webp',
      mimeType: 'image/webp',
    },
    async (uri, vars) => {
      const m = /^(\d+)_(\d+)\.(webp|png)$/.exec(String(vars.spec));
      if (!m)
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Spec is start_end.webp or .png');
      const id = String(vars.timeline_id);
      const owner = deps.owner();
      const format = m[3] as 'webp' | 'png';
      const doc = await mustExist(() => rt.timelines.get(owner, id));
      const wave = await mustExist(() =>
        timelineWaveform(
          rt,
          owner,
          id,
          doc,
          { start: Number(m[1]), end: Number(m[2]) },
          { format },
        ),
      );
      return {
        contents: [
          { uri: uri.href, mimeType: `image/${format}`, blob: wave.image.toString('base64') },
        ],
      };
    },
  );

  server.registerResource(
    'timeline-frames',
    new ResourceTemplate('video://timeline/{timeline_id}/frames/{spec}', { list: undefined }),
    {
      title: 'Timeline frames',
      description:
        'Frames of a timeline as one image: {spec} is frame numbers joined by _ plus .webp, .png or .jpeg, e.g. 0_24_48.webp',
      mimeType: 'image/webp',
    },
    async (uri, vars) => {
      const { frames, format } = parseSpec(String(vars.spec));
      const id = String(vars.timeline_id);
      const owner = deps.owner();
      const doc = await mustExist(() => rt.timelines.get(owner, id));
      const image = await mustExist(() => timelineImage(rt, owner, id, doc, frames, { format }));
      return {
        contents: [{ uri: uri.href, mimeType: `image/${format}`, blob: image.toString('base64') }],
      };
    },
  );

  server.registerResource(
    'media-frames',
    new ResourceTemplate('video://media/{media_id}/frames/{spec}', { list: undefined }),
    {
      title: 'Media frames',
      description:
        'Frames of an imported media file (at its own frame rate) as one image, e.g. 0_100.webp',
      mimeType: 'image/webp',
    },
    async (uri, vars) => {
      const { frames, format } = parseSpec(String(vars.spec));
      const record = await mustExist(() => rt.media.get(deps.owner(), String(vars.media_id)));
      const fps = record.probe?.video?.fps;
      if (!fps)
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'This media has no picture');
      const [image] = await mustExist(() =>
        renderMediaFrames(renderSource(record, 'preview'), fps, frames, {
          longEdge: 640,
          format,
          layout: 'grid',
        }),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: `image/${format}`,
            blob: (image ?? Buffer.alloc(0)).toString('base64'),
          },
        ],
      };
    },
  );

  server.registerResource(
    'job',
    new ResourceTemplate('video://jobs/{job_id}', { list: undefined }),
    {
      title: 'Job status',
      description: 'A job record, as job.get returns it.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const job = await rt.freshLinks(await rt.jobs.store.get(String(vars.job_id), deps.owner()));
      if (!job)
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown job ${String(vars.job_id)}`,
        );
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(jobView(job)) },
        ],
      };
    },
  );

  server.registerResource(
    'job-output',
    new ResourceTemplate('video://jobs/{job_id}/output', { list: undefined }),
    {
      title: 'Job output',
      description:
        'The file a finished export.video or export.timeline made, as its own type (video/mp4, video/quicktime, image/gif, audio/*, …) for a client or model that takes it in. Files over the inline limit answer with their signed download URL (text/uri-list) instead of the bytes.',
    },
    async (uri, vars) => {
      const owner = deps.owner();
      const id = String(vars.job_id);
      const job = await rt.jobs.store.get(id, owner);
      if (!job) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown job ${id}`);
      const dir = rt.ws.ownerDir(owner, 'outputs', id);
      const [name] = await readdir(dir).catch(() => [] as string[]);
      if (job.status !== 'completed' || !name) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Job ${id} has no output (status ${job.status})`,
        );
      }
      const file = join(dir, name);
      const mimeType = outputMime(name);
      // Size and bytes come from one open handle, so the file can't change in between.
      const handle = await open(file, 'r');
      try {
        const { size } = await handle.stat();
        if (size > rt.config.inlineMaxBytes) {
          const { url } = await rt.signOutput(owner, id, name);
          return { contents: [{ uri: uri.href, mimeType: 'text/uri-list', text: url }] };
        }
        const blob = (await handle.readFile()).toString('base64');
        return { contents: [{ uri: uri.href, mimeType, blob }] };
      } finally {
        await handle.close();
      }
    },
  );
}

function parseSpec(spec: string): { frames: number[]; format: 'webp' | 'png' | 'jpeg' } {
  const m = /^(\d+(?:_\d+){0,15})\.(webp|png|jpeg)$/.exec(decodeURIComponent(spec));
  if (!m)
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'Expected frames like 0_24_48.webp (at most 16)',
    );
  return {
    frames: (m[1] ?? '').split('_').map(Number),
    format: m[2] as 'webp' | 'png' | 'jpeg',
  };
}

/** Domain errors on resource reads surface as invalid-params protocol errors. */
async function mustExist<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CfError) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `${error.code}: ${error.message}${error.hint ? ` (${error.hint})` : ''}`,
      );
    }
    throw error;
  }
}
