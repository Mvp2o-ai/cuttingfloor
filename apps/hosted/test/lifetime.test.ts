import { describe, expect, it } from 'vitest';
import type { Access } from '../src/access.ts';
import { clientName, lifetimeFor } from '../src/lifecycle.ts';

// Who gets lifetime when they use cuttingfloor through a client that grants it (Kazi). The WorkOS
// write itself runs against the real WorkOS in scripts/smoke-account.ts.

const email = 'someone@example.com';
const base = { email, created_at: '2026-10-01T00:00:00.000Z' };

describe('lifetime through a client', () => {
  it('gives it to a free account and an unverified one', () => {
    const free: Access = { allowed: true, plan: 'free', ...base };
    expect(lifetimeFor({}, free)).toBe('give');
    expect(lifetimeFor({}, { allowed: false, reason: 'email_unverified', email })).toBe('give');
  });

  it('leaves a plan already given alone', () => {
    const staff: Access = { allowed: true, plan: 'staff', ...base };
    expect(lifetimeFor({ plan: 'admin' }, staff)).toBe('tagged');
    expect(lifetimeFor({ plan: 'lifetime', plan_reason: 'via Kazi' }, staff)).toBe('tagged');
    expect(lifetimeFor({ plan: 'enterprise' }, staff)).toBe('tagged');
  });

  it('leaves an account that bought credits with them', () => {
    expect(lifetimeFor({}, { allowed: true, plan: 'credits', ...base })).toBe('paying');
  });
});

describe('the app an account is used from', () => {
  it('keeps the clientInfo name printable, trimmed and short', () => {
    expect(clientName('openai-mcp')).toBe('openai-mcp');
    expect(clientName('  claude-ai\n')).toBe('claude-ai');
    expect(clientName('x'.repeat(200))).toHaveLength(80);
    expect(clientName('\u0000\u0007')).toBeUndefined();
    expect(clientName(undefined)).toBeUndefined();
  });
});
