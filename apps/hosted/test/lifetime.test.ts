import { describe, expect, it } from 'vitest';
import type { Access } from '../src/access.ts';
import { lifetimeFor } from '../src/lifecycle.ts';

// Who gets lifetime when they use cuttingfloor through a client that grants it (Kazi). The WorkOS
// write itself runs against the real WorkOS in scripts/smoke-account.ts.

const period = { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' };
const email = 'someone@example.com';

describe('lifetime through a client', () => {
  it('gives it to a trial, an ended trial and an unverified account', () => {
    const trial: Access = { allowed: true, plan: 'trial', period, email };
    expect(lifetimeFor({}, trial)).toBe('give');
    expect(lifetimeFor({}, { allowed: false, reason: 'trial_ended', email })).toBe('give');
    expect(lifetimeFor({}, { allowed: false, reason: 'email_unverified', email })).toBe('give');
  });

  it('leaves a plan already given alone', () => {
    const staff: Access = { allowed: true, plan: 'staff', period, email };
    expect(lifetimeFor({ plan: 'admin' }, staff)).toBe('tagged');
    expect(lifetimeFor({ plan: 'lifetime', plan_reason: 'via Kazi' }, staff)).toBe('tagged');
    expect(lifetimeFor({ plan: 'enterprise' }, staff)).toBe('tagged');
  });

  it('leaves an account that pays, or did until a payment failed, on its plan', () => {
    expect(lifetimeFor({}, { allowed: true, plan: 'pro', period, email })).toBe('paying');
    expect(lifetimeFor({}, { allowed: true, plan: 'creator', period, email })).toBe('paying');
    expect(lifetimeFor({}, { allowed: false, reason: 'payment_failed', email })).toBe('paying');
  });
});
