import type { CredentialStore } from '@cuttingfloor/credentials';
import { McpServer } from '@modelcontextprotocol/server';
import { registerCatalogs } from './catalog.ts';
import { registerResources } from './resources.ts';
import type { Runtime } from './runtime.ts';
import { registerTasks } from './tasks.ts';
import { registerCodeTools } from './tools/code.ts';
import { registerCreateTools } from './tools/create.ts';
import { registerInterchangeTools } from './tools/interchange.ts';
import { registerMediaTools } from './tools/media.ts';
import { registerRenderTools } from './tools/render.ts';
import { registerTimelineTools } from './tools/timeline.ts';
import { SERVER_NAME, SERVER_VERSION } from './version.ts';

export interface ServerDeps {
  runtime: Runtime;
  credentials: CredentialStore;
  /** Identity that owns timelines, media and jobs: `local` in local mode, the token's `sub` hosted. */
  owner: () => string;
}

const INSTRUCTIONS = `cuttingfloor is a headless video editor. It makes video two ways, often both at once:
- Make new: create.motion (animated HTML), create.still, create.matte and create.voiceover build media from nothing. An image, mockup or page the user shows you is a reference for you to look at and rebuild in HTML, not a file to import.
- Edit what the user has: media.import their footage, music or logo (a path under the media roots or a URL; to try it, /samples/sample.mp4 and /samples/card.png where available).
Typical flow:
1. Get media: create.* for new material, media.import for the user's own files (both long-running: a task, or job.get {job_id, wait_seconds: 50}). Use the media_id once status is processing or ready.
2. timeline.create with a sequence ({width, height, fps:{num,den}}), then edit: clip.add, clip.trim, clip.split, clip.move, clip.remove, track.* — or edit.batch for many edits at once.
3. Every edit returns a NEW timeline_id; keep using the latest one. Older ids stay valid, so going back is just using an older id. An edit result is {timeline_id, parent, changed: [{id, type, change}], clip_id?, clip_ids?, track_id?, preview: {uri, frames, status} | null, warnings}.
   Timing: clip.set_speed (rate, ramp curve, reverse), clip.freeze, clip.roll / slip / slide, clip.replace, range.lift / range.extract (cut a span out of every track at once). Nest a timeline as one clip with clip.add {nested_timeline_id}.
   Transitions: transition.add at the cut after a clip (dissolve, dips, wipes, slides, pushes, zooms, iris, spin; linked audio crossfades).
   Text: title.add and caption.add (segments, SRT or VTT; word timings drive highlights) on a video track; text.set restyles many at once.
   Audio: audio.set_gain (keyframes for rides), audio.set_pan, audio.fade, audio.duck (music under speech), audio.set_loudness (e.g. -14 LUFS). Audio edits preview as a waveform with measured loudness.
   Effects: filter.add on a clip, a track or the whole timeline (video://catalog/effects: colour, LUTs, blur, vignette, chroma key, glitch; EQ, compressor, denoise, pitch); adjustment.add for effects over everything below for a stretch.
   Analysis: media.analyze {kind: transcript | beats | faces | track} turns media into data: cut by words (clip.add source {words}), caption from a transcript (caption.add from_transcript), cut on beats, reframe on the faces' focus, pin a title to a tracked object.
   Overlays and picture-in-picture: put a clip on a higher video track, then clip.set_transform, clip.set_mask, clip.set_blend and clip.set_animation. Catalogues of accepted names are resources at video://catalog/{name}.
   Create: create.motion (any animated HTML, rendered frame-exactly with alpha in a sandbox), create.still (HTML to a PNG), create.matte (solid or gradient), create.voiceover (speech with timed words) and create.cutout (a subject without its background) make new media to place with clip.add.
   Code: code.run runs a node/python/bash script in the sandbox for anything the tools don't cover. Inside it, cf.domain.verb(args) calls these same tools on the same media and timelines, and files written to out/ come back as media or timelines, so code and tools hand work to each other.
4. Look at the result with preview: "inline" on an edit, or render.frames.
5. qa.check, then export.video (long-running) for a signed download URL: presets for web, masters, 9:16 social, AV1, GIF and audio, with size/fps/bitrate overrides (video://catalog/presets). export.timeline hands the edit to another editor (FCPXML, OTIO, EDL) or writes captions (SRT, VTT).
Time is integer frames at the sequence rate; ranges are end-exclusive. Timelines expire 24 h after last use (timeline.get + timeline.load restores one); media and outputs after 7 days.`;

/** Builds one MCP server instance over the shared runtime. Transports live in apps/. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  openOutputSchemas(server);
  registerTasks(server, deps);
  registerResources(server, deps);
  registerCatalogs(server);
  registerTimelineTools(server, deps);
  registerMediaTools(server, deps);
  registerCreateTools(server, deps);
  registerCodeTools(server, deps);
  registerRenderTools(server, deps);
  registerInterchangeTools(server, deps);
  return server;
}

/**
 * Advertises output schemas without `additionalProperties: false`. Clients cache a tool's output
 * schema when they connect and validate results against it, so with closed schemas a field added
 * in a later release fails every result until the client reconnects. Results are still checked
 * against the full zod schema here.
 */
function openOutputSchemas(server: McpServer): void {
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: { outputSchema?: unknown }, handler: unknown) =>
    register(
      name,
      (config.outputSchema
        ? { ...config, outputSchema: openSchema(config.outputSchema as StandardJson) }
        : config) as never,
      handler as never,
    )) as typeof server.registerTool;
}

interface StandardJson {
  '~standard': {
    jsonSchema: {
      input: (o: unknown) => Record<string, unknown>;
      output: (o: unknown) => Record<string, unknown>;
    };
  };
}

function openSchema<S extends StandardJson>(schema: S): S {
  const std = schema['~standard'];
  const jsonSchema = {
    ...std.jsonSchema,
    output: (options: unknown) => withoutClosedObjects(std.jsonSchema.output(options)),
  };
  return new Proxy(schema, {
    get: (target, key, receiver) =>
      key === '~standard' ? { ...std, jsonSchema } : Reflect.get(target, key, receiver),
  });
}

function withoutClosedObjects(node: unknown): never {
  if (Array.isArray(node)) return node.map(withoutClosedObjects) as never;
  if (!node || typeof node !== 'object') return node as never;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' && v === false) continue;
    out[k] = withoutClosedObjects(v);
  }
  return out as never;
}
