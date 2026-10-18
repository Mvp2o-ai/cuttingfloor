import { CfError } from '@cuttingfloor/schema';
import { bm25Score, termFrequencies, tokenize } from './bm25.ts';
import type { Embedder } from './embed.ts';
import type { Skill } from './library.ts';
import { contractText, type StoredVector, textHash } from './vectors.ts';

// Hybrid search over skills, as one-mcp searches playbooks (mcp-platform/src/playbooks/
// hybrid-search.ts there): cosine similarity of sentence embeddings, fused with BM25.
//
// Both signals score a skill's contract (name + description: when to use it), never the body.
// Steps are long prose whose common words saturate BM25 and dilute the embedding; in one-mcp
// that once matched a restaurant question to calendar playbooks (MVP-72).

const SEMANTIC_WEIGHT = 0.6;
const BM25_WEIGHT = 0.4;
/** BM25 at or above this counts as a full keyword match. */
const BM25_SATURATION = 10;
/**
 * Lowest fused score returned (one-mcp's list floor): the caller reads name and description
 * before acting, so recall wins. Keywords alone (no model) return any skill with a match.
 * Checked against all-MiniLM-L6-v2: asks for a skill in other words score 0.27 to 0.39 (cosine
 * 0.40 to 0.60), generic video asks 0.15 to 0.23, off-topic ones below 0.1.
 */
const HYBRID_FLOOR = 0.25;

export interface SkillMatch {
  slug: string;
  name: string;
  description: string;
  score: number;
  /** Cosine of the query and the contract; null without the model. */
  semantic: number | null;
  /** BM25 of the query against the contract, 0 to 1. */
  keyword: number;
}

interface Entry {
  skill: Skill;
  vector: Float32Array | null;
  terms: Map<string, number>;
  length: number;
}

const words = (slug: string) => slug.replace(/-/g, ' ');

/** The same, for keywords, with the slug kept whole so a slug query matches exactly. */
const lexicalText = (s: Pick<Skill, 'slug' | 'name' | 'description'>) =>
  `${s.name} ${words(s.name)} ${words(s.slug)}\n${s.description}`;

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** The skills, indexed in memory. Built once: the library ships in the image and never changes. */
export class SkillIndex {
  readonly #entries: Entry[];
  readonly #embedder: Embedder | null;
  readonly #avgLength: number;
  readonly #df = new Map<string, number>();

  private constructor(entries: Entry[], embedder: Embedder | null) {
    this.#entries = entries;
    this.#embedder = embedder;
    this.#avgLength = entries.reduce((sum, e) => sum + e.length, 0) / (entries.length || 1);
    for (const e of entries)
      for (const t of e.terms.keys()) this.#df.set(t, (this.#df.get(t) ?? 0) + 1);
  }

  /**
   * Indexes the skills that are not hidden. A stored vector is used when its hash matches the
   * skill's text now; the rest are embedded here. Without an embedder, search is keywords only.
   */
  static async build(
    skills: Skill[],
    embedder: Embedder | null,
    stored: ReadonlyMap<string, StoredVector> = new Map(),
  ): Promise<SkillIndex> {
    const shown = skills.filter((s) => !s.hidden);
    let vectors: Float32Array[] | null = null;
    let computed = 0;
    if (embedder) {
      const texts = shown.map(contractText);
      const kept = shown.map((s, i) => {
        const hit = stored.get(s.slug);
        return hit && hit.hash === textHash(texts[i] as string) ? hit.vector : null;
      });
      const missing = kept.flatMap((v, i) => (v ? [] : [i]));
      try {
        const fresh = missing.length
          ? await embedder.embed(missing.map((i) => texts[i] as string))
          : [];
        for (const [j, i] of missing.entries()) kept[i] = fresh[j] ?? null;
        computed = missing.length;
        vectors = kept.every((v) => v) ? (kept as Float32Array[]) : null;
      } catch {
        vectors = null;
      }
    }
    const entries = shown.map((skill, i) => {
      const terms = termFrequencies(tokenize(lexicalText(skill)));
      let length = 0;
      for (const f of terms.values()) length += f;
      return { skill, vector: vectors?.[i] ?? null, terms, length };
    });
    const index = new SkillIndex(entries, vectors ? embedder : null);
    index.vectors = vectors
      ? { stored: shown.length - computed, computed }
      : { stored: 0, computed: 0 };
    return index;
  }

  /** Where the skills' vectors came from: the stored file, or embedded when the index was built. */
  vectors: { stored: number; computed: number } = { stored: 0, computed: 0 };

  /** Whether the semantic half is on. */
  get semantic(): boolean {
    return this.#embedder !== null;
  }

  /** Best first, at most `limit`; empty when nothing fits. */
  async search(query: string, limit = 5): Promise<SkillMatch[]> {
    const q = query.trim();
    if (!q || !this.#entries.length) return [];
    // Hyphens split, so "talking-head" in a query matches "talking head" in a contract.
    const terms = termFrequencies(tokenize(q.replace(/-/g, ' ')));
    let vector: Float32Array | null = null;
    if (this.#embedder) {
      try {
        [vector = null] = await this.#embedder.embed([q]);
      } catch {
        vector = null;
      }
    }
    const n = this.#entries.length;
    return this.#entries
      .map((e): SkillMatch => {
        const bm25 = bm25Score(terms, e.terms, e.length, this.#avgLength, n, this.#df);
        const keyword = Math.min(bm25 / BM25_SATURATION, 1);
        const semantic = vector && e.vector ? cosine(vector, e.vector) : null;
        const score =
          semantic === null ? keyword : SEMANTIC_WEIGHT * semantic + BM25_WEIGHT * keyword;
        return {
          slug: e.skill.slug,
          name: e.skill.name,
          description: e.skill.description,
          score,
          semantic,
          keyword,
        };
      })
      .filter((m) => (m.semantic === null ? m.keyword > 0 : m.score >= HYBRID_FLOOR))
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
      .slice(0, limit);
  }
}

/** A skill by slug, hidden ones included; an unknown slug says where to look. */
export function findSkill(skills: Skill[], slug: string): Skill {
  const skill = skills.find((s) => s.slug === slug);
  if (skill) return skill;
  const near = skills
    .filter((s) => !s.hidden)
    .map((s) => s.slug)
    .filter((s) => s.includes(slug) || slug.includes(s) || s.split('-')[0] === slug.split('-')[0]);
  throw new CfError('not_found', `No skill "${slug}"`, {
    detail: { slug },
    hint: near.length
      ? `Did you mean ${near.map((s) => `"${s}"`).join(', ')}? Or skills.search {query} in the user's words`
      : 'Find one with skills.search {query: "<what the user wants, in their words>"}',
  });
}
