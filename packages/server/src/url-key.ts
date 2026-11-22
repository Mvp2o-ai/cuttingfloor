import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { urlSecretKey } from './runtime.ts';

// Which key signs a server's download, watch and upload links, said without the key: a short
// HMAC of a fixed text under it. Two servers whose fingerprints match accept each other's links.

/** The fingerprint of a link-signing key. Says nothing of the key itself. */
export function urlKeyFingerprint(key: Buffer): string {
  return createHmac('sha256', key)
    .update('cuttingfloor link-signing key fingerprint v1')
    .digest('hex')
    .slice(0, 16);
}

/**
 * The key a server signs links with, as it chooses it: CUTTINGFLOOR_URL_SECRET when set, else
 * `secret.key` under its data root. Undefined when it has neither yet (it makes one at start).
 */
export async function serverUrlKey(options: {
  urlSecret?: string | undefined;
  dataDir: string;
}): Promise<Buffer | undefined> {
  if (options.urlSecret) return urlSecretKey(options.urlSecret);
  try {
    const { key } = JSON.parse(await readFile(join(options.dataDir, 'secret.key'), 'utf8')) as {
      key: string;
    };
    return Buffer.from(key, 'base64');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
