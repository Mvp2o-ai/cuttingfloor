// BM25, as one-mcp scores playbooks (packages/shared/src/playbooks/lexical-bm25.ts there).

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** Lowercase words of two or more characters; hyphenated words stay whole. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** One document's score for a query, given the collection's size, mean length and term counts. */
export function bm25Score(
  queryTerms: Map<string, number>,
  docTerms: Map<string, number>,
  docLen: number,
  avgDl: number,
  n: number,
  df: Map<string, number>,
): number {
  let score = 0;
  for (const [term] of queryTerms) {
    const f = docTerms.get(term) ?? 0;
    if (f === 0) continue;
    const d = df.get(term) ?? 0;
    const idf = Math.log((n - d + 0.5) / (d + 0.5) + 1);
    score += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDl)));
  }
  return score;
}
