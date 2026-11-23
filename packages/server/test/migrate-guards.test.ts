import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Records } from '@cuttingfloor/core';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATION, type MigrationMark, markLive } from '../src/live.ts';
import { readLayout } from '../src/migrate/index.ts';

// Two guards of the move to a database and a bucket: what a pass may be told to leave out, and
// whose "a server serves here" mark a server started in standby may clear.

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-guards-'));
  made.push(dir);
  await mkdir(join(dir, 'owners', 'alice', 'media'), { recursive: true });
  await mkdir(join(dir, 'lost+found'));
  await writeFile(join(dir, 'secret.key'), '{}');
  return dir;
}

describe('--ignore', () => {
  it('takes an entry of the data root that nothing knows', async () => {
    const layout = await readLayout(await root(), [], { ignore: ['lost+found'] });
    expect(layout.unknown).toEqual([]);
    expect(layout.leftWhole.map((l) => l.rel)).toContain('lost+found');
    expect(layout.owners).toEqual(['alice']);
  });

  it.each(['owners', 'owners/alice', 'owners/alice/media', 'secret.key', 'cache', 'a/b'])(
    'refuses %s: ignored, it would look gone from the source',
    async (path) => {
      await expect(readLayout(await root(), [], { ignore: [path] })).rejects.toThrow('--ignore');
    },
  );

  it('an account left alone is skipped without being called unknown', async () => {
    const layout = await readLayout(await root(), [], { leaveOwners: ['alice'] });
    expect(layout.owners).toEqual([]);
    expect(layout.unknown.map((u) => u.rel)).toEqual(['lost+found/']);
  });
});

describe('the live mark', () => {
  function records(): { records: Records; marks: Map<string, MigrationMark> } {
    const marks = new Map<string, MigrationMark>();
    const collection = {
      get: async (id: string) => marks.get(id),
      put: async (id: string, value: MigrationMark) => void marks.set(id, value),
      delete: async (id: string) => void marks.delete(id),
    };
    return {
      marks,
      records: {
        collection: (spec: unknown) => (spec === MIGRATION ? collection : undefined),
      } as never,
    };
  }

  it('is cleared only by the node that set it', async () => {
    const { records: store, marks } = records();
    await markLive(store, { standby: false, node: 'serving', filesystem: false });
    expect(marks.get('live')?.node).toBe('serving');
    await markLive(store, { standby: true, node: 'looking', filesystem: false });
    expect(marks.get('live')?.node).toBe('serving');
    await markLive(store, { standby: true, node: 'serving', filesystem: false });
    expect(marks.has('live')).toBe(false);
  });
});
