import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, connect, ok, SEQ_720P25, type TestEnv, testRuntime } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await testRuntime();
});

afterAll(() => env.runtime.stop());

async function lines(owner: string, count: number): Promise<Record<string, unknown>[]> {
  const dir = join(env.dir, 'data', 'owners', owner, 'calls');
  const until = Date.now() + 5000;
  for (;;) {
    const files = await readdir(dir).catch(() => []);
    const all = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).flatMap(
      (text) =>
        text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
    );
    if (all.length >= count || Date.now() > until) return all;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('call log', () => {
  it("keeps each call's tool and outcome in the owner's day file, never its arguments", async () => {
    const client = await connect(env.runtime, 'caller');
    await ok(client, 'timeline.create', { name: 'Private name', sequence: SEQ_720P25 });
    await call(client, 'timeline.get', { timeline_id: `tl_${'0'.repeat(32)}` });
    await call(client, 'timeline.create', { name: 'No sequence' });
    await client.callTool({ name: 'no.such_tool', arguments: {} }).catch(() => undefined);

    const log = await lines('caller', 4);
    const files = await readdir(join(env.dir, 'data', 'owners', 'caller', 'calls'));
    expect(files).toEqual([`${new Date().toISOString().slice(0, 10)}.local.jsonl`]);
    expect(log.map((l) => [l.tool, l.ok])).toEqual([
      ['timeline.create', true],
      ['timeline.get', false],
      ['timeline.create', false],
      ['no.such_tool', false],
    ]);
    expect(log[1]?.error).toMatchObject({ code: 'not_found' });
    expect(log[2]?.error).toMatchObject({ message: expect.stringMatching(/sequence/) });
    expect(typeof log[0]?.ms).toBe('number');
    expect(JSON.stringify(log)).not.toMatch(/Private name|No sequence/);
  });

  it("is not counted as the owner's storage", async () => {
    const client = await connect(env.runtime, 'counted');
    const used = async () =>
      (await ok<{ storage: { used_bytes: number } }>(client, 'media.list', {})).storage.used_bytes;
    const before = await used();
    await call(client, 'timeline.create', { name: 'No sequence' });
    await lines('counted', 2);
    expect(await used()).toBe(before);
  });
});
