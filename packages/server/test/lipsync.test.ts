import { beforeAll, describe, expect, it } from 'vitest';
import { call, connect, ok, type TestEnv, testRuntime } from './helpers.ts';

// create.lipsync in local mode, without engines: the key comes from the environment (or a Docker
// secret), and a missing one stops the call before any job. The provider flow itself, with a
// stand-in for api.sync.so and hosted header keys, is in apps/hosted/test/lipsync.test.ts.

let env: TestEnv;

beforeAll(async () => {
  env = await testRuntime();
});

describe('create.lipsync keys, locally', () => {
  it('asks for SYNC_API_KEY in the .env first, and names the hosted header too', async () => {
    const client = await connect(env.runtime, 'lipsync-none');
    const res = await call(client, 'create.lipsync', {
      video: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      audio: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    expect(res.isError).toBe(true);
    const err = res.structured as { code: string; detail: unknown; hint: string };
    expect(err.code).toBe('credential_required');
    expect(err.detail).toEqual({
      provider: 'sync',
      env: 'SYNC_API_KEY',
      header: 'X-Cuttingfloor-Key-Sync',
    });
    expect(err.hint.indexOf('SYNC_API_KEY=<key>')).toBeLessThan(
      err.hint.indexOf('X-Cuttingfloor-Key-Sync'),
    );
    expect((await ok<{ jobs: unknown[] }>(client, 'job.list', {})).jobs).toHaveLength(0);
  });

  it('reads the key from the environment, and health shows only that it is there', async () => {
    const client = await connect(env.runtime, 'lipsync-env', { SYNC_API_KEY: 'sk-env-secret' });
    const health = await client.readResource({ uri: 'video://server/health' });
    const text = String((health.contents[0] as { text: string }).text);
    expect(JSON.parse(text).providers.sync).toEqual({ configured: true, source: 'env' });
    expect(text).not.toContain('sk-env-secret');
    // With a key, the call gets as far as the media.
    const res = await call(client, 'create.lipsync', {
      video: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      audio: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    expect((res.structured as { code: string }).code).toBe('not_found');
    expect(JSON.stringify(res)).not.toContain('sk-env-secret');
  });

  it('checks ranges in the schema', async () => {
    const client = await connect(env.runtime, 'lipsync-env', { SYNC_API_KEY: 'sk-env-secret' });
    const res = await call(client, 'create.lipsync', {
      video: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      audio: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbb',
      range: { start_seconds: 3, end_seconds: 2 },
    });
    expect(res.isError).toBe(true);
  });
});
