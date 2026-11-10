import { Workspace } from '@cuttingfloor/core';
import type { CfError } from '@cuttingfloor/schema';
import { describe, expect, it } from 'vitest';
import { type Access, AccessCheck, type Balance } from '../src/access.ts';
import { Ledger } from '../src/ledger.ts';

// What a refusal tells the AI, with WorkOS and the ledger answered here: text a ChatGPT user may read
// says what stopped and links the pricing page at most, never the account page where credits
// are bought.

const ACCOUNT = 'https://cuttingfloor.ai/account';

class Fixed extends AccessCheck {
  #access: Access;
  #balance: Partial<Balance>;
  constructor(access: Access, balance: Partial<Balance> = {}) {
    super({
      workosKey: 'sk_test_none',
      stripeKey: 'sk_test_none',
      ledger: new Ledger('http://127.0.0.1:9', 'none'),
      accountUrl: ACCOUNT,
      ws: new Workspace('/nonexistent'),
    });
    this.#access = access;
    this.#balance = balance;
  }
  override async get(): Promise<Access> {
    return this.#access;
  }
  override async balance(): Promise<Balance> {
    return {
      plan: 'free',
      left: 10,
      used: 0,
      free: 10,
      bought: 0,
      per_month: null,
      renews: null,
      refill: null,
      since: '2026-11-08T00:00:00Z',
      ...this.#balance,
    };
  }
}

const allowed: Access = {
  allowed: true,
  plan: 'free',
  email: 'a@example.com',
  created_at: '2026-11-08T00:00:00Z',
};

describe('access refusals', () => {
  it('sends an unverified account to its email, not the account page', async () => {
    const check = new Fixed({ allowed: false, reason: 'email_unverified', email: 'a@example.com' });
    const error = (await check.require('u').catch((e) => e)) as CfError;
    expect(error.code).toBe('email_unverified');
    expect(error.hint).toContain('verification email');
    expect(JSON.stringify(error)).not.toContain('/account');
  });

  it('refuses new jobs at 0 credits, says editing still works, and links only the pricing page', async () => {
    const limits = await new Fixed(allowed, { left: 0, used: 10 }).limits('u');
    const refusal = limits.refuseJobs;
    expect(refusal?.code).toBe('quota_exceeded');
    expect(refusal?.hint).toContain("won't start until there are credits again");
    expect(refusal?.hint).toContain('previews still work');
    expect(refusal?.hint).not.toMatch(/\bwait\b/);
    expect(refusal?.hint).toContain('https://cuttingfloor.ai/pricing');
    expect(JSON.stringify({ ...refusal, limits })).not.toContain('/account');
  });
});
