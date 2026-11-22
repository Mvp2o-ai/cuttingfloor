import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineCollection, FS_HOME, type FsBlobStore, Workspace } from '../src/index.ts';
import {
  blobStoreContract,
  recordsContract,
  type Stores,
  scratchContract,
} from './storage-contract.ts';

async function fsStores(): Promise<Stores & { root: string }> {
  const base = await mkdtemp(join(tmpdir(), 'cf-stores-'));
  const root = join(base, 'data');
  const work = join(base, 'work');
  await mkdir(work, { recursive: true });
  const ws = new Workspace(root);
  const back = async (path: string, ms: number) => {
    const at = new Date(Date.now() - ms);
    await utimes(path, at, at);
  };
  return {
    root,
    records: ws.records,
    blobs: ws.blobs,
    scratch: ws.scratch,
    work,
    age: {
      record: (spec, scope, id, ms) => {
        const dir =
          typeof spec.fs.dir === 'function' ? spec.fs.dir(scope.parent ?? '') : spec.fs.dir;
        const base = spec.scope === 'global' ? root : join(root, 'owners', scope.owner ?? '');
        return back(
          spec.fs.leaf
            ? join(base, dir, id, spec.fs.leaf)
            : join(base, dir, `${id}${spec.fs.ext ?? '.json'}`),
          ms,
        );
      },
      parent: (spec, scope, parent, ms) =>
        back(
          join(
            root,
            'owners',
            scope.owner ?? '',
            typeof spec.fs.dir === 'function' ? spec.fs.dir(parent) : spec.fs.dir,
          ),
          ms,
        ),
      blob: (key, ms) => back(join(root, key), ms),
    },
    close: () => rm(base, { recursive: true, force: true }),
  };
}

recordsContract('filesystem', fsStores);
blobStoreContract('filesystem', fsStores);
scratchContract('filesystem', fsStores);

// What only the filesystem backend promises: the files are where they always were.
describe('filesystem stores: layout on disk', () => {
  interface Thing {
    name: string;
  }

  it('records are the JSON files existing data roots hold', async () => {
    const s = await fsStores();
    try {
      const flat = defineCollection<Thing>({
        name: 'timelines',
        scope: 'owner',
        fs: { dir: 'timelines' },
      });
      const folder = defineCollection<Thing>({
        name: 'media',
        scope: 'owner',
        fs: { dir: 'media', leaf: 'media.json' },
      });
      const under = defineCollection<Thing>({
        name: 'analyses',
        scope: 'owner',
        fs: { dir: (media) => `media/${media}/analyses` },
      });
      const single = defineCollection<Thing>({ name: 'floor', scope: 'owner', fs: { dir: '' } });
      const marks = defineCollection<Thing>({
        name: 'cancels',
        scope: 'owner',
        fs: { dir: 'jobs', ext: '.cancel' },
      });
      const global = defineCollection<Thing>({
        name: 'keys',
        scope: 'global',
        fs: { dir: 'keys' },
      });
      await s.records.collection(flat, { owner: 'alice' }).put('tl_1', { name: 'a' });
      await s.records.collection(folder, { owner: 'alice' }).put('m_1', { name: 'b' });
      await s.records.collection(under, { owner: 'alice', parent: 'm_1' }).put('beats', {
        name: 'c',
      });
      await s.records.collection(single, { owner: 'alice' }).put('floor', { name: 'd' });
      await s.records.collection(marks, { owner: 'alice' }).insertOnce('j_1', { name: 'e' });
      await s.records.collection(global).put('abc', { name: 'f' });
      const owner = join(s.root, 'owners', 'alice');
      expect(await readFile(join(owner, 'timelines', 'tl_1.json'), 'utf8')).toBe(
        '{\n  "name": "a"\n}\n',
      );
      for (const file of [
        join(owner, 'media', 'm_1', 'media.json'),
        join(owner, 'media', 'm_1', 'analyses', 'beats.json'),
        join(owner, 'floor.json'),
        join(owner, 'jobs', 'j_1.cancel'),
        join(s.root, 'keys', 'abc.json'),
      ]) {
        expect((await stat(file)).isFile()).toBe(true);
      }
      // A record a data root already holds is read as it is.
      await writeFile(join(owner, 'timelines', 'tl_old.json'), '{"name":"old"}');
      expect(await s.records.collection(flat, { owner: 'alice' }).get('tl_old')).toEqual({
        name: 'old',
      });
      // A single record among an owner's other things expires alone.
      const at = new Date(Date.now() - 3_600_000);
      await utimes(join(owner, 'floor.json'), at, at);
      await utimes(join(owner, 'timelines'), at, at);
      expect(await s.records.collection(single, { owner: 'alice' }).expire(60_000)).toEqual([
        'floor',
      ]);
      expect((await stat(join(owner, 'timelines'))).isDirectory()).toBe(true);
      expect(await s.records.home('alice')).toBe(FS_HOME);
    } finally {
      await s.close();
    }
  });

  it('a folder record takes its folder with it when it expires, and so does one with no record', async () => {
    const s = await fsStores();
    try {
      const folder = defineCollection<Thing>({
        name: 'media',
        scope: 'owner',
        fs: { dir: 'media', leaf: 'media.json' },
      });
      const c = s.records.collection(folder, { owner: 'alice' });
      await c.put('m_old', { name: 'old' });
      const dir = join(s.root, 'owners', 'alice', 'media');
      await writeFile(join(dir, 'm_old', 'source.bin'), 'bytes');
      await mkdir(join(dir, 'm_orphan'));
      const at = new Date(Date.now() - 3_600_000);
      await utimes(join(dir, 'm_old', 'media.json'), at, at);
      expect(await c.expire(60_000)).toEqual(['m_old']);
      expect(await c.ids()).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it('blobs are files under the data root, shared by hard link', async () => {
    const s = await fsStores();
    try {
      const a = s.blobs.keys.media('alice', 'm_1', 'source.mp4');
      expect(a).toBe('owners/alice/media/m_1/source.mp4');
      expect(s.blobs.keys.derived('alice', 'm_1', 'search', 'index.bin')).toBe(
        'owners/alice/media/m_1/search/index.bin',
      );
      expect(s.blobs.keys.output('alice', 'j_1', 'out.mp4')).toBe(
        'owners/alice/outputs/j_1/out.mp4',
      );
      expect(s.blobs.keys.upload('alice', 'u_1', 'data.mp4')).toBe(
        'owners/alice/uploads/u_1/data.mp4',
      );
      expect(s.blobs.keys.cache('frames', 'x.png')).toBe('cache/frames/x.png');
      await s.blobs.put(a, { bytes: Buffer.from('bytes') });
      const file = join(s.root, 'owners', 'alice', 'media', 'm_1', 'source.mp4');
      expect(await s.scratch.materialize(a)).toBe(file);
      expect(await s.scratch.reserve(a)).toBe(file);
      expect(s.scratch.keyOf(file)).toBe(a);
      expect(s.scratch.keyOf('/somewhere/else.mp4')).toBeUndefined();
      const b = await s.blobs.share(a, s.blobs.keys.media('alice', 'm_2', 'source.mp4'));
      expect((await stat(join(s.root, b))).ino).toBe((await stat(file)).ino);
      expect(() => (s.blobs as FsBlobStore).file('../outside')).toThrow();
      expect(() => (s.blobs as FsBlobStore).file('/etc/passwd')).toThrow();
    } finally {
      await s.close();
    }
  });

  it('presignGet uses the signer the server gives it', async () => {
    const ws = new Workspace('/nowhere', {
      presign: async (key, { ttlMs }) => `https://example.test/${key}?ttl=${ttlMs}`,
    });
    expect(await ws.blobs.presignGet('owners/a/outputs/j_1/x.mp4', { ttlMs: 5 })).toBe(
      'https://example.test/owners/a/outputs/j_1/x.mp4?ttl=5',
    );
    expect(await new Workspace('/nowhere').blobs.presignGet('k', { ttlMs: 5 })).toBeUndefined();
  });
});
