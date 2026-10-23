import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ProviderId, SavedKeys } from '@cuttingfloor/credentials';

// Provider keys a user saves on the account page (their sync. labs key, for create.lipsync), kept
// without a database and never on this server's disk: each one is encrypted (AES-256-GCM, bound
// to the user and provider) with a key only the server's config holds, and the ciphertext lives
// in the user's WorkOS metadata as `key_<provider>`. Only the last four characters are ever shown.

/** The providers a user may save a key for. */
export const SAVABLE: readonly ProviderId[] = ['sync'];

const READ_TTL = 60_000;

export class ProviderKeys implements SavedKeys {
  #workosKey: string;
  #secret: Buffer;
  #cache = new Map<string, { at: number; metadata: Record<string, string> }>();

  /** `secret`: 32 bytes, base64 (CUTTINGFLOOR_KEY_SECRET). */
  constructor(workosKey: string, secret: string) {
    this.#workosKey = workosKey;
    this.#secret = Buffer.from(secret, 'base64');
    if (this.#secret.length !== 32)
      throw new Error('CUTTINGFLOOR_KEY_SECRET must be 32 bytes, base64');
  }

  /** The saved key, for the server's own provider calls only. */
  async get(owner: string, provider: ProviderId): Promise<string | undefined> {
    if (!SAVABLE.includes(provider) || !isUser(owner)) return undefined;
    const sealed = (await this.#metadata(owner))[`key_${provider}`];
    return sealed ? this.#open(owner, provider, sealed) : undefined;
  }

  /** Which providers have a key saved, each with its last four characters. */
  async list(owner: string): Promise<Array<{ provider: ProviderId; ends: string }>> {
    const out: Array<{ provider: ProviderId; ends: string }> = [];
    for (const provider of SAVABLE) {
      const key = await this.get(owner, provider);
      if (key) out.push({ provider, ends: key.slice(-4) });
    }
    return out;
  }

  async save(owner: string, provider: ProviderId, key: string): Promise<void> {
    await this.#write(owner, provider, this.#seal(owner, provider, key));
  }

  async remove(owner: string, provider: ProviderId): Promise<void> {
    await this.#write(owner, provider, null);
  }

  #seal(owner: string, provider: ProviderId, key: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#secret, iv);
    cipher.setAAD(Buffer.from(`${owner}:${provider}`));
    const body = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  #open(owner: string, provider: ProviderId, sealed: string): string | undefined {
    try {
      const raw = Buffer.from(sealed, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.#secret, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${owner}:${provider}`));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      // Sealed with another secret, or altered: as good as no key.
      return undefined;
    }
  }

  async #metadata(owner: string): Promise<Record<string, string>> {
    const hit = this.#cache.get(owner);
    if (hit && Date.now() - hit.at < READ_TTL) return hit.metadata;
    const user = await this.#workos(`/user_management/users/${encodeURIComponent(owner)}`);
    const metadata = (user.metadata ?? {}) as Record<string, string>;
    this.#cache.set(owner, { at: Date.now(), metadata });
    return metadata;
  }

  async #write(owner: string, provider: ProviderId, sealed: string | null): Promise<void> {
    if (!SAVABLE.includes(provider)) throw new Error(`No key can be saved for ${provider}`);
    const path = `/user_management/users/${encodeURIComponent(owner)}`;
    const metadata = { ...(((await this.#workos(path)).metadata ?? {}) as Record<string, string>) };
    if (sealed) metadata[`key_${provider}`] = sealed;
    else delete metadata[`key_${provider}`];
    await this.#workos(path, { method: 'PUT', body: { metadata } });
    this.#cache.delete(owner);
  }

  async #workos(path: string, init: { method?: string; body?: unknown } = {}) {
    const res = await fetch(`https://api.workos.com${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${this.#workosKey}`, 'content-type': 'application/json' },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`WorkOS ${path.split('?')[0]}: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

const isUser = (owner: string) => /^user_[0-9A-Z]{26}$/.test(owner);
