import { describe, expect, it } from 'vitest';
import { clientName } from '../src/lifecycle.ts';

describe('the app an account is used from', () => {
  it('keeps the clientInfo name printable, trimmed and short', () => {
    expect(clientName('openai-mcp')).toBe('openai-mcp');
    expect(clientName('  claude-ai\n')).toBe('claude-ai');
    expect(clientName('x'.repeat(200))).toHaveLength(80);
    expect(clientName('\u0000\u0007')).toBeUndefined();
    expect(clientName(undefined)).toBeUndefined();
  });
});
