import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestEnv, testRuntime } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await testRuntime();
});

afterAll(async () => {
  env.runtime.stop();
  await rm(env.dir, { recursive: true, force: true });
});

describe('the runtime on the filesystem stores', () => {
  it('names an output by its record, and by its only file when it has none', async () => {
    const { outputs, ws } = env.runtime;
    const id = 'j_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(await outputs.file('local', id)).toBeUndefined();
    // An output made before outputs had records: just the file.
    await ws.blobs.put(outputs.key('local', id, 'old.mp4'), { bytes: Buffer.from('old') });
    expect(await outputs.file('local', id)).toBe('old.mp4');
    await outputs.write('local', id, 'new.txt', 'new', 'transcript');
    expect(await outputs.file('local', id)).toBe('new.txt');
    // A record whose file has gone is not believed.
    await ws.blobs.delete(outputs.key('local', id, 'new.txt'));
    expect(await outputs.file('local', id)).toBe('old.mp4');
    expect(await outputs.file('local', id, (name) => !name.startsWith('old'))).toBeUndefined();
  });

  it('counts the same stored bytes with or without an output record', async () => {
    const { outputs, ws } = env.runtime;
    const before = await ws.blobs.usage('counted');
    await outputs.write(
      'counted',
      'f_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'a.png',
      Buffer.alloc(100),
      'frames',
    );
    expect((await ws.blobs.usage('counted')) - before).toBe(100);
  });

  it('gives an output blob the server\u2019s own signed link, which it then accepts', async () => {
    const { outputs, ws } = env.runtime;
    const id = 'j_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    await outputs.write('local', id, 'out.txt', 'bytes', 'transcript');
    const link = await ws.blobs.presignGet(outputs.key('local', id, 'out.txt'), { ttlMs: 60_000 });
    const url = new URL(link as string);
    expect(url.pathname).toBe(`/outputs/local/${id}/out.txt`);
    expect(
      await env.runtime.verifyOutput(
        url.pathname,
        url.searchParams.get('exp'),
        url.searchParams.get('sig'),
      ),
    ).toBe(await outputs.local('local', id, 'out.txt'));
    expect(
      await ws.blobs.presignGet(ws.blobs.keys.media('local', 'm_x', 'source.mp4'), { ttlMs: 1 }),
    ).toBeUndefined();
  });

  it('reads a media record that names its files by path as the keys of the same files', async () => {
    const { media, ws } = env.runtime;
    const id = 'm_aaaaaaaaaaaaaaaaaaaaaaaaac';
    const dir = media.dir('paths', id);
    const now = new Date().toISOString();
    await ws.writeJson(`${dir}/media.json`, {
      media_id: id,
      name: 'old.mp4',
      status: 'ready',
      source: { url: 'https://example.test/old.mp4' },
      file: `${dir}/source.mp4`,
      size: 1,
      fingerprint: null,
      probe: null,
      conform: [],
      mezzanine: `${dir}/mezzanine.mov`,
      proxy: null,
      analysis: null,
      created_at: now,
      updated_at: now,
    });
    const record = await media.get('paths', id);
    expect(record.file).toBe(ws.blobs.keys.media('paths', id, 'source.mp4'));
    expect(record.mezzanine).toBe(ws.blobs.keys.media('paths', id, 'mezzanine.mov'));
    expect(await media.local(record.file as string)).toBe(`${dir}/source.mp4`);
    expect(await media.sourceFile(record, 'export')).toBe(`${dir}/mezzanine.mov`);
    // A path import's original is the user's own file, and stays a path.
    const own = 'm_aaaaaaaaaaaaaaaaaaaaaaaaad';
    await ws.writeJson(`${media.dir('paths', own)}/media.json`, {
      ...record,
      media_id: own,
      source: { path: '/media/clip.mp4' },
      file: '/media/clip.mp4',
      mezzanine: null,
    });
    const kept = await media.get('paths', own);
    expect(kept.file).toBe('/media/clip.mp4');
    expect(await media.local(kept.file as string)).toBe('/media/clip.mp4');
    // Saved again, the data root still holds the path, as it did before.
    await media.save('paths', record);
    expect(await ws.readJson<{ file: string }>(`${dir}/media.json`)).toMatchObject({
      file: `${dir}/source.mp4`,
      mezzanine: `${dir}/mezzanine.mov`,
      proxy: null,
    });
  });

  it('writes a media record to disk as the code before blob keys did: absolute paths, same fields', async () => {
    const { media, ws } = env.runtime;
    const sent = join(env.dir, 'clip.mp4');
    await writeFile(sent, 'not really a video');
    // As an import does it: the record, its file adopted, then what ingest fills in.
    const record = await media.create('disk', { url: 'https://example.test/clip.mp4' }, 'clip.mp4');
    const id = record.media_id;
    const dir = media.dir('disk', id);
    record.file = await media.adopt('disk', record, { file: sent });
    record.size = 18;
    record.fingerprint = 'f'.repeat(40);
    record.conform = ['variable frame rate'];
    record.mezzanine = ws.blobs.keys.media('disk', id, 'mezzanine.mov');
    record.proxy = ws.blobs.keys.media('disk', id, 'proxy.mov');
    record.status = 'ready';
    await media.save('disk', record);
    const text = await readFile(`${dir}/media.json`, 'utf8');
    const stored = JSON.parse(text);
    // Field for field what develop's MediaLibrary.save wrote for the same media.
    expect(stored).toEqual({
      media_id: id,
      name: 'clip.mp4',
      status: 'ready',
      source: { url: 'https://example.test/clip.mp4' },
      file: `${dir}/source.mp4`,
      size: 18,
      fingerprint: 'f'.repeat(40),
      probe: null,
      conform: ['variable frame rate'],
      mezzanine: `${dir}/mezzanine.mov`,
      proxy: `${dir}/proxy.mov`,
      analysis: null,
      created_at: record.created_at,
      updated_at: record.updated_at,
    });
    expect(Object.keys(stored)).toEqual([
      'media_id',
      'name',
      'status',
      'source',
      'file',
      'size',
      'fingerprint',
      'probe',
      'conform',
      'mezzanine',
      'proxy',
      'analysis',
      'created_at',
      'updated_at',
    ]);
    expect(text).toBe(`${JSON.stringify(stored, null, 2)}\n`);
    expect(text).not.toContain('"owners/');
    expect(await readFile(stored.file, 'utf8')).toBe('not really a video');
    // Above the store the same record holds keys.
    const read = await media.get('disk', id);
    expect([read.file, read.mezzanine, read.proxy]).toEqual([
      `owners/disk/media/${id}/source.mp4`,
      `owners/disk/media/${id}/mezzanine.mov`,
      `owners/disk/media/${id}/proxy.mov`,
    ]);
    expect((await media.list('disk'))[0]?.file).toBe(read.file);
  });

  it('loads a media record in the shape production holds today', async () => {
    const { media, ws } = env.runtime;
    const id = 'm_aaaaaaaaaaaaaaaaaaaaaaaaae';
    const dir = media.dir('prod', id);
    // Written as develop's writeJson wrote it: no store in between.
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/source.mp4`, 'bytes');
    await writeFile(
      `${dir}/media.json`,
      `${JSON.stringify(
        {
          media_id: id,
          name: 'upload.mp4',
          status: 'ready',
          source: {
            upload: 'u_aaaaaaaaaaaaaaaaaaaaaaaaaa',
            file_name: 'upload.mp4',
            via: 'media.upload',
          },
          file: `${dir}/source.mp4`,
          size: 5,
          fingerprint: 'a'.repeat(40),
          probe: null,
          conform: [],
          mezzanine: null,
          proxy: `${dir}/proxy.mov`,
          analysis: { loudness_lufs: -20 },
          job_id: 'j_aaaaaaaaaaaaaaaaaaaaaaaaaa',
          created_at: '2026-11-20T10:00:00.000Z',
          updated_at: '2026-11-20T10:00:05.000Z',
        },
        null,
        2,
      )}\n`,
    );
    const before = await readFile(`${dir}/media.json`, 'utf8');
    const record = await media.get('prod', id);
    expect(record).toMatchObject({
      media_id: id,
      status: 'ready',
      file: ws.blobs.keys.media('prod', id, 'source.mp4'),
      mezzanine: null,
      proxy: ws.blobs.keys.media('prod', id, 'proxy.mov'),
      analysis: { loudness_lufs: -20 },
    });
    expect(await media.sourceFile(record, 'export')).toBe(`${dir}/source.mp4`);
    expect(await media.sourceFile(record, 'preview')).toBe(`${dir}/proxy.mov`);
    // Reading leaves the file as it was, and a save writes the same paths back.
    expect(await readFile(`${dir}/media.json`, 'utf8')).toBe(before);
    await media.save('prod', record);
    const after = JSON.parse(await readFile(`${dir}/media.json`, 'utf8'));
    expect({ ...after, updated_at: '' }).toEqual({ ...JSON.parse(before), updated_at: '' });
  });
});
