import type { CredentialStore } from '@cuttingfloor/credentials';
import { McpServer } from '@modelcontextprotocol/server';
import { registerResources } from './resources.ts';
import type { Runtime } from './runtime.ts';
import { registerTasks } from './tasks.ts';
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

const INSTRUCTIONS = `cuttingfloor is a headless video editor. Typical flow (to try it, import /samples/sample.mp4 and /samples/card.png where available):
1. media.import each file (long-running: a task, or poll job.get). Use the media_id once status is processing or ready.
2. timeline.create with a sequence ({width, height, fps:{num,den}}), then edit: clip.add, clip.trim, clip.split, clip.move, clip.remove, track.* — or edit.batch for many edits at once.
3. Every edit returns a NEW timeline_id; keep using the latest one. Older ids stay valid, so going back is just using an older id.
4. Look at the result with preview: "inline" on an edit, or render.frames.
5. qa.check, then export.video (long-running) for a signed download URL.
Time is integer frames at the sequence rate; ranges are end-exclusive. Timelines expire 24 h after last use (timeline.get + timeline.load restores one); media and outputs after 7 days.`;

/** Builds one MCP server instance over the shared runtime. Transports live in apps/. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTasks(server, deps);
  registerResources(server, deps);
  registerTimelineTools(server, deps);
  registerMediaTools(server, deps);
  registerRenderTools(server, deps);
  return server;
}
