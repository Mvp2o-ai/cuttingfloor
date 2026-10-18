import { loadEmbedder } from './embed.ts';
import { type Library, loadLibrary } from './library.ts';
import { SkillIndex } from './search.ts';

// One library and one index per process, built on first use: every server instance (one per
// connection, hosted) shares them. Nothing here outlives a restart, and nothing needs to.

export interface Skills {
  library: Library;
  index: SkillIndex;
  /** Why search is keywords only, when it is. */
  degraded: string | null;
}

let shared: Promise<Skills> | undefined;

export function skills(): Promise<Skills> {
  shared ??= (async () => {
    const library = loadLibrary();
    const loaded = await loadEmbedder();
    const index = await SkillIndex.build(library.skills, loaded.embedder);
    const degraded = loaded.embedder
      ? index.semantic
        ? null
        : 'embedding the skills failed'
      : loaded.reason;
    return { library, index, degraded };
  })();
  return shared;
}
