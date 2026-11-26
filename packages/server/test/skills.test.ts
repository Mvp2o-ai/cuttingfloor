import { readFile } from 'node:fs/promises';
import { SkillsGetResult, SkillsSearchResult } from '@cuttingfloor/schema';
import { skills } from '@cuttingfloor/skills';
import { beforeAll, describe, expect, it } from 'vitest';
import { watermarkNote } from '../src/gate.ts';
import { QA_SKILL, QA_SKILL_NOTE } from '../src/tools/skills.ts';
import { call, connect, ok, type TestEnv, testRuntime } from './helpers.ts';

// skills.search and skills.get through the SDK client, over the skills in this repo. Search runs
// hybrid where the local model is installed (the image) and on keywords alone elsewhere; both
// must find the obvious skill.

let env: TestEnv;

beforeAll(async () => {
  env = await testRuntime();
});

describe('skills', () => {
  it('points connected agents at the skills', async () => {
    const client = await connect(env.runtime);
    expect(client.getInstructions()).toMatch(/skills\.search/);
  });

  it('answers a search with the skills that fit, or the list of every skill when none does', async () => {
    const client = await connect(env.runtime);
    const got = SkillsSearchResult.parse(
      await ok(client, 'skills.search', { query: 'remove the ums from my video', limit: 20 }),
    );
    // A match comes first; a miss is the whole list. Either way the skill is there.
    if (got.matched) expect(got.skills[0]?.slug).toBe('cut-pauses-ums-and-restarts');
    expect(got.skills.map((s) => s.slug)).toContain('cut-pauses-ums-and-restarts');
    expect(got.skills[0]).not.toHaveProperty('score');
    const miss = SkillsSearchResult.parse(
      await ok(client, 'skills.search', { query: 'what is the weather in Lisbon tomorrow' }),
    );
    expect(miss.matched).toBe(false);
  });

  it('pages the list of every skill, with or without a query', async () => {
    const client = await connect(env.runtime);
    const { library } = await skills();
    const shown = library.skills.filter((s) => !s.hidden).length;
    const first = SkillsSearchResult.parse(await ok(client, 'skills.search', { limit: 1 }));
    expect(first.matched).toBe(false);
    expect(first.total).toBe(shown);
    expect(first.skills).toHaveLength(1);
    expect(first.next_offset).toBe(shown > 1 ? 1 : null);
    const last = SkillsSearchResult.parse(
      await ok(client, 'skills.search', { limit: 1, offset: shown - 1 }),
    );
    expect(last.next_offset).toBeNull();
    const empty = await call(client, 'skills.search', { query: '  ' });
    expect(empty.isError).toBe(true);
  });

  it('reads a whole skill, ready to follow', async () => {
    const client = await connect(env.runtime);
    const got = SkillsGetResult.parse(
      await ok(client, 'skills.get', { slug: 'cut-pauses-ums-and-restarts' }),
    );
    const file = await readFile(
      new URL('../../../skills/cut-pauses-ums-and-restarts.md', import.meta.url),
      'utf8',
    );
    expect(got.markdown).toBe(`${file.trim()}\n`);
    expect(got.markdown).toMatch(/## Steps\n1\. The assistant should/);
    expect(got.version).toBeGreaterThanOrEqual(1);
    expect(got.author).not.toBe('');
    const { library } = await skills();
    for (const r of got.related) {
      expect(library.skills.map((s) => s.slug)).toContain(r.slug);
    }
  });

  it('points results met before delivery at a QA skill that exists', async () => {
    const client = await connect(env.runtime);
    await ok(client, 'skills.get', { slug: QA_SKILL });
    expect(QA_SKILL_NOTE).toContain(QA_SKILL);
    expect(watermarkNote(2, 10)).toContain(QA_SKILL_NOTE);
    expect(watermarkNote(2, 10, true)).toContain(QA_SKILL_NOTE);
  });

  it('answers an unknown slug with where to look', async () => {
    const client = await connect(env.runtime);
    const got = await call(client, 'skills.get', { slug: 'cut-pauses' });
    expect(got.isError).toBe(true);
    expect(got.structured.code).toBe('not_found');
    expect(got.structured.hint).toMatch(/cut-pauses-ums-and-restarts|skills\.search/);
  });

  it('declares output schemas for both tools', async () => {
    const client = await connect(env.runtime);
    const { tools } = await client.listTools();
    for (const name of ['skills.search', 'skills.get']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.outputSchema, name).toBeTruthy();
      expect(tool?.annotations?.readOnlyHint, name).toBe(true);
    }
  });
});
