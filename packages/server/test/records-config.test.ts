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
});
