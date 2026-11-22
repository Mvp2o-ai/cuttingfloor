import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, ok, type TestEnv, testRuntime } from './helpers.ts';

// What deleting a media removes on the filesystem: its own folder, nothing else. A record from
// an older server may name a file outside its folder; that file is someone else's.

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.runtime.close();
  if (env) await rm(env.dir, { recursive: true, force: true });
  env = undefined;
});

describe('deleting a media on the filesystem', () => {
  it('leaves a file outside its own folder alone', async () => {
    env = await testRuntime();
    const { runtime } = env;
    const { blobs } = runtime.ws;
    const owner = 'local';
    const ready = async (fileOf: (id: string) => string) => {
      const record = await runtime.media.create(
        owner,
        { upload: 'u_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
        'a.bin',
      );
      record.file = fileOf(record.media_id);
      record.size = 5;
      record.status = 'ready';
      await runtime.media.save(owner, record);
      return record;
    };
    const first = await ready((id) => blobs.keys.media(owner, id, 'source.bin'));
    await blobs.put(first.file as string, { bytes: Buffer.from('hello') });
    // A legacy record naming the first media's file as its own.
    const second = await ready(() => first.file as string);
    const client = await connect(runtime, owner);
    await ok(client, 'media.delete', { media_id: second.media_id });
    expect(await blobs.head(first.file as string)).toMatchObject({ bytes: 5 });
  });
});
