import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEMOS } from '../content/demos.ts';
import { FIXES } from '../content/fixes.ts';
import { GUIDES, guidePath } from '../content/guides.ts';

// The answers answer engines quote: the fix answers and the guide answers. Each must read like a
// person wrote it (no filler words), be long enough to stand alone and short enough to quote, and
// every link it sends people to must be a page that exists.

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

const FILLER = [
  'seamless',
  'leverage',
  'whether you’re',
  "whether you're",
  'delve',
  'unlock',
  'elevate',
  'game-changer',
  'effortless',
  'robust',
  'cutting-edge',
  'in today’s',
  "in today's",
  'it’s important to note',
  "it's important to note",
];
/** A filler word at the start of a word, so "unlocks" and "seamlessly" count and "develop" doesn't. */
const fillerIn = (text: string) =>
  FILLER.filter((w) => new RegExp(`(^|[^\\p{L}])${w}`, 'iu').test(text));
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

const ANSWERS = [
  ...FIXES.map((f) => ({ where: `/fixes/${f.id}`, text: f.answer })),
  ...GUIDES.map((g) => ({ where: guidePath(g), text: g.answer })),
];

/** A path on the site: a demo, a guide, a fix, or a page under app/ with its own page file. */
function resolves(href: string): boolean {
  const path = href.replace(/[#?].*$/, '').replace(/\/$/, '') || '/';
  if (DEMOS.some((d) => `/demos/${d.slug}` === path)) return true;
  if (GUIDES.some((g) => guidePath(g) === path)) return true;
  if (FIXES.some((f) => `/fixes/${f.id}` === path)) return true;
  if (path.includes('[')) return false;
  return existsSync(join(APP, path, 'page.tsx'));
}

describe('answers', () => {
  it.each(ANSWERS)('$where has no filler words', ({ text }) => {
    expect(fillerIn(text)).toEqual([]);
  });

  it.each(ANSWERS)('$where is 25 to 90 words', ({ text }) => {
    expect(words(text)).toBeGreaterThanOrEqual(25);
    expect(words(text)).toBeLessThanOrEqual(90);
  });

  it('catches what it is meant to', () => {
    expect(fillerIn('Seamlessly unlock your edits')).toEqual(['seamless', 'unlock']);
    expect(fillerIn('Develop it, then export.')).toEqual([]);
    expect(resolves('/demos/no-such-demo')).toBe(false);
    expect(resolves('/pricing')).toBe(true);
  });
});

describe('links', () => {
  it.each(FIXES.filter((f) => f.see))('/fixes/$id links to a page that exists', (f) => {
    expect(resolves(f.see?.href ?? ''), f.see?.href).toBe(true);
  });

  it.each(GUIDES)('$slug shows demos that exist', (g) => {
    for (const slug of g.demos) expect(resolves(`/demos/${slug}`), slug).toBe(true);
  });

  it('relates every fix to three or four other fixes that exist', () => {
    for (const f of FIXES) {
      expect(f.related.length, f.id).toBeGreaterThanOrEqual(3);
      expect(f.related.length, f.id).toBeLessThanOrEqual(4);
      for (const id of f.related) {
        expect(id, f.id).not.toBe(f.id);
        expect(
          FIXES.some((x) => x.id === id),
          `${f.id} → ${id}`,
        ).toBe(true);
      }
    }
    expect(new Set(FIXES.map((f) => f.id)).size).toBe(FIXES.length);
  });
});
