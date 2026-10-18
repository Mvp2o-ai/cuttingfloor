import { loadEmbedder } from './embed.ts';
import { type Library, loadLibrary } from './library.ts';
import { SkillIndex } from './search.ts';
import { readVectors } from './vectors.ts';

// One library and one index per process, built on first use: every server instance (one per
// connection, hosted) shares them. The skills' vectors come from the file the image build wrote;
// any it lacks (a skill edited since, or local dev) are embedded here, in memory.

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
    const index = await SkillIndex.build(library.skills, loaded.embedder, readVectors());
    const degraded = loaded.embedder
      ? index.semantic
        ? null
        : 'embedding the skills failed'
      : loaded.reason;
    return { library, index, degraded };
  })();
  return shared;
}
