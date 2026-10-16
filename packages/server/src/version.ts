import { readFileSync } from 'node:fs';

export const SERVER_NAME = 'cuttingfloor';

/** The released version (apps/cli/package.json, bumped by changesets). */
export const SERVER_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../../apps/cli/package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
