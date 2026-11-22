// Prints the fingerprint of the key this server signs its links with (CUTTINGFLOOR_URL_SECRET,
// else secret.key under its data root), never the key. Run it on the new server with the
// server's own environment and give the line to the migration's verify as
// --target-key-fingerprint: links already handed out work on the new server only when it
// matches the old server's.
//
//   docker exec cuttingfloor node scripts/url-key-fingerprint.ts

import { configFromEnv } from '../packages/server/src/index.ts';
import { serverUrlKey, urlKeyFingerprint } from '../packages/server/src/url-key.ts';

const config = configFromEnv(process.env);
const key = await serverUrlKey({ urlSecret: config.urlSecret, dataDir: config.dataDir });
if (!key) {
  process.stderr.write('No link-signing key: set CUTTINGFLOOR_URL_SECRET\n');
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${urlKeyFingerprint(key)} (${config.urlSecret ? 'CUTTINGFLOOR_URL_SECRET' : 'secret.key'})\n`,
  );
}
