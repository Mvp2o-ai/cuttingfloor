import {
  CfError,
  type LibrarySound,
  SOUNDS_SEARCH_DEPTH,
  SoundsListInput as SoundsListInputSchema,
  SoundsListResult,
} from '@cuttingfloor/schema';
import type { Collection, Db, Document } from 'mongodb';

// The sound library: sound effects from CC0 and public-domain packs, one MongoDB document each
// (collection `sounds`), their files in a public bucket. scripts/sounds loads packs into it.
//
// A query is searched two ways at once and the two rankings fused (reciprocal rank fusion):
//   words: Atlas Search (BM25) over name, tags, category and description, forgiving one typo;
//   sound: Atlas Vector Search over each sound's CLAP audio embedding, against the query's CLAP
//          text embedding, so "a giant stomping" finds a file tagged only "heavy thud".
// Without a query, or when neither search can run, it lists the library in order.
//
// A server with no library of its own (any server whose records aren't in MongoDB) asks the
// hosted one over HTTP: GET <base>/sounds, the same arguments and result.

export interface SoundLibrary {
  list(args: SoundsListInputSchema, signal: AbortSignal): Promise<SoundsListResult>;
}

/** A sound as the library keeps it. */
export interface SoundDoc {
  /** `<pack>-<the source's id>`. */
  _id: string;
  name: string;
  description: string;
  tags: string[];
  category: string;
  pack: string;
  seconds: number;
  channels: number;
  loudness_lufs: number | null;
  url: string;
  licence: string;
  author: string | null;
  source_url: string | null;
  /** The bucket key of its file. */
  key: string;
  bytes: number;
  /** CLAP audio embedding; compared only with queries embedded by `embedding_model`. */
  embedding: number[];
  embedding_model: string;
  added_at: Date;
}

/** A pack as the library keeps it. */
export interface SoundPackDoc {
  _id: string;
  licence: string;
  source_url: string | null;
  added_at: Date;
}

/** Where the hosted library's files are: a public bucket (CUTTINGFLOOR_SOUNDS_FILES elsewhere). */
export const SOUND_FILES = 'https://cuttingfloor-sounds.fsn1.your-objectstorage.com';

export const SOUNDS = 'sounds';
export const SOUND_PACKS = 'sound_packs';
export const SOUNDS_TEXT_INDEX = 'sounds_text';
export const SOUNDS_VECTOR_INDEX = 'sounds_vector';

/** The two Atlas Search indexes the library needs; `prepareSoundLibrary` makes them. */
export function soundSearchIndexes(dimensions: number) {
  const words = { type: 'string', analyzer: 'lucene.english' };
  return [
    {
      name: SOUNDS_TEXT_INDEX,
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            name: words,
            description: words,
            tags: words,
            category: [words, { type: 'token' }],
            pack: { type: 'token' },
            seconds: { type: 'number' },
          },
        },
      },
    },
    {
      name: SOUNDS_VECTOR_INDEX,
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: dimensions, similarity: 'cosine' },
          { type: 'filter', path: 'category' },
          { type: 'filter', path: 'pack' },
          { type: 'filter', path: 'seconds' },
        ],
      },
    },
  ];
}

/**
 * Makes the collection's indexes where they are missing: the listing's order, and both search
 * indexes. Search indexes build in the background; until they are queryable a search falls back.
 */
export async function prepareSoundLibrary(db: Db, dimensions: number): Promise<void> {
  const sounds = db.collection<SoundDoc>(SOUNDS);
  await sounds.createIndex({ category: 1, name: 1, _id: 1 });
  await sounds.createIndex({ pack: 1, category: 1, name: 1, _id: 1 });
  const have = new Set(
    (await sounds.listSearchIndexes().toArray()).map((i) => (i as { name: string }).name),
  );
  for (const index of soundSearchIndexes(dimensions)) {
    if (!have.has(index.name)) await sounds.createSearchIndex(index);
  }
}

/** Fields a result shows; the embedding stays in the database. */
const SHOWN = { embedding: 0, embedding_model: 0, key: 0, bytes: 0, added_at: 0 } as const;

function shown(doc: Document): LibrarySound {
  const d = doc as SoundDoc;
  return {
    sound_id: d._id,
    name: d.name,
    description: d.description,
    tags: d.tags,
    category: d.category,
    pack: d.pack,
    seconds: d.seconds,
    channels: d.channels,
    loudness_lufs: d.loudness_lufs,
    url: d.url,
    licence: d.licence,
    author: d.author,
    source_url: d.source_url,
  };
}

/** Cosine similarity as Atlas reports it for a cosine index: (1 + cos) / 2. */
function similarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const cos = na && nb ? dot / Math.sqrt(na * nb) : 0;
  return Math.round(((1 + cos) / 2) * 1000) / 1000;
}

/** Reciprocal rank fusion's constant: how much the top few places count over the rest. */
const RRF_K = 60;

/** Fuses rankings of ids, best first; ties go to the earlier id. */
export function fuseRankings(rankings: string[][]): string[] {
  const score = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => id);
}

/** How long the categories and packs are kept before they are counted again. */
const FACETS_TTL_MS = 10 * 60_000;
/** How long which search indexes answer is kept before it is asked again. */
const INDEXES_TTL_MS = 60_000;
/** Query embeddings kept, most recent last. */
const EMBEDDINGS_KEPT = 1000;
/**
 * Query embeddings made at once (each a short process, about a second). Past it a query is
 * searched by words only, so a flood of new queries can't take the server's CPU.
 */
const EMBEDDING_RUNS = 2;

export interface MongoSoundLibraryOptions {
  db: () => Promise<Db>;
  /** CLAP text embeddings of the texts, in the space the sounds were embedded in. */
  embed: (texts: string[], signal: AbortSignal) => Promise<number[][]>;
  /** The model `embed` is; sounds embedded by another are not compared. */
  model: string;
}

export class MongoSoundLibrary implements SoundLibrary {
  readonly #o: MongoSoundLibraryOptions;
  #facets:
    | { at: number; value: Promise<Pick<SoundsListResult, 'categories' | 'packs'>> }
    | undefined;
  readonly #embeddings = new Map<string, number[]>();
  #embedding = 0;
  #indexes: { at: number; value: Promise<Set<string>> } | undefined;

  constructor(options: MongoSoundLibraryOptions) {
    this.#o = options;
  }

  async #sounds(): Promise<Collection<SoundDoc>> {
    return (await this.#o.db()).collection<SoundDoc>(SOUNDS);
  }

  async list(args: SoundsListInputSchema, signal: AbortSignal): Promise<SoundsListResult> {
    const facets = await this.#facetsNow();
    if (args.sound_ids) {
      const docs = await (await this.#sounds())
        .find({ _id: { $in: args.sound_ids } }, { projection: SHOWN })
        .toArray();
      const byId = new Map(docs.map((d) => [d._id, d]));
      const found = args.sound_ids.flatMap((id) => {
        const d = byId.get(id);
        return d ? [shown(d)] : [];
      });
      const missing = args.sound_ids.filter((id) => !byId.has(id));
      return SoundsListResult.parse({
        searched: false,
        ...(missing.length ? { note: `No sound has the id ${missing.join(', ')}` } : {}),
        sounds: found,
        next_offset: null,
        total: found.length,
        ...facets,
      });
    }
    if (args.query) {
      const found = await this.#search(args, args.query, signal);
      if (found) return SoundsListResult.parse({ ...found, ...facets });
    }
    const filter: Document = {};
    if (args.category) filter.category = args.category;
    if (args.pack) filter.pack = args.pack;
    if (args.max_seconds !== undefined || args.min_seconds !== undefined) {
      filter.seconds = {
        ...(args.max_seconds !== undefined ? { $lte: args.max_seconds } : {}),
        ...(args.min_seconds !== undefined ? { $gte: args.min_seconds } : {}),
      };
    }
    const sounds = await this.#sounds();
    const [docs, total] = await Promise.all([
      sounds
        .find(filter, { projection: SHOWN })
        .sort({ category: 1, name: 1, _id: 1 })
        .skip(args.offset)
        .limit(args.limit)
        .toArray(),
      sounds.countDocuments(filter),
    ]);
    const next = args.offset + docs.length;
    return SoundsListResult.parse({
      searched: false,
      ...(args.query
        ? { note: 'The search could not run just now, so this is the library in order' }
        : {}),
      sounds: docs.map(shown),
      next_offset: next < total ? next : null,
      total,
      ...facets,
    });
  }

  /** Both searches fused, or undefined when neither could run. */
  async #search(
    args: SoundsListInputSchema,
    query: string,
    signal: AbortSignal,
  ): Promise<Omit<SoundsListResult, 'categories' | 'packs'> | undefined> {
    const sounds = await this.#sounds();
    // A search index that is missing or still building answers nothing rather than failing,
    // which would read as "no such sound": ask which are ready first.
    const ready = await this.#queryable().catch(() => new Set<string>());
    const vector = ready.has(SOUNDS_VECTOR_INDEX)
      ? await this.#embed(query, signal).catch(() => undefined)
      : undefined;
    const [words, sound] = await Promise.all([
      ready.has(SOUNDS_TEXT_INDEX)
        ? this.#words(sounds, args, query).catch(() => undefined)
        : undefined,
      vector ? this.#sound(sounds, args, vector).catch(() => undefined) : undefined,
    ]);
    if (!words && !sound) return undefined;
    const ranked = fuseRankings([words ?? [], sound ?? []]);
    const page = ranked.slice(args.offset, args.offset + args.limit);
    const docs = page.length
      ? await sounds
          .find({ _id: { $in: page } }, { projection: { key: 0, bytes: 0, added_at: 0 } })
          .toArray()
      : [];
    const byId = new Map(docs.map((d) => [d._id, d]));
    const matched = new Set(words ?? []);
    const next = args.offset + page.length;
    return {
      searched: true,
      ...(!words
        ? { note: 'Ranked by how they sound only: the word search could not run just now' }
        : !sound
          ? { note: 'Ranked by words only: the search by how they sound could not run just now' }
          : {}),
      sounds: page.flatMap((id) => {
        const d = byId.get(id);
        if (!d) return [];
        return [
          {
            ...shown(d),
            ...(vector && d.embedding_model === this.#o.model
              ? { similarity: similarity(vector, d.embedding) }
              : {}),
            keyword_match: matched.has(id),
          },
        ];
      }),
      next_offset: next < Math.min(ranked.length, SOUNDS_SEARCH_DEPTH) ? next : null,
      total: null,
    };
  }

  async #words(sounds: Collection<SoundDoc>, args: SoundsListInputSchema, query: string) {
    const fuzzy = { maxEdits: 1, prefixLength: 2 };
    const filter: Document[] = [];
    if (args.category) filter.push({ equals: { path: 'category', value: args.category } });
    if (args.pack) filter.push({ equals: { path: 'pack', value: args.pack } });
    if (args.max_seconds !== undefined || args.min_seconds !== undefined) {
      filter.push({
        range: {
          path: 'seconds',
          ...(args.max_seconds !== undefined ? { lte: args.max_seconds } : {}),
          ...(args.min_seconds !== undefined ? { gte: args.min_seconds } : {}),
        },
      });
    }
    const docs = await sounds
      .aggregate<{ _id: string }>([
        {
          $search: {
            index: SOUNDS_TEXT_INDEX,
            compound: {
              should: [
                { text: { query, path: 'name', fuzzy, score: { boost: { value: 3 } } } },
                { text: { query, path: 'tags', fuzzy, score: { boost: { value: 2 } } } },
                { text: { query, path: ['category', 'description'], fuzzy } },
              ],
              minimumShouldMatch: 1,
              ...(filter.length ? { filter } : {}),
            },
          },
        },
        { $limit: SOUNDS_SEARCH_DEPTH },
        { $project: { _id: 1 } },
      ])
      .toArray();
    return docs.map((d) => d._id);
  }

  async #sound(sounds: Collection<SoundDoc>, args: SoundsListInputSchema, vector: number[]) {
    const filter: Document = {};
    if (args.category) filter.category = { $eq: args.category };
    if (args.pack) filter.pack = { $eq: args.pack };
    if (args.max_seconds !== undefined || args.min_seconds !== undefined) {
      filter.seconds = {
        ...(args.max_seconds !== undefined ? { $lte: args.max_seconds } : {}),
        ...(args.min_seconds !== undefined ? { $gte: args.min_seconds } : {}),
      };
    }
    const docs = await sounds
      .aggregate<{ _id: string }>([
        {
          $vectorSearch: {
            index: SOUNDS_VECTOR_INDEX,
            path: 'embedding',
            queryVector: vector,
            numCandidates: SOUNDS_SEARCH_DEPTH * 4,
            limit: SOUNDS_SEARCH_DEPTH,
            ...(Object.keys(filter).length ? { filter } : {}),
          },
        },
        { $project: { _id: 1 } },
      ])
      .toArray();
    return docs.map((d) => d._id);
  }

  /** The search indexes that answer queries now, asked again after a minute. */
  #queryable(): Promise<Set<string>> {
    if (!this.#indexes || Date.now() - this.#indexes.at > INDEXES_TTL_MS) {
      const value = this.#sounds().then(async (sounds) => {
        const all = await sounds.listSearchIndexes().toArray();
        return new Set(
          all
            .filter((i) => (i as { queryable?: boolean }).queryable)
            .map((i) => (i as { name: string }).name),
        );
      });
      value.catch(() => {
        if (this.#indexes?.value === value) this.#indexes = undefined;
      });
      this.#indexes = { at: Date.now(), value };
    }
    return this.#indexes.value;
  }

  async #embed(query: string, signal: AbortSignal): Promise<number[]> {
    const kept = this.#embeddings.get(query);
    if (kept) {
      this.#embeddings.delete(query);
      this.#embeddings.set(query, kept);
      return kept;
    }
    if (this.#embedding >= EMBEDDING_RUNS) throw new Error('Busy');
    this.#embedding++;
    const [vector] = await this.#o.embed([query], signal).finally(() => {
      this.#embedding--;
    });
    if (!vector) throw new Error('No embedding');
    this.#embeddings.set(query, vector);
    if (this.#embeddings.size > EMBEDDINGS_KEPT) {
      const oldest = this.#embeddings.keys().next().value;
      if (oldest !== undefined) this.#embeddings.delete(oldest);
    }
    return vector;
  }

  #facetsNow(): Promise<Pick<SoundsListResult, 'categories' | 'packs'>> {
    if (!this.#facets || Date.now() - this.#facets.at > FACETS_TTL_MS) {
      const value = this.#count();
      // A failed count is asked again next time, not kept.
      value.catch(() => {
        if (this.#facets?.value === value) this.#facets = undefined;
      });
      this.#facets = { at: Date.now(), value };
    }
    return this.#facets.value;
  }

  async #count(): Promise<Pick<SoundsListResult, 'categories' | 'packs'>> {
    const db = await this.#o.db();
    const sounds = db.collection<SoundDoc>(SOUNDS);
    const [categories, perPack, packs] = await Promise.all([
      sounds
        .aggregate<{ _id: string; n: number }>([
          { $group: { _id: '$category', n: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      sounds
        .aggregate<{ _id: string; n: number }>([{ $group: { _id: '$pack', n: { $sum: 1 } } }])
        .toArray(),
      db.collection<SoundPackDoc>(SOUND_PACKS).find().sort({ _id: 1 }).toArray(),
    ]);
    const counts = new Map(perPack.map((p) => [p._id, p.n]));
    return {
      categories: categories.map((c) => ({ category: c._id, sounds: c.n })),
      packs: packs
        .filter((p) => counts.get(p._id))
        .map((p) => ({
          pack: p._id,
          sounds: counts.get(p._id) ?? 0,
          licence: p.licence,
          source_url: p.source_url,
        })),
    };
  }
}

/** The query string of GET /sounds for these arguments (a list as one value per item). */
export function soundsQuery(args: Partial<SoundsListInputSchema>): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (Array.isArray(v)) for (const item of v) q.append(k, String(item));
    else if (v !== undefined) q.set(k, String(v));
  }
  return q;
}

/** GET /sounds's query string as sounds.list arguments (still to be checked by the schema). */
export function soundsArgs(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of params) {
    if (k === 'sound_ids') out[k] = [...((out[k] as string[] | undefined) ?? []), v];
    else out[k] = ['limit', 'offset', 'max_seconds', 'min_seconds'].includes(k) ? Number(v) : v;
  }
  return out;
}

/** The hosted library, asked over HTTP by a server with none of its own. */
export class RemoteSoundLibrary implements SoundLibrary {
  readonly #base: string;
  constructor(base: string) {
    this.#base = base.replace(/\/+$/, '');
  }

  async list(args: SoundsListInputSchema, signal: AbortSignal): Promise<SoundsListResult> {
    const url = `${this.#base}/sounds?${soundsQuery(args)}`;
    const failed = (why: string) =>
      new CfError(
        'service_unavailable',
        `The sound library at ${this.#base} did not answer: ${why}`,
        {
          hint: 'It is the hosted one unless CUTTINGFLOOR_SOUNDS names another; try again shortly',
        },
      );
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      throw failed((error as Error).message);
    }
    const body = (await response.json().catch(() => undefined)) as
      | { error?: { code?: string; message?: string; hint?: string } }
      | undefined;
    if (response.status === 400 && body?.error) {
      throw new CfError('bad_request', body.error.message ?? 'Bad request', {
        ...(body.error.hint ? { hint: body.error.hint } : {}),
      });
    }
    if (!response.ok || !body) throw failed(`HTTP ${response.status}`);
    const parsed = SoundsListResult.safeParse(body);
    if (!parsed.success) throw failed('its answer is not a sounds.list result');
    return parsed.data;
  }
}

/**
 * GET /sounds on a server with a library: the query string as sounds.list's arguments, answered
 * as its result, or a refusal in the shape RemoteSoundLibrary reads.
 */
export async function answerSounds(
  library: SoundLibrary,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const args = SoundsListInputSchema.safeParse(soundsArgs(params));
  if (!args.success) {
    return {
      status: 400,
      body: {
        error: {
          code: 'bad_request',
          message: `Bad sounds query: ${args.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        },
      },
    };
  }
  try {
    return { status: 200, body: await library.list(args.data, signal) };
  } catch (error) {
    process.stderr.write(`sounds: ${(error as Error).message}\n`);
    return {
      status: 503,
      body: { error: { code: 'service_unavailable', message: 'The sound library did not answer' } },
    };
  }
}
