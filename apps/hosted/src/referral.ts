import { createHash } from 'node:crypto';
import type { WorkosUser } from './lifecycle.ts';

// Every account's own link, cuttingfloor.ai/r/<code>. The code is made from the account id
// alone: the first 40 bits of a SHA-256 of it, as eight lowercase Crockford base32 characters.
// So it never changes, needs nothing stored, and says nothing about the person (not even when
// the account was made, which the id itself carries). The site's /r/<code> keeps the code in
// the tagged links' 30-day cookie, and a sign-up keeps it as `referred_by` in its metadata
// (apps/site/app/referral.ts). A handle the user picks can stand in for it later.

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** An account's referral code. */
export function referralCode(owner: string): string {
  const hash = createHash('sha256').update(`cuttingfloor referral ${owner}`).digest();
  let bits = 0n;
  for (const byte of hash.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let i = 7; i >= 0; i--) code += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return code;
}

/** An account's link on the site, from the site's account page address. */
export function referralLink(owner: string, accountUrl: string): string {
  return new URL(`/r/${referralCode(owner)}`, accountUrl).href;
}

/** What a code's referrals have reached so far. */
export interface Referred {
  signed_up: number;
  used_a_tool: number;
  exported: number;
}

/** Who each code belongs to and who it brought, from the whole account list. */
export class Referrals {
  readonly #owner = new Map<string, string | null>();
  readonly #referred = new Map<string, Referred>();

  constructor(users: WorkosUser[]) {
    for (const u of users) {
      const code = referralCode(u.id);
      // Two accounts on one code (rare, at 40 bits): it names neither.
      this.#owner.set(code, this.#owner.has(code) ? null : u.id);
      const by = u.metadata?.referred_by;
      if (!by) continue;
      const row = this.#referred.get(by) ?? { signed_up: 0, used_a_tool: 0, exported: 0 };
      row.signed_up += 1;
      if (u.metadata?.first_tool_at) row.used_a_tool += 1;
      if (u.metadata?.first_export_at) row.exported += 1;
      this.#referred.set(by, row);
    }
  }

  /** The account a code belongs to, or null when none (or more than one) does. */
  owner(code: string): string | null {
    return this.#owner.get(code) ?? null;
  }

  /** The people a code brought. */
  referred(code: string): Referred {
    return { ...(this.#referred.get(code) ?? { signed_up: 0, used_a_tool: 0, exported: 0 }) };
  }
}
