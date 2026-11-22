import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
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

  it('keeps blob fields on disk as the files’ paths under the data root, and reads either form', async () => {
    const s = await fsStores();
    try {
      const spec = defineCollection<{ file: string | null; note: string }>({
        name: 'media',
        scope: 'owner',
        fs: { dir: 'media', leaf: 'media.json' },
        blobs: ['file'],
      });
      const c = s.records.collection(spec, { owner: 'alice' });
      const key = s.blobs.keys.media('alice', 'm_1', 'source.mp4');
      const path = join(s.root, 'owners', 'alice', 'media', 'm_1', 'source.mp4');
      const onDisk = async () =>
        JSON.parse(
          await readFile(join(s.root, 'owners', 'alice', 'media', 'm_1', 'media.json'), 'utf8'),
        );
      await c.put('m_1', { file: key, note: 'owners/not/a/blob/field' });
      expect(await onDisk()).toEqual({ file: path, note: 'owners/not/a/blob/field' });
      await c.update('m_1', { set: { note: 'again' } });
      expect((await onDisk()).file).toBe(path);
      // A record laid down with a path, as code before blob keys wrote it, reads as the key.
      await writeFile(
        join(s.root, 'owners', 'alice', 'media', 'm_1', 'media.json'),
        JSON.stringify({ file: path, note: 'old' }),
      );
      expect(await c.get('m_1')).toEqual({ file: key, note: 'old' });
      // One that already holds a key (written by an earlier build of this branch) reads the same.
      await writeFile(
        join(s.root, 'owners', 'alice', 'media', 'm_1', 'media.json'),
        JSON.stringify({ file: key, note: 'key' }),
      );
      expect((await c.get('m_1'))?.file).toBe(key);
      await c.put('m_1', { file: '/media/own.mp4', note: 'path import' });
      expect((await onDisk()).file).toBe('/media/own.mp4');
      await c.put('m_1', { file: null, note: 'none' });
      expect((await onDisk()).file).toBeNull();
    } finally {
      await s.close();
    }
  });

  it('a relative data root: same files, paths on disk as they were written from it, both forms read', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cf-relative-'));
    try {
      const given = relative(process.cwd(), join(base, 'data'));
      expect(isAbsolute(given)).toBe(false);
      const ws = new Workspace(given);
      expect(ws.root).toBe(resolve(given));
      const spec = defineCollection<{ file: string | null }>({
        name: 'media',
        scope: 'owner',
        fs: { dir: 'media', leaf: 'media.json' },
        blobs: ['file'],
      });
      const c = ws.records.collection(spec, { owner: 'alice' });
      const key = ws.blobs.keys.media('alice', 'm_1', 'source.mp4');
      await ws.blobs.put(key, { bytes: Buffer.from('bytes') });
      await c.put('m_1', { file: key });
      const record = join(ws.root, 'owners', 'alice', 'media', 'm_1', 'media.json');
      // What the code before blob keys wrote from the same root: join(root, 'owners', …).
      const old = join(given, 'owners', 'alice', 'media', 'm_1', 'source.mp4');
      expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ file: old });
      expect(await c.get('m_1')).toEqual({ file: key });
      expect(await readFile(await ws.scratch.materialize(key), 'utf8')).toBe('bytes');
      expect(await ws.scratch.materialize(key)).toBe(join(ws.root, key));
      // The absolute form, and a key, read the same.
      await writeFile(record, JSON.stringify({ file: join(ws.root, key) }));
      expect((await c.get('m_1'))?.file).toBe(key);
      await writeFile(record, JSON.stringify({ file: key }));
      expect((await c.get('m_1'))?.file).toBe(key);
      expect(ws.scratch.keyOf(old)).toBe(key);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('listings skip stray entries that are not names; only a lookup by such an id is refused', async () => {
    const s = await fsStores();
    try {
      const flat = defineCollection<Thing>({
        name: 'notices',
        scope: 'owner',
        fs: { dir: 'notices' },
      });
      const byDay = defineCollection<Thing>({
        name: 'email_log',
        scope: 'global',
        fs: { dir: (day) => `email-log/${day}` },
      });
      const folders = defineCollection<Thing>({
        name: 'media',
        scope: 'owner',
        fs: { dir: 'media', leaf: 'media.json' },
      });
      const c = s.records.collection(flat, { owner: 'alice' });
      await c.put('a', { name: 'a' });
      await s.records.collection(byDay, { parent: '2026-11-22' }).put('x', { name: 'x' });
      await s.records.collection(folders, { owner: 'alice' }).put('m_1', { name: 'm' });
      const owner = join(s.root, 'owners', 'alice');
      await writeFile(join(s.root, 'owners', '.DS_Store'), 'stray');
      await writeFile(join(owner, 'notices', '.DS_Store'), 'stray');
      await writeFile(join(owner, 'notices', '.hidden.json'), '{"name":"stray"}');
      await writeFile(join(owner, 'notices', 'a.json.123.abc.tmp'), 'stray');
      await writeFile(join(owner, 'media', '.DS_Store'), 'stray');
      await writeFile(join(s.root, 'email-log', '.DS_Store'), 'stray');
      await writeFile(join(s.root, 'email-log', 'stray.txt'), 'stray');
      expect(await s.records.owners()).toEqual(['alice']);
      expect(await c.ids()).toEqual(['a']);
      expect((await c.find()).map((e) => e.id)).toEqual(['a']);
      expect(await s.records.parents(byDay)).toEqual(['2026-11-22']);
      expect(await s.records.collection(folders, { owner: 'alice' }).ids()).toEqual(['m_1']);
      expect((await s.records.collection(folders, { owner: 'alice' }).find()).length).toBe(1);
      // Fresh strays stay through an expiry; nothing throws.
      expect(await c.expire(60_000)).toEqual([]);
      expect(await s.records.collection(folders, { owner: 'alice' }).expire(60_000)).toEqual([]);
      expect(await s.records.expireParents(byDay, {}, 60_000)).toEqual([]);
      await expect(async () => c.get('.hidden')).rejects.toThrow('Not a record id');
    } finally {
      await s.close();
    }
  });

  it('expire tells of each record as it goes, before the next is removed', async () => {
    const s = await fsStores();
    try {
      for (const spec of [
        defineCollection<Thing>({ name: 'timelines', scope: 'owner', fs: { dir: 'timelines' } }),
        defineCollection<Thing>({
          name: 'media',
          scope: 'owner',
          fs: { dir: 'media', leaf: 'media.json' },
        }),
      ]) {
        const c = s.records.collection(spec, { owner: 'alice' });
        for (const id of ['a', 'b', 'c']) {
          await c.put(id, { name: id });
          await s.age.record(spec, { owner: 'alice' }, id, 3_600_000);
        }
        const left: number[] = [];
        const told: string[] = [];
        const gone = await c.expire(60_000, undefined, async (id) => {
          told.push(id);
          left.push((await c.ids()).length);
        });
        expect(told).toEqual(gone);
        expect(left).toEqual([2, 1, 0]);
      }
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
