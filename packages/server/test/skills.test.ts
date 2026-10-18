import { readFile } from 'node:fs/promises';
import { SkillsGetResult, SkillsSearchResult } from '@cuttingfloor/schema';
import { skills } from '@cuttingfloor/skills';
import { beforeAll, describe, expect, it } from 'vitest';
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

  it('finds the skill for what a creator types, best first', async () => {
    const client = await connect(env.runtime);
    const got = SkillsSearchResult.parse(
      await ok(client, 'skills.search', { query: 'remove the ums from my video' }),
    );
    expect(got.skills[0]?.slug).toBe('cut-pauses-ums-and-restarts');
    expect(got.skills[0]?.score).toBeGreaterThan(0);
    expect(got.skills[0]?.description).toMatch(/talking video/);
    const scores = got.skills.map((s) => s.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('keeps to the limit, and refuses an empty query', async () => {
    const client = await connect(env.runtime);
    const one = SkillsSearchResult.parse(
      await ok(client, 'skills.search', { query: 'cut the pauses', limit: 1 }),
    );
    expect(one.skills.length).toBeLessThanOrEqual(1);
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
    const { library } = await skills();
    for (const r of got.related) {
      expect(library.skills.map((s) => s.slug)).toContain(r.slug);
    }
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
