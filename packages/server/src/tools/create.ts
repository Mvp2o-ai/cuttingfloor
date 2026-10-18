import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CUTOUT_MODELS,
  type CutoutModel,
  cutout,
  KOKORO,
  type MediaRecord,
  mediaInfo,
  renderMatte,
  renderPicture,
  speak,
  voiceWords,
} from '@cuttingfloor/engine';
import {
  CfError,
  CreateCutoutInput,
  CreateMatteInput,
  CreateMotionInput,
  CreateStillInput,
  CreateVoiceoverInput,
  MOTION_LIMITS,
  MotionRequest,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { renderInSandbox } from '../motion.ts';
import { guard, jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';

// create.*: new media from a recipe. Each is a job whose result is a media_id; the same recipe
// returns the same media while it lives. HTML runs only in the motion sandbox.

/** Bumped when the output of a recipe would change, so old cached results aren't reused. */
const RECIPE_VERSION = 'frames-1';

const annotations = (title: string) => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export function registerCreateTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;

  /** Shared flow: idempotency, the recipe cache, then a job that makes the file and imports it. */
  async function create(
    ctx: unknown,
    tool: string,
    args: { name?: string | undefined; idempotency_key?: string | undefined },
    recipe: unknown,
    make: (
      dir: string,
      progress: (f: number, m: string) => void,
      signal: AbortSignal,
    ) => Promise<string>,
    /** After import: anything else kept with the media (e.g. a voiceover's word timings). */
    finish?: (
      record: MediaRecord,
      progress: (f: number, m: string) => void,
      signal: AbortSignal,
    ) => Promise<MediaRecord>,
  ) {
    const owner = deps.owner();
    const store = rt.jobs.store;
    if (args.idempotency_key) {
      const existing = await store.findIdempotent(owner, tool, args.idempotency_key);
      if (existing) return jobReply(existing, ctx);
    }
    const hash = createHash('sha256')
      .update(JSON.stringify([tool, RECIPE_VERSION, recipe]))
      .digest('hex')
      .slice(0, 40);
    const key = args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {};
    const known = await rt.media.findByRecipe(owner, hash);
    if (known) {
      const job = await store.create({ owner, tool, meta: { media_id: known.media_id }, ...key });
      return jobReply(
        await store.update(job, {
          status: 'completed',
          progress: 1,
          statusMessage: 'made before from the same recipe',
          result: ok(mediaInfo(known)) as never,
        }),
        ctx,
      );
    }
    const record = await rt.media.create(
      owner,
      { created: tool, recipe: hash },
      args.name ?? `${tool.split('.')[1]}-${hash.slice(0, 8)}`,
    );
    const job = await store.create({
      owner,
      tool,
      meta: { media_id: record.media_id },
      statusMessage: `making ${record.media_id}`,
      ...key,
    });
    rt.jobs.start(job, async ({ signal, progress }) => {
      const say = (f: number, m: string) => progress(f, `${record.media_id}: ${m}`);
      const share = finish ? 0.6 : 0.85;
      record.file = await make(
        rt.media.dir(owner, record.media_id),
        (f, m) => say(share * f, m),
        signal,
      );
      let done = await rt.media.ingest(owner, record, (f, m) => say(share + 0.1 * f, m), signal);
      if (finish)
        done = await finish(done, (f, m) => say(share + 0.1 + (0.9 - share) * f, m), signal);
      await rt.media.rememberRecipe(owner, hash, done.media_id);
      return ok(mediaInfo(done)) as never;
    });
    return jobReply(job, ctx);
  }

  /** Images and fonts the page uses, read from their imports, with fingerprints for the recipe. */
  async function assets(list: Array<{ name: string; media_id: string }>) {
    const owner = deps.owner();
    const names = new Set<string>();
    const out: Array<{ name: string; data: string; fingerprint: string }> = [];
    for (const a of list) {
      if (names.has(a.name)) throw new CfError('bad_request', `Two assets are named ${a.name}`);
      names.add(a.name);
      const record = await rt.media.get(owner, a.media_id);
      const kind = record.probe?.kind;
      if (record.status !== 'ready' || !record.file) {
        throw new CfError('media_not_ready', `Media ${a.media_id} is still importing`);
      }
      if (kind !== 'image' && kind !== 'font') {
        throw new CfError(
          'bad_request',
          `Asset ${a.name} (${a.media_id}) is ${kind ?? 'unknown'}; only images and fonts can go into a page`,
          {
            hint: 'Put video and sound on the timeline instead, under or over the graphic',
          },
        );
      }
      out.push({
        name: a.name,
        data: (await readFile(record.file)).toString('base64'),
        fingerprint: record.fingerprint ?? a.media_id,
      });
    }
    return out;
  }

  const sandbox = async (
    request: MotionRequest,
    dir: string,
    progress: (f: number, m: string) => void,
    signal: AbortSignal,
  ) => {
    const dest = join(
      dir,
      request.kind === 'still' ? 'source.png' : request.transparent ? 'source.mov' : 'source.mp4',
    );
    await renderInSandbox(rt.config.motionUrl, request, dest, progress, signal);
    return dest;
  };

  const sandboxNote = rt.config.motionUrl
    ? "Runs in the sandbox: no network (inline everything, load libraries from lib/; assets are for imported files the page must show as they are, like the user's logo or a font), fixed memory and time limits. To match a reference you were shown, rebuild it in HTML/SVG; it does not need importing."
    : 'Needs the motion sandbox, which is not running on this server.';

  server.registerTool(
    'create.motion',
    {
      title: 'Create a motion graphic',
      description: [
        'Render animated HTML to a video with alpha, frame-exactly: lower thirds, animated titles, callouts, logo stings, kinetic type, generated graphics. Place the media_id with clip.add on a track above the video.',
        `Up to ${MOTION_LIMITS.maxSeconds} s, and width × height × fps × seconds up to 30 s of 1080p30.`,
        sandboxNote,
        'Long-running: returns a task, or {job_id, media_id} for job.get. The same recipe returns the same media.',
      ].join(' '),
      inputSchema: CreateMotionInput,
      annotations: annotations('Create a motion graphic'),
    },
    guard(async (args, ctx) => {
      const files = await assets(args.assets);
      const request: MotionRequest = {
        kind: 'motion',
        html: args.html,
        width: args.width,
        height: args.height,
        fps: args.fps,
        duration: args.duration_seconds,
        transparent: args.transparent,
        assets: files.map(({ name, data }) => ({ name, data })),
      };
      const parsed = MotionRequest.safeParse(request);
      if (!parsed.success) {
        throw new CfError('limit_exceeded', parsed.error.issues[0]?.message ?? 'Too large', {
          hint: 'Lower the size, frame rate or length, or make it in parts',
        });
      }
      const recipe = {
        ...request,
        assets: files.map(({ name, fingerprint }) => [name, fingerprint]),
      };
      return create(ctx, 'create.motion', args, recipe, (dir, progress, signal) =>
        sandbox(request, dir, progress, signal),
      );
    }),
  );

  server.registerTool(
    'create.still',
    {
      title: 'Create a still',
      description: [
        'Render an HTML page to a PNG: title and end cards, thumbnails, overlays, designed text. Transparent where nothing is painted. Capture waits for fonts, and for window.__ready if the page sets it to a promise (up to 10 s).',
        sandboxNote,
        'Long-running: returns a task, or {job_id, media_id} for job.get.',
      ].join(' '),
      inputSchema: CreateStillInput,
      annotations: annotations('Create a still'),
    },
    guard(async (args, ctx) => {
      const files = await assets(args.assets);
      const request: MotionRequest = {
        kind: 'still',
        html: args.html,
        width: args.width,
        height: args.height,
        fps: 1,
        duration: 1,
        transparent: args.transparent,
        assets: files.map(({ name, data }) => ({ name, data })),
      };
      const recipe = {
        ...request,
        assets: files.map(({ name, fingerprint }) => [name, fingerprint]),
      };
      return create(ctx, 'create.still', args, recipe, (dir, progress, signal) =>
        sandbox(request, dir, progress, signal),
      );
    }),
  );

  server.registerTool(
    'create.matte',
    {
      title: 'Create a matte',
      description:
        'A solid or gradient picture (PNG, any length on a timeline): backgrounds, slugs, colour washes with clip.set_blend. Gradients work like CSS: angle 180 runs top to bottom; radial reaches the corners; colours may carry alpha (#RRGGBBAA). Long-running like every create.* tool, but quick.',
      inputSchema: CreateMatteInput,
      annotations: annotations('Create a matte'),
    },
    guard(async (args, ctx) => {
      const spec = {
        width: args.width,
        height: args.height,
        ...(args.color ? { color: args.color.toLowerCase() } : {}),
        ...(args.gradient
          ? {
              gradient: {
                ...args.gradient,
                from: args.gradient.from.toLowerCase(),
                to: args.gradient.to.toLowerCase(),
              },
            }
          : {}),
      };
      return create(ctx, 'create.matte', args, spec, async (dir, progress, signal) => {
        progress(0.2, 'drawing');
        const dest = join(dir, 'source.png');
        await renderMatte(dest, spec, signal);
        return dest;
      });
    }),
  );

  server.registerTool(
    'create.voiceover',
    {
      title: 'Create a voiceover',
      description:
        'English text spoken by a natural voice (Kokoro, local; the model downloads once) as WAV media. words (default) times each word into the media transcript for caption.add {from_transcript}. Long-running: a task, or {job_id, media_id} for job.get.',
      inputSchema: CreateVoiceoverInput,
      annotations: annotations('Create a voiceover'),
    },
    guard(async (args, ctx) => {
      const recipe = {
        model: KOKORO.name,
        text: args.text,
        voice: args.voice,
        speed: args.speed,
        words: args.words,
      };
      return create(
        ctx,
        'create.voiceover',
        args,
        recipe,
        async (dir, progress, signal) => {
          const dest = join(dir, 'source.wav');
          await speak(args.text, dest, {
            voice: args.voice,
            speed: args.speed,
            modelsDir: rt.modelsDir,
            signal,
            onProgress: progress,
          });
          return dest;
        },
        args.words
          ? async (record, progress, signal) => {
              const transcript = await voiceWords(record.file as string, args.text, {
                modelsDir: rt.modelsDir,
                signal,
                onProgress: (f, m) => progress(f, `timing words: ${m}`),
              });
              return rt.media.saveAnalysis(deps.owner(), record.media_id, 'transcript', transcript);
            }
          : undefined,
      );
    }),
  );

  server.registerTool(
    'create.cutout',
    {
      title: 'Cut out a subject',
      description:
        'A subject without its background, local: ProRes 4444 with alpha and the sound, or a PNG, to lay over a new background. subject any (BiRefNet) cuts out products, animals or objects; people (MODNet) is fast enough for long video. Long-running: a task, or {job_id, media_id} for job.get.',
      inputSchema: CreateCutoutInput,
      annotations: annotations('Cut out a subject'),
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const source = await rt.media.get(owner, args.media_id);
      const p = source.probe;
      if (source.status !== 'ready' || !p) {
        throw new CfError('media_not_ready', `Media ${args.media_id} is still importing`);
      }
      if (!p.video || (p.kind !== 'video' && p.kind !== 'image')) {
        throw new CfError('bad_request', `Media ${args.media_id} has no picture to cut out`);
      }
      const picture = renderPicture(source, 'export');
      const image = p.kind === 'image';
      const model: CutoutModel =
        args.subject === 'any' || (args.subject === 'auto' && image) ? 'birefnet' : 'modnet';
      const recipe = {
        model: CUTOUT_MODELS[model],
        source: source.fingerprint ?? source.media_id,
        smooth: image ? 0 : args.smooth,
      };
      return create(
        ctx,
        'create.cutout',
        { ...args, name: args.name ?? `${source.name} cutout` },
        recipe,
        async (dir, progress, signal) => {
          const dest = join(dir, image ? 'source.png' : 'source.mov');
          progress(0, 'matting');
          await cutout(
            {
              file: picture.path,
              width: picture.width ?? p.video?.width ?? 0,
              height: picture.height ?? p.video?.height ?? 0,
              image,
              ...(p.video?.fps ? { fps: p.video.fps } : {}),
              audio: Boolean(p.audio),
              duration: p.duration,
            },
            dest,
            { model, smooth: args.smooth, signal, onProgress: (f) => progress(f, 'matting') },
          );
          return dest;
        },
      );
    }),
  );
}
