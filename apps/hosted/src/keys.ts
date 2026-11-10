import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { randomId, type Workspace } from '@cuttingfloor/core';

// Script keys: bearer keys a signed-in user makes on the account page, so a script reaches /mcp
// without a browser sign-in. A key acts as its account, with the same plan checks.
// Still no database: each key is two files under the data root, and neither holds the key, only
// its SHA-256. `keys/{sha256}.json` says whose it is (read on each request);
// `owners/{owner}/keys/{key_id}.json` lists it on the account page. A key works for a year.

/** How long a script key works after it is made. */
export const SCRIPT_KEY_TTL_MS = 365 * 24 * 3_600_000;
/** Limits that protect the server: keys an account holds at once. */
export const SCRIPT_KEYS_MAX = 10;
/** Every script key starts with this, so a leaked one is recognisable. */
export const SCRIPT_KEY_PREFIX = 'cf_';

export interface ScriptKeyView {
  key_id: string;
  label: string;
  /** The key's first characters, to tell keys apart. */
  starts: string;
  created_at: string;
  expires_at: string;
}

interface KeyFile extends ScriptKeyView {
  owner: string;
  sha256: string;
  /** A key a partner got for its user (`POST /partner/keys`): the partner, its user id's SHA-256. */
  partner?: { name: string; sub: string };
}

const digest = (key: string) => createHash('sha256').update(key).digest('hex');

export class ScriptKeys {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    this.#ws = ws;
  }

  /** A new key for `owner`: the key itself is in this answer and nowhere else. */
  async create(owner: string, label: string): Promise<ScriptKeyView & { key: string }> {
    if ((await this.list(owner)).length >= SCRIPT_KEYS_MAX) {
      throw new Error(`An account holds up to ${SCRIPT_KEYS_MAX} keys; revoke one first`);
    }
    return this.#make(owner, label);
  }

  /**
   * A partner's key for its user: a new one each time, and the partner's earlier key for this
   * account stops working. Refused when the account's key from this partner is another user's.
   */
  async rotate(
    owner: string,
    partner: { name: string; sub: string },
  ): Promise<ScriptKeyView & { key: string }> {
    const mine = { name: partner.name, sub: digest(partner.sub) };
    const files = await this.#files(owner);
    const earlier = files.filter((file) => file.partner?.name === partner.name);
    if (earlier.some((file) => file.partner?.sub !== mine.sub)) {
      throw new Error(`This account's ${partner.name} key belongs to another user`);
    }
    if (files.length - earlier.length >= SCRIPT_KEYS_MAX) {
      throw new Error(`An account holds up to ${SCRIPT_KEYS_MAX} keys; revoke one first`);
    }
    const made = await this.#make(owner, partner.name, mine);
    for (const file of earlier) await this.revoke(owner, file.key_id);
    return made;
  }

  async #make(
    owner: string,
    label: string,
    partner?: { name: string; sub: string },
  ): Promise<ScriptKeyView & { key: string }> {
    const key = `${SCRIPT_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const file: KeyFile = {
      key_id: randomId('k_'),
      label: label.trim().slice(0, 60) || 'Script key',
      starts: key.slice(0, 7),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + SCRIPT_KEY_TTL_MS).toISOString(),
      owner,
      sha256: digest(key),
      ...(partner ? { partner } : {}),
    };
    await this.#ws.writeJson(this.#byHash(file.sha256), file, { exclusive: true });
    await this.#ws.writeJson(this.#byOwner(owner, file.key_id), file);
    return { ...view(file), key };
  }

  /** The owner's keys still working, newest first. */
  async list(owner: string): Promise<ScriptKeyView[]> {
    return (await this.#files(owner))
      .map(view)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async #files(owner: string): Promise<KeyFile[]> {
    const dir = this.#ws.ownerDir(owner, 'keys');
    const out: KeyFile[] = [];
    for (const name of await this.#ws.list(dir)) {
      const file = await this.#ws.readJson<KeyFile>(join(dir, name)).catch(() => undefined);
      if (file && Date.parse(file.expires_at) > Date.now()) out.push(file);
    }
    return out;
  }

  /** Stops a key working at once. False when the owner has no such key. */
  async revoke(owner: string, keyId: string): Promise<boolean> {
    if (!/^k_[0-9a-z]{26}$/.test(keyId)) return false;
    const path = this.#byOwner(owner, keyId);
    const file = await this.#ws.readJson<KeyFile>(path);
    if (!file) return false;
    await this.#ws.remove(this.#byHash(file.sha256));
    await this.#ws.remove(path);
    return true;
  }

  /** Whose key this is, or undefined for one never made, revoked or expired. */
  async owner(key: string): Promise<string | undefined> {
    if (!key.startsWith(SCRIPT_KEY_PREFIX)) return undefined;
    const file = await this.#ws.readJson<KeyFile>(this.#byHash(digest(key)));
    if (!file || Date.parse(file.expires_at) <= Date.now()) return undefined;
    return file.owner;
  }

  /** Removes expired keys' files. */
  async sweep(): Promise<void> {
    const now = Date.now();
    const expired = async (path: string) => {
      const file = await this.#ws.readJson<KeyFile>(path).catch(() => undefined);
      if (file && Date.parse(file.expires_at) <= now) await this.#ws.remove(path);
    };
    for (const name of await this.#ws.list(this.#ws.path('keys'))) {
      await expired(this.#ws.path('keys', name));
    }
    for (const key of await this.#ws.owners()) {
      const dir = this.#ws.path('owners', key, 'keys');
      for (const name of await this.#ws.list(dir)) await expired(join(dir, name));
    }
  }

  #byHash(sha256: string): string {
    return this.#ws.path('keys', `${sha256}.json`);
  }

  #byOwner(owner: string, keyId: string): string {
    return this.#ws.ownerDir(owner, 'keys', `${keyId}.json`);
  }
}

function view(file: KeyFile): ScriptKeyView {
  const { key_id, label, starts, created_at, expires_at } = file;
  return { key_id, label, starts, created_at, expires_at };
}
