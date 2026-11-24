import { createServer as createPlainServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  answerSounds,
  MongoSoundLibrary,
  prepareSoundLibrary,
  SOUND_PACKS,
  SOUNDS,
  type SoundDoc,
  type SoundLibrary,
  type SoundPackDoc,
} from '../src/index.ts';
import { call, connect, ok, testRuntime } from './helpers.ts';

// sounds.list as a server with no library of its own uses it: the tool asks a library server
// over HTTP (GET /sounds), which answers from MongoDB with Atlas Search and Vector Search. The
// database is MongoDB's Atlas image (scripts/test-mongo.sh atlas, or CUTTINGFLOOR_TEST_ATLAS_URI);
// the suite skips without one unless CUTTINGFLOOR_REQUIRE_ATLAS is set. CLAP is stood in for by
// a tiny embedding of "what a sound is": each sound's hidden kind, and the kind a query's words
// name, so a search by how something sounds can be told from one by its words.

const ATLAS_URI =
  process.env.CUTTINGFLOOR_TEST_ATLAS_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';

const KINDS = ['steps', 'rain', 'stomp', 'roar', 'whoosh', 'crowd'] as const;
type Kind = (typeof KINDS)[number];
const WORDS: Record<string, Kind> = {
  footsteps: 'steps',
  walking: 'steps',
  rain: 'rain',
  storm: 'rain',
  giant: 'stomp',
  stomping: 'stomp',
  roar: 'roar',
  monster: 'roar',
  whoosh: 'whoosh',
  cheering: 'crowd',
};
const vec = (kind: Kind | undefined) => KINDS.map((k) => (k === kind ? 1 : 0.05));
let embedded = 0;
const embed = async (texts: string[]) =>
  texts.map((t) => {
    embedded++;
    return vec(
      t
        .toLowerCase()
        .split(/\W+/)
        .map((w) => WORDS[w])
        .find(Boolean),
    );
  });

const sound = (id: string, name: string, kind: Kind, more: Partial<SoundDoc> = {}): SoundDoc => ({
  _id: id,
  name,
  description: '',
  tags: [],
  category: 'Foley',
  pack: 'test-pack',
  seconds: 2,
  channels: 1,
  loudness_lufs: -20,
  peak_dbtp: -3,
  url: `https://sounds.example/${id}.flac`,
  licence: 'CC0',
  author: null,
  source_url: null,
  key: `sounds/${id}.flac`,
  bytes: 1000,
  embedding: vec(kind),
  embedding_model: 'stand-in',
  added_at: new Date(),
  ...more,
});

const LIBRARY: SoundDoc[] = [
  sound('t-1', 'Footsteps on gravel', 'steps', { tags: ['walk', 'footsteps', 'gravel'] }),
  sound('t-2', 'Footsteps, wood floor', 'steps', { tags: ['footsteps', 'indoor'] }),
  // Tagged only by what it is, not by "giant": found by how it sounds.
  sound('t-3', 'Heavy thud', 'stomp', { tags: ['impact', 'low'], category: 'Impacts' }),
  sound('t-4', 'Rain on a window', 'rain', {
    tags: ['rain', 'glass'],
    category: 'Weather',
    seconds: 30,
  }),
  sound('t-5', 'Lion growl', 'roar', { tags: ['animal'], category: 'Animals' }),
  sound('t-6', 'Fast whoosh', 'whoosh', { tags: ['transition'], category: 'Whooshes' }),
  sound('t-7', 'Stadium crowd', 'crowd', { tags: ['crowd', 'cheer'], category: 'Crowds' }),
];

async function reachable(): Promise<MongoClient | undefined> {
  const client = new MongoClient(ATLAS_URI, { serverSelectionTimeoutMS: 1500 });
  try {
    await client.connect();
    // Atlas Search answers only on the Atlas image (or Atlas).
    await client.db('cf_probe').collection('p').listSearchIndexes().toArray();
    return client;
  } catch {
    await client.close().catch(() => undefined);
    if (process.env.CUTTINGFLOOR_REQUIRE_ATLAS) {
      throw new Error(
        'CUTTINGFLOOR_REQUIRE_ATLAS is set but no Atlas Search answers (scripts/test-mongo.sh atlas starts one)',
      );
    }
    process.stderr.write(
      'No MongoDB with Atlas Search answers, so the sound library suite is skipped: scripts/test-mongo.sh atlas starts one\n',
    );
    return undefined;
  }
}

/** Waits until both search indexes answer queries. */
async function searchable(db: Db): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const indexes = await db.collection(SOUNDS).listSearchIndexes().toArray();
    if (indexes.length === 2 && indexes.every((x) => (x as { queryable?: boolean }).queryable))
      return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('search indexes never became queryable');
}

function serve(library: SoundLibrary): Promise<{ server: Server; url: string }> {
  const server = createPlainServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { status, body } = await answerSounds(
      library,
      url.searchParams,
      new AbortController().signal,
    );
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

const client = await reachable();
const dbName = `cf_sounds_${Date.now().toString(36)}`;

describe.skipIf(!client)('sounds.list', { timeout: 120_000 }, () => {
  let db: Db;
  let bare: Db;
  let site: { server: Server; url: string };
  let unindexed: { server: Server; url: string };

  beforeAll(async () => {
    db = (client as MongoClient).db(dbName);
    await db.collection<SoundDoc>(SOUNDS).insertMany(LIBRARY);
    await db.collection<SoundPackDoc>(SOUND_PACKS).insertOne({
      _id: 'test-pack',
      licence: 'CC0',
      source_url: 'https://pack.example',
      added_at: new Date(),
    });
    await prepareSoundLibrary(db, KINDS.length);
    await searchable(db);
    site = await serve(new MongoSoundLibrary({ db: async () => db, embed, model: 'stand-in' }));
    // A library whose search indexes don't exist: every query falls back to the listing.
    bare = (client as MongoClient).db(`${dbName}_bare`);
    await bare.collection<SoundDoc>(SOUNDS).insertMany(LIBRARY);
    unindexed = await serve(
      new MongoSoundLibrary({ db: async () => bare, embed, model: 'stand-in' }),
    );
  }, 120_000);

  afterAll(async () => {
    site?.server.close();
    unindexed?.server.close();
    await db?.dropDatabase();
    await bare?.dropDatabase();
    await client?.close();
  });

  const tool = async (url: string) => connect((await testRuntime({ sounds: url })).runtime);

  it('lists the library in order, by page, with its categories and packs', async () => {
    const c = await tool(site.url);
    const first = await ok<{
      searched: boolean;
      sounds: Array<{ name: string; url: string }>;
      next_offset: number | null;
      total: number;
      categories: Array<{ category: string; sounds: number }>;
      packs: Array<{ pack: string; sounds: number }>;
    }>(c, 'sounds.list', { limit: 3 });
    expect(first.searched).toBe(false);
    expect(first.total).toBe(7);
    expect(first.sounds.map((s) => s.name)).toEqual([
      'Lion growl',
      'Stadium crowd',
      'Footsteps on gravel',
    ]);
    expect(first.next_offset).toBe(3);
    expect(first.categories).toContainEqual({ category: 'Foley', sounds: 2 });
    expect(first.packs).toEqual([
      { pack: 'test-pack', sounds: 7, licence: 'CC0', source_url: 'https://pack.example' },
    ]);
    const last = await ok<{ sounds: unknown[]; next_offset: number | null }>(c, 'sounds.list', {
      limit: 3,
      offset: 6,
    });
    expect(last.sounds).toHaveLength(1);
    expect(last.next_offset).toBeNull();
    const weather = await ok<{ sounds: Array<{ name: string }>; total: number }>(c, 'sounds.list', {
      category: 'Weather',
    });
    expect(weather.sounds.map((s) => s.name)).toEqual(['Rain on a window']);
    expect(weather.total).toBe(1);
  });

  it('finds a sound by its words, forgiving a typo', async () => {
    const c = await tool(site.url);
    const r = await ok<{
      searched: boolean;
      sounds: Array<{ name: string; keyword_match: boolean; similarity: number }>;
    }>(c, 'sounds.list', { query: 'footstep', limit: 2 });
    expect(r.searched).toBe(true);
    expect(r.sounds.map((s) => s.name).sort()).toEqual([
      'Footsteps on gravel',
      'Footsteps, wood floor',
    ]);
    expect(r.sounds.every((s) => s.keyword_match)).toBe(true);
  });

  it('finds a sound by how it sounds when no word matches', async () => {
    const c = await tool(site.url);
    const r = await ok<{
      sounds: Array<{ name: string; keyword_match: boolean; similarity: number }>;
    }>(c, 'sounds.list', { query: 'a giant stomping', limit: 3 });
    expect(r.sounds[0]?.name).toBe('Heavy thud');
    expect(r.sounds[0]?.keyword_match).toBe(false);
    expect(r.sounds[0]?.similarity).toBeGreaterThan(0.9);
    expect(r.sounds[1]?.similarity).toBeLessThan(r.sounds[0]?.similarity ?? 0);
  });

  it('ranks a sound both searches agree on first, and pages the ranking', async () => {
    const c = await tool(site.url);
    const page1 = await ok<{ sounds: Array<{ sound_id: string }>; next_offset: number | null }>(
      c,
      'sounds.list',
      { query: 'rain storm', limit: 1 },
    );
    expect(page1.sounds[0]?.sound_id).toBe('t-4');
    expect(page1.next_offset).toBe(1);
    const page2 = await ok<{ sounds: Array<{ sound_id: string }> }>(c, 'sounds.list', {
      query: 'rain storm',
      limit: 1,
      offset: 1,
    });
    expect(page2.sounds[0]?.sound_id).not.toBe('t-4');
  });

  it('keeps to the filters while searching', async () => {
    const c = await tool(site.url);
    const r = await ok<{ sounds: Array<{ name: string }> }>(c, 'sounds.list', {
      query: 'footsteps',
      max_seconds: 10,
      category: 'Weather',
    });
    expect(r.sounds).toEqual([]);
    const long = await ok<{ sounds: Array<{ name: string }> }>(c, 'sounds.list', {
      query: 'rain',
      min_seconds: 10,
    });
    expect(long.sounds.map((s) => s.name)).toEqual(['Rain on a window']);
  });

  it('embeds a query once', async () => {
    const c = await tool(site.url);
    await ok(c, 'sounds.list', { query: 'monster roar' });
    const before = embedded;
    await ok(c, 'sounds.list', { query: 'monster roar', offset: 1 });
    expect(embedded).toBe(before);
  });

  it('lists particular sounds by id, in the order asked, naming any it does not have', async () => {
    const c = await tool(site.url);
    const r = await ok<{ sounds: Array<{ sound_id: string }>; note: string; total: number }>(
      c,
      'sounds.list',
      { sound_ids: ['t-5', 'nope', 't-1'] },
    );
    expect(r.sounds.map((s) => s.sound_id)).toEqual(['t-5', 't-1']);
    expect(r.total).toBe(2);
    expect(r.note).toMatch(/nope/);
  });

  it('shows its results in the sound library view', async () => {
    const c = await tool(site.url);
    const { tools } = await c.listTools();
    const uri = (
      tools.find((t) => t.name === 'sounds.list')?._meta as { ui?: { resourceUri?: string } }
    )?.ui?.resourceUri;
    expect(uri).toBe('ui://cuttingfloor/sounds');
    const page = await c.readResource({ uri: uri as string });
    expect(String((page.contents[0] as { text?: string }).text)).toContain('sounds.list');
  });

  it('lists the library, and says so, when the search cannot run', async () => {
    const c = await tool(unindexed.url);
    const r = await ok<{ searched: boolean; note: string; sounds: unknown[]; total: number }>(
      c,
      'sounds.list',
      { query: 'footsteps' },
    );
    expect(r.searched).toBe(false);
    expect(r.note).toMatch(/could not run/);
    expect(r.total).toBe(7);
    expect(r.sounds).toHaveLength(7);
  });

  it('refuses a library that does not answer, naming it', async () => {
    const c = await tool('http://127.0.0.1:9');
    const r = await call(c, 'sounds.list', {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.structured)).toMatch(/sound library at http:\/\/127\.0\.0\.1:9/);
  });
});
