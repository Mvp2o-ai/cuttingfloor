import type { Workspace } from '@cuttingfloor/core';

// What an account may do here beyond its own work: cuttingfloor's own rights table. WorkOS signs
// people in (the login Kazi shares), but whether someone is a cuttingfloor admin is decided only
// here, never from Kazi or WorkOS metadata. One file per user, `rights/{user}.json`, with no TTL:
// a right lasts until it is taken away. Granted by `scripts/grant-role.ts` on the server.

/** The roles there are. `admin` opens the admin API (admin-api.ts). */
export const ROLES = ['admin'] as const;
export type Role = (typeof ROLES)[number];

export interface RightsFile {
  user: string;
  roles: Role[];
  /** When each role was granted, by whom and why. */
  grants: Array<{ role: Role; at: string; by: string; reason: string }>;
}

export class Rights {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    this.#ws = ws;
  }

  /** The user's roles; none for a user never granted one. */
  async roles(user: string): Promise<Role[]> {
    if (!isUser(user)) return [];
    const file = await this.#ws.readJson<RightsFile>(this.#path(user)).catch(() => undefined);
    return (file?.roles ?? []).filter((role): role is Role => ROLES.includes(role));
  }

  async has(user: string, role: Role): Promise<boolean> {
    return (await this.roles(user)).includes(role);
  }

  async grant(user: string, role: Role, by: string, reason: string): Promise<RightsFile> {
    if (!isUser(user)) throw new Error('user must be a WorkOS user id');
    const file = (await this.#ws.readJson<RightsFile>(this.#path(user))) ?? {
      user,
      roles: [],
      grants: [],
    };
    if (!file.roles.includes(role)) file.roles.push(role);
    file.grants.push({ role, at: new Date().toISOString(), by, reason });
    await this.#ws.writeJson(this.#path(user), file);
    return file;
  }

  /** Takes a role away; every admin key of the user stops opening the admin API at once. */
  async revoke(user: string, role: Role): Promise<boolean> {
    if (!isUser(user)) return false;
    const file = await this.#ws.readJson<RightsFile>(this.#path(user));
    if (!file?.roles.includes(role)) return false;
    file.roles = file.roles.filter((r) => r !== role);
    if (file.roles.length) await this.#ws.writeJson(this.#path(user), file);
    else await this.#ws.remove(this.#path(user));
    return true;
  }

  #path(user: string): string {
    return this.#ws.path('rights', `${user}.json`);
  }
}

export const isUser = (owner: string) => /^user_[0-9A-Z]{26}$/.test(owner);
