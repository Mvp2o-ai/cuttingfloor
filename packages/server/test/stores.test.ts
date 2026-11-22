import { rm } from 'node:fs/promises';
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
    // Saved again, the record holds keys.
    await media.save('paths', record);
    expect(await ws.readJson<{ file: string }>(`${dir}/media.json`)).toMatchObject({
      file: `owners/paths/media/${id}/source.mp4`,
    });
  });
});
