import { SoundsListInput, SoundsListResult } from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { guard, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { SOUNDS_TOOL_META } from '../sounds-view.ts';

// sounds.list: the sound library (sound-library.ts) by page, or ranked by a sound in words.

export const SOUNDS_LIST_DESCRIPTION = [
  "The sound library: sound effects to add to an edit (footsteps, impacts, whooshes, ambiences, weather, crowds, animals, vehicles, doors, weapons, interface and game sounds, meme and hype hits…) from CC0 and public-domain packs, free to use in anything. These are sounds to add, not sounds in the user's media (media.analyze sounds and media.listen find those).",
  'With query, a sound in words: the closest sounds first, matched on their names and tags and on how they sound; each says its similarity (0–1) and whether the words matched. Without query: the library in order, by category then name. Both page with offset (next_offset) and filter by category, pack and length; the result lists every category and pack.',
  "Each sound's url is its file as its pack published it, for media.import; loudness_lufs and peak_dbtp are measured from it, and the level in the mix is yours.",
  'Where the chat app shows it, the result is a player in which the user can search, hear each sound and pick one; to let them hear particular sounds, list them by sound_ids.',
].join(' ');

export function registerSoundTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'sounds.list',
    {
      title: 'List and search sound effects',
      description: SOUNDS_LIST_DESCRIPTION,
      inputSchema: SoundsListInput,
      outputSchema: SoundsListResult,
      _meta: SOUNDS_TOOL_META,
      annotations: {
        title: 'List and search sound effects',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args, ctx) =>
      ok(
        await deps.runtime.sounds.list(
          args,
          (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal ??
            new AbortController().signal,
        ),
      ),
    ),
  );
}
