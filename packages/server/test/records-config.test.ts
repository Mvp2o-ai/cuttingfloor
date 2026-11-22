import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { configFromEnv } from '@cuttingfloor/server';
import { describe, expect, it } from 'vitest';

// Where records are kept is one environment variable; the database's address comes whole or in
// parts, and nothing secret is ever echoed back.

describe('CUTTINGFLOOR_RECORDS', () => {
  it('is the filesystem unless it says mongo', () => {
    expect(configFromEnv({}).records).toBeUndefined();
    expect(configFromEnv({ CUTTINGFLOOR_RECORDS: 'fs' }).records).toBeUndefined();
    // The address alone changes nothing: a server keeps its files until it is told otherwise.
    expect(
      configFromEnv({ CUTTINGFLOOR_MONGODB_URI: 'mongodb://127.0.0.1:27017' }).records,
    ).toBeUndefined();
    expect(() => configFromEnv({ CUTTINGFLOOR_RECORDS: 'sqlite' })).toThrow(/fs or mongo/);
  });

  it('takes the database as one connection string', () => {
    expect(
      configFromEnv({
        CUTTINGFLOOR_RECORDS: 'mongo',
        CUTTINGFLOOR_MONGODB_URI: 'mongodb+srv://app:pw@cluster.x.mongodb.net/?w=majority',
      }).records,
    ).toEqual({
      store: 'mongo',
      uri: 'mongodb+srv://app:pw@cluster.x.mongodb.net/?w=majority',
      db: 'cuttingfloor',
    });
  });

  it('or builds it from the cluster, the user and the password', () => {
    expect(
      configFromEnv({
        CUTTINGFLOOR_RECORDS: 'mongo',
        CUTTINGFLOOR_MONGODB_HOST: 'cluster.x.mongodb.net',
        CUTTINGFLOOR_MONGODB_USER: 'cuttingfloor-app',
        CUTTINGFLOOR_MONGODB_PASSWORD: 'p@ss:word/1',
        CUTTINGFLOOR_MONGODB_DB: 'staging',
      }).records,
    ).toEqual({
      store: 'mongo',
      uri: 'mongodb+srv://cuttingfloor-app:p%40ss%3Aword%2F1@cluster.x.mongodb.net/?retryWrites=true&w=majority',
      db: 'staging',
    });
  });

  it('says which variable is missing or wrong, never what one holds', () => {
    expect(() => configFromEnv({ CUTTINGFLOOR_RECORDS: 'mongo' })).toThrow(
      /needs CUTTINGFLOOR_MONGODB_URI, or CUTTINGFLOOR_MONGODB_HOST/,
    );
    const secret = 'hunter2-hunter2';
    for (const env of [
      { CUTTINGFLOOR_MONGODB_USER: 'app', CUTTINGFLOOR_MONGODB_PASSWORD: secret },
      { CUTTINGFLOOR_MONGODB_URI: `postgres://app:${secret}@db/x` },
    ]) {
      let message = '';
      try {
        configFromEnv({ CUTTINGFLOOR_RECORDS: 'mongo', ...env });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/CUTTINGFLOOR_MONGODB_/);
      expect(message).not.toContain(secret);
    }
  });

  it('a server on the filesystem never loads the database driver', async () => {
    // In a process of its own: a runtime starts, keeps a record, and no module of the driver
    // has been loaded (it is CommonJS, so loading it would show in the require cache).
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    const script = `
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createRequire } = await import('node:module');
      const { Runtime, configFromEnv } = await import(${JSON.stringify(entry)});
      const dataDir = await mkdtemp(join(tmpdir(), 'cf-no-driver-'));
      const runtime = new Runtime({ ...configFromEnv({ CUTTINGFLOOR_DATA: dataDir }), mediaRoots: [] });
      await runtime.start({ sweep: false });
      await runtime.timelines.sweep();
      await runtime.close();
      const loaded = Object.keys(createRequire(import.meta.url).cache).filter((f) => /[\\/]mongodb[\\/]/.test(f));
      console.log(JSON.stringify({ loaded: loaded.length }));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: { ...process.env, CUTTINGFLOOR_RECORDS: '' } },
    );
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')).toEqual({ loaded: 0 });
  }, 30_000);
});
