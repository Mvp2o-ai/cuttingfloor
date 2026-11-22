import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { configFromEnv } from '@cuttingfloor/server';
import { describe, expect, it, vi } from 'vitest';

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
    expect(() => configFromEnv({ CUTTINGFLOOR_RECORDS: 'sqlite' })).toThrow(/fs or mongo$/);
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

  it('takes values as a secrets file gives them, and a plain host as a plain host', () => {
    expect(
      configFromEnv({
        CUTTINGFLOOR_RECORDS: ' mongo\n',
        CUTTINGFLOOR_MONGODB_HOST: 'mongo\n',
        CUTTINGFLOOR_MONGODB_USER: 'app\n',
        CUTTINGFLOOR_MONGODB_PASSWORD: 'pass word\r\n',
        CUTTINGFLOOR_MONGODB_DB: ' cf \n',
      }).records,
    ).toEqual({
      store: 'mongo',
      uri: 'mongodb://app:pass%20word@mongo/?retryWrites=true&w=majority',
      db: 'cf',
    });
    expect(
      configFromEnv({
        CUTTINGFLOOR_RECORDS: 'mongo',
        CUTTINGFLOOR_MONGODB_URI: 'mongodb://app:pw@db:27017/\n',
      }).records?.uri,
    ).toBe('mongodb://app:pw@db:27017/');
  });

  it('says which variable is missing or wrong, never what one holds', () => {
    // A connection string pasted into the wrong variable is not printed back.
    const pasted = 'mongodb+srv://app:hunter2-hunter2@cluster.x.mongodb.net';
    let said = '';
    try {
      configFromEnv({ CUTTINGFLOOR_RECORDS: pasted });
    } catch (error) {
      said = (error as Error).message;
    }
    expect(said).toBe('CUTTINGFLOOR_RECORDS must be fs or mongo');
    expect(() =>
      configFromEnv({
        CUTTINGFLOOR_RECORDS: 'mongo',
        CUTTINGFLOOR_MONGODB_HOST: 'mongo',
        CUTTINGFLOOR_MONGODB_PASSWORD: 'hunter2-hunter2',
      }),
    ).toThrow(/^CUTTINGFLOOR_MONGODB_PASSWORD is set without CUTTINGFLOOR_MONGODB_USER$/);
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

  it('a shutdown is not held up by a database out of reach', async () => {
    const { Runtime } = await import('@cuttingfloor/server');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const runtime = new Runtime({
      ...configFromEnv({
        CUTTINGFLOOR_DATA: await mkdtemp(join(tmpdir(), 'cf-unreachable-')),
        CUTTINGFLOOR_RECORDS: 'mongo',
        CUTTINGFLOOR_MONGODB_HOST: '127.0.0.1:1',
      }),
      mediaRoots: [],
    });
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // A lease being asked for, as a turn of periodic work would: it waits on the database.
      const asked = runtime.ws.records.leader('sweep').catch(() => false);
      const began = Date.now();
      await runtime.close(300);
      expect(Date.now() - began).toBeLessThan(1500);
      // Left to itself the store takes as long as the database takes to say no.
      expect(await asked).toBe(false);
      await runtime.close();
    } finally {
      log.mockRestore();
    }
  }, 30_000);
});
