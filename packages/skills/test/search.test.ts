import { CfError } from '@cuttingfloor/schema';
import {
  bm25Score,
  type Embedder,
  findSkill,
  loadEmbedder,
  loadLibrary,
  parseSkill,
  type Skill,
  SkillIndex,
  termFrequencies,
  tokenize,
} from '@cuttingfloor/skills';
import { describe, expect, it } from 'vitest';

// Hybrid search: BM25 plus cosine over name + description, never the body. A stand-in embedder
// maps words to a few meanings, so the semantic half is checked without the model; the model
// itself is checked where it is installed (the image).

const make = (name: string, description: string, extra = '', hidden = false): Skill =>
  parseSkill(
    `---
name: ${name}
description: ${description}
version: 1
type: playbook
source: system${hidden ? '\nhidden: true' : ''}
---

# ${name}

## When to use
- ${extra}

## Prerequisites
- The cuttingfloor MCP server is connected.

## Steps
1. The assistant should do it. ${extra}

## Decision table
| Situation | Do |
|---|---|
| Any | Do it |

## Required behavior
- Say what changed.
`,
    name,
  );

const SKILLS = [
  make(
    'cut-pauses-ums-and-restarts',
    'Cut the long pauses, the ums and the restarts from a talking video. Use to remove dead air or filler words.',
  ),
  make(
    'reframe-to-vertical',
    'Turn a wide video into a 9:16 one for Shorts, Reels and TikTok, keeping the speaker in frame.',
  ),
  make(
    'add-captions',
    'Put words on screen as the speaker says them. Use when someone asks for captions or subtitles.',
    // The body talks about pauses and ums a lot; search must not see it.
    'pauses ums ums ums pauses restarts filler dead air pauses ums',
  ),
  make('secret-skill', 'Cut the ums, but hidden.', '', true),
];

/** Words to one of three meanings, so "tidy" and "filler" land together; others count for none. */
const MEANINGS: Record<string, number> = {
  ums: 0,
  um: 0,
  filler: 0,
  pauses: 0,
  tidy: 0,
  tighten: 0,
  vertical: 1,
  portrait: 1,
  shorts: 1,
  tiktok: 1,
  captions: 2,
  subtitles: 2,
  words: 2,
};
const standIn: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(3);
      for (const w of tokenize(t)) {
        const m = MEANINGS[w];
        if (m !== undefined) v[m] = (v[m] as number) + 1;
      }
      return v;
    });
  },
};

describe('BM25', () => {
  it('scores a document with the query terms above one without them', () => {
    const docs = ['remove the ums', 'add captions to a video'].map((d) =>
      termFrequencies(tokenize(d)),
    );
    const df = new Map<string, number>();
    for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const q = termFrequencies(tokenize('ums'));
    const [a, b] = docs.map((d) => bm25Score(q, d, [...d.values()].length, 3.5, 2, df));
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(0);
  });

  it('tokenizes to lowercase words, keeping hyphenated ones whole', () => {
    expect(tokenize("Cut the UM's, a talking-head!")).toEqual(['cut', 'the', 'um', 'talking-head']);
  });
});

describe('skill search', () => {
  it('finds a skill by its words with keywords only', async () => {
    const index = await SkillIndex.build(SKILLS, null);
    expect(index.semantic).toBe(false);
    const [first] = await index.search('remove the ums from my video');
    expect(first?.slug).toBe('cut-pauses-ums-and-restarts');
    expect(first?.semantic).toBeNull();
  });

  it('scores name and description, never the body', async () => {
    const index = await SkillIndex.build(SKILLS, null);
    const found = await index.search('ums pauses filler');
    expect(found.map((m) => m.slug)).not.toContain('add-captions');
  });

  it('finds by meaning when no word matches', async () => {
    const keywords = await SkillIndex.build(SKILLS, null);
    expect(await keywords.search('portrait')).toEqual([]);
    const hybrid = await SkillIndex.build(SKILLS, standIn);
    expect(hybrid.semantic).toBe(true);
    const [first] = await hybrid.search('make it portrait');
    expect(first?.slug).toBe('reframe-to-vertical');
    expect(first?.semantic).toBeGreaterThan(0);
  });

  it('fuses both, best first, within the limit', async () => {
    const index = await SkillIndex.build(SKILLS, standIn);
    const found = await index.search('subtitles for my video', 1);
    expect(found).toHaveLength(1);
    expect(found[0]?.slug).toBe('add-captions');
    expect(found[0]?.score).toBeGreaterThan(0);
    expect(found[0]?.score).toBeLessThanOrEqual(1);
  });

  it('leaves hidden skills out of search', async () => {
    const index = await SkillIndex.build(SKILLS, standIn);
    const found = await index.search('secret skill hidden ums', 20);
    expect(found.map((m) => m.slug)).not.toContain('secret-skill');
  });

  it('falls back to keywords when the embedder fails', async () => {
    const broken: Embedder = {
      embed: async () => {
        throw new Error('no model');
      },
    };
    const index = await SkillIndex.build(SKILLS, broken);
    expect(index.semantic).toBe(false);
    const [first] = await index.search('remove the ums');
    expect(first?.slug).toBe('cut-pauses-ums-and-restarts');
  });

  it('returns nothing for an empty query', async () => {
    const index = await SkillIndex.build(SKILLS, standIn);
    expect(await index.search('   ')).toEqual([]);
  });
});

describe('a skill by slug', () => {
  it('finds hidden ones too, and points an unknown slug at search', () => {
    expect(findSkill(SKILLS, 'secret-skill').slug).toBe('secret-skill');
    try {
      findSkill(SKILLS, 'add-caption');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CfError);
      expect((error as CfError).code).toBe('not_found');
      expect((error as CfError).hint).toMatch(/"add-captions"/);
    }
    expect(() => findSkill(SKILLS, 'zzz')).toThrow(/No skill "zzz"/);
  });
});

const loaded = await loadEmbedder();
const required = process.env.CUTTINGFLOOR_REQUIRE_ENGINES === '1';

describe('the local model', () => {
  it('is in the image', () => {
    if (required) expect(loaded.embedder, 'reason' in loaded ? loaded.reason : '').not.toBeNull();
  });

  it.skipIf(!loaded.embedder)(
    'finds the right skill in this repo for what a creator types',
    async () => {
      const index = await SkillIndex.build(loadLibrary().skills, loaded.embedder);
      expect(index.semantic).toBe(true);
      const [first] = await index.search('remove the ums from my video');
      expect(first?.slug).toBe('cut-pauses-ums-and-restarts');
      expect(first?.semantic).toBeGreaterThan(0.3);
      // Off-topic asks find nothing rather than the least-wrong skill.
      expect(await index.search('what is the weather in Lisbon tomorrow')).toEqual([]);
    },
    60_000,
  );
});
