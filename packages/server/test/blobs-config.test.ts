import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { configFromEnv } from '@cuttingfloor/server';
import { describe, expect, it } from 'vitest';

// Where files are kept is one environment variable; the bucket's address and keys come with it,
// and nothing secret is ever echoed back. (The settings themselves are tested with the store,
// in packages/core.)

describe('CUTTINGFLOOR_BLOBS', () => {
  const s3 = {
    CUTTINGFLOOR_BLOBS: 's3',
    CUTTINGFLOOR_S3_ENDPOINT: 'https://fsn1.your-objectstorage.com',
    CUTTINGFLOOR_S3_REGION: 'fsn1',
    CUTTINGFLOOR_S3_BUCKET: 'cuttingfloor-prod',
    CUTTINGFLOOR_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    CUTTINGFLOOR_S3_SECRET_ACCESS_KEY: 'hunter2-hunter2-hunter2',
  };

  it('is the filesystem unless it says s3, whatever else is set', () => {
    expect(configFromEnv({}).s3).toBeUndefined();
    expect(configFromEnv({ ...s3, CUTTINGFLOOR_BLOBS: 'fs' }).s3).toBeUndefined();
    expect(configFromEnv({ ...s3, CUTTINGFLOOR_BLOBS: '' }).s3).toBeUndefined();
    expect(configFromEnv(s3).s3).toMatchObject({
      endpoint: 'https://fsn1.your-objectstorage.com',
      region: 'fsn1',
      bucket: 'cuttingfloor-prod',
      pathStyle: false,
    });
  });

  it('refuses to start on a missing or wrong setting, naming it and never what one holds', () => {
    expect(() => configFromEnv({ ...s3, CUTTINGFLOOR_S3_BUCKET: '' })).toThrow(
      /^CUTTINGFLOOR_BLOBS=s3 needs CUTTINGFLOOR_S3_BUCKET$/,
    );
    let said = '';
    try {
      configFromEnv({ ...s3, CUTTINGFLOOR_BLOBS: s3.CUTTINGFLOOR_S3_SECRET_ACCESS_KEY });
    } catch (error) {
      said = (error as Error).message;
    }
    expect(said).toBe('CUTTINGFLOOR_BLOBS must be fs or s3');
  });

  it('a server on the filesystem never loads the S3 SDK', async () => {
    // In a process of its own: a runtime starts, stores and reads a file, and no module of the
    // SDK has been loaded (it is CommonJS, so loading it would show in the require cache). The
    // same process then shows the check can see it: asking for the SDK loads it.
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    const core = fileURLToPath(new URL('../../core/package.json', import.meta.url));
    const script = `
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createRequire } = await import('node:module');
      const { Runtime, configFromEnv } = await import(${JSON.stringify(entry)});
      const dataDir = await mkdtemp(join(tmpdir(), 'cf-no-sdk-'));
      const runtime = new Runtime({ ...configFromEnv({ CUTTINGFLOOR_DATA: dataDir }), mediaRoots: [] });
      await runtime.start({ sweep: false });
      const id = await runtime.uploads.put('local', 'a.txt', Buffer.from('x'));
      await runtime.uploads.take('local', id);
      await runtime.sweep();
      await runtime.close();
      const sdk = (f) => /[\\\\/]@aws-sdk[\\\\/]|[\\\\/]@smithy[\\\\/]/.test(f);
      const require = createRequire(${JSON.stringify(core)});
      const loaded = Object.keys(require.cache).filter(sdk).length;
      require('@aws-sdk/client-s3');
      const after = Object.keys(require.cache).filter(sdk).length;
      console.log(JSON.stringify({ loaded, seen: after > 0 }));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: { ...process.env, CUTTINGFLOOR_BLOBS: '', CUTTINGFLOOR_RECORDS: '' } },
    );
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')).toEqual({ loaded: 0, seen: true });
  }, 30_000);
});
