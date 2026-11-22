import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, describe, expect, it } from 'vitest';
import { type TestEnv, testRuntime } from './helpers.ts';

// A data root holds what years of servers and hands left in it. The sweep, which a server runs
// before it takes its first request, steps over what it cannot read.

let env: TestEnv | undefined;

afterAll(async () => {
  env?.runtime.stop();
  if (env) await rm(env.dir, { recursive: true, force: true });
});

describe('the sweep on a data root with bad entries among the uploads', () => {
  it('starts the server and sweeps the rest', async () => {
    env = await testRuntime();
    const { ws } = env.runtime;
    const uploads = ws.ownerDir('messy', 'uploads');
    const whole = 'u_aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const cut = 'u_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    const old = 'u_cccccccccccccccccccccccccc';
    for (const id of [whole, cut, old]) await mkdir(join(uploads, id), { recursive: true });
    // A plain file where only upload folders belong, and a record cut off mid-write.
    await writeFile(join(uploads, 'notes.txt'), 'stray');
    await writeFile(join(uploads, '.DS_Store'), 'stray');
    await writeFile(join(uploads, cut, 'upload.json'), '{"upload_id": "u_bbbbbbbbbbbbb');
    const meta = (id: string) =>
      JSON.stringify({ upload_id: id, name: 'a.mp4', file: 'data.mp4', created_at: 'then' });
    await writeFile(join(uploads, whole, 'upload.json'), meta(whole));
    await writeFile(join(uploads, old, 'upload.json'), meta(old));
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    await utimes(join(uploads, old, 'upload.json'), longAgo, longAgo);
    await utimes(join(uploads, old), longAgo, longAgo);
    // Something the sweep reaches only after the uploads: a call log past its time.
    const calls = ws.ownerDir('messy', 'calls');
    await mkdir(calls, { recursive: true });
    await writeFile(join(calls, '2020-01-01.old.jsonl'), '{}\n');
    const ancient = new Date(Date.now() - 60 * 86_400_000);
    await utimes(join(calls, '2020-01-01.old.jsonl'), ancient, ancient);

    // As a server starting on this data root does, sweep and all.
    const server = new Runtime(env.runtime.config);
    await server.start();
    server.stop();
    await env.runtime.uploads.sweep();

    expect((await readdir(uploads)).sort()).toEqual(['.DS_Store', 'notes.txt', cut, whole].sort());
    expect(await readdir(calls)).toEqual([]);
  });
});
