import { describe, expect, it } from 'vitest';
import { demoPlace, KAZI_LINKS } from '../app/kazi.tsx';
import { DEMOS } from '../content/demos.ts';

// Every "Try it live in Kazi" link opens a real Kazi share link, and every demo has its own.
describe('Kazi share links', () => {
  it('has a code for every place', () => {
    for (const [place, code] of Object.entries(KAZI_LINKS)) {
      expect(code, place).toMatch(/^[\w-]+$/);
    }
  });

  it('gives every demo its own place', () => {
    for (const d of DEMOS) expect(demoPlace(d.id)).toBe(`demo-${d.id}`);
  });
});
