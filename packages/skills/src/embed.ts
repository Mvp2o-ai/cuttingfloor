// Sentence embeddings on the CPU, with no provider key: all-MiniLM-L6-v2 (Apache-2.0, 384
// dimensions, int8, about 23 MB) through Transformers.js. The image carries the model under
// /usr/share/cuttingfloor/models, and nothing is downloaded at run time: without the model,
// search is keywords only.

export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

const MODELS = process.env.CUTTINGFLOOR_SKILLS_MODELS ?? '/usr/share/cuttingfloor/models';

export interface Embedder {
  /** One unit-length vector per text, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Loads the local model, or explains why it can't: the library or the model files are missing.
 * Never throws, so a missing model costs the semantic half of search and nothing else.
 */
export async function loadEmbedder(
  modelsDir: string = MODELS,
): Promise<{ embedder: Embedder } | { embedder: null; reason: string }> {
  try {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.localModelPath = modelsDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    const extract = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
    const embedder: Embedder = {
      async embed(texts) {
        if (!texts.length) return [];
        const out = await extract(texts, { pooling: 'mean', normalize: true });
        return (out.tolist() as number[][]).map((v) => Float32Array.from(v));
      },
    };
    // A first run proves the model works before anything relies on it.
    await embedder.embed(['warm up']);
    return { embedder };
  } catch (error) {
    return {
      embedder: null,
      reason: `${EMBED_MODEL} is not available in ${modelsDir} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}
