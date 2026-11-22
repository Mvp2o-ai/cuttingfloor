import { createHash, randomBytes } from 'node:crypto';
import {
  type Collection,
  type CollectionSpec,
  defineCollection,
  randomId,
  type Workspace,
} from '@cuttingfloor/core';

// Script keys: bearer keys a signed-in user makes on the account page, so a script reaches /mcp
// without a browser sign-in. A key acts as its account, with the same plan checks.
// Still no database: each key is two files under the data root, and neither holds the key, only
// its SHA-256. `keys/{sha256}.json` says whose it is (read on each request);
// `owners/{owner}/keys/{key_id}.json` lists it on the account page. A key works for a year.
// Admin keys (admin-api.ts) are the same, under `admin-keys/` with their own prefix: a script key
// never opens the admin API, and an admin key never reaches /mcp.

/** How long a script key works after it is made. */
export const SCRIPT_KEY_TTL_MS = 365 * 24 * 3_600_000;
/** Limits that protect the server: keys an account holds at once. */
export const SCRIPT_KEYS_MAX = 10;
/** Every script key starts with this, so a leaked one is recognisable. */
export const SCRIPT_KEY_PREFIX = 'cf_';

/** Which keys a store holds: their prefix, their folder and a new key's default label. */
export interface KeyKind {
  prefix: string;
  dir: string;
  label: string;
}

export const SCRIPT_KEYS: KeyKind = { prefix: SCRIPT_KEY_PREFIX, dir: 'keys', label: 'Script key' };

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
  readonly #kind: KeyKind;

  /** Whose each key is, by the key's SHA-256: one set for the deployment (`{dir}/{sha256}.json`). */
  readonly #hashes: CollectionSpec<KeyFile>;
  /** Each account's keys, by key id (`owners/{owner}/{dir}/{key_id}.json`). */
  readonly #listed: CollectionSpec<KeyFile>;

  constructor(ws: Workspace, kind: KeyKind = SCRIPT_KEYS) {
    this.#ws = ws;
    this.#kind = kind;
    const name = kind.dir.replaceAll('-', '_');
    this.#hashes = defineCollection<KeyFile>({
      name,
      scope: 'global',
      fs: { dir: kind.dir },
      db: { indexesAcross: [['owner']], ttlMs: SCRIPT_KEY_TTL_MS },
    });
    this.#listed = defineCollection<KeyFile>({
      name: `${name}_listed`,
      scope: 'owner',
      fs: { dir: kind.dir },
      db: { ttlMs: SCRIPT_KEY_TTL_MS },
    });
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
    const key = `${this.#kind.prefix}${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const file: KeyFile = {
      key_id: randomId('k_'),
      label: label.trim().slice(0, 60) || this.#kind.label,
      starts: key.slice(0, 7),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + SCRIPT_KEY_TTL_MS).toISOString(),
      owner,
      sha256: digest(key),
      ...(partner ? { partner } : {}),
    };
    await this.#byHash().insertOnce(file.sha256, file);
    await this.#byOwner(owner).put(file.key_id, file);
    return { ...view(file), key };
  }

  /** The owner's keys still working, newest first. */
  async list(owner: string): Promise<ScriptKeyView[]> {
    return (await this.#files(owner))
      .map(view)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async #files(owner: string): Promise<KeyFile[]> {
    const listed = this.#byOwner(owner);
    const out: KeyFile[] = [];
    for (const id of await listed.ids()) {
      const file = await listed.get(id).catch(() => undefined);
      if (file && Date.parse(file.expires_at) > Date.now()) out.push(file);
    }
    return out;
  }

  /** Stops a key working at once. False when the owner has no such key. */
  async revoke(owner: string, keyId: string): Promise<boolean> {
    if (!/^k_[0-9a-z]{26}$/.test(keyId)) return false;
    const file = await this.#byOwner(owner).get(keyId);
    if (!file) return false;
    await this.#byHash().delete(file.sha256);
    await this.#byOwner(owner).delete(keyId);
    return true;
  }

  /**
   * Stops every key the owner holds, partners' and expired ones too, and removes their files (the
   * account is being deleted). Looks through every key, so one whose listing a crash never wrote
   * goes as well.
   */
  async removeAll(owner: string): Promise<void> {
    const hashes = this.#byHash();
    for (const id of await hashes.ids()) {
      const file = await hashes.get(id).catch(() => undefined);
      if (file?.owner === owner) await hashes.delete(id);
    }
    await this.#byOwner(owner).clear();
  }

  /** Whose key this is, or undefined for one never made, revoked or expired. */
  async owner(key: string): Promise<string | undefined> {
    return (await this.find(key))?.owner;
  }

  /** The key's owner and listing, or undefined for one never made, revoked or expired. */
  async find(key: string): Promise<(ScriptKeyView & { owner: string }) | undefined> {
    if (!key.startsWith(this.#kind.prefix)) return undefined;
    const file = await this.#byHash().get(digest(key));
    if (!file || Date.parse(file.expires_at) <= Date.now()) return undefined;
    return { ...view(file), owner: file.owner };
  }

  /** Removes expired keys' files. */
  async sweep(): Promise<void> {
    const now = Date.now();
    const expired = async (keys: Collection<KeyFile>) => {
      for (const id of await keys.ids()) {
        const file = await keys.get(id).catch(() => undefined);
        if (file && Date.parse(file.expires_at) <= now) await keys.delete(id);
      }
    };
    await expired(this.#byHash());
    for (const key of await this.#ws.records.owners()) await expired(this.#byOwner(key));
  }

  #byHash(): Collection<KeyFile> {
    return this.#ws.records.collection(this.#hashes);
  }

  #byOwner(owner: string): Collection<KeyFile> {
    return this.#ws.records.collection(this.#listed, { owner });
  }
}

function view(file: KeyFile): ScriptKeyView {
  const { key_id, label, starts, created_at, expires_at } = file;
  return { key_id, label, starts, created_at, expires_at };
}
