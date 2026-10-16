import { describe, expect, it } from 'vitest';
import { alignWords } from '../src/index.ts';

const w = (text: string, start: number, end: number) => ({ text, start, end, confidence: 0.9 });

describe('alignWords', () => {
  it('keeps the text as given and takes times from what was heard', () => {
    const out = alignWords('Hello, world! It works.', [
      w('hello', 0, 0.4),
      w('world', 0.5, 0.9),
      w('it', 1.1, 1.2),
      w('works', 1.3, 1.7),
    ]);
    expect(out.map((x) => [x.text, x.start, x.end])).toEqual([
      ['Hello,', 0, 0.4],
      ['world!', 0.5, 0.9],
      ['It', 1.1, 1.2],
      ['works.', 1.3, 1.7],
    ]);
  });

  it('shares the time between heard neighbours for words the transcript missed or misheard', () => {
    const out = alignWords('We ship in 2026 for sure', [
      w('we', 0, 0.2),
      w('ship', 0.3, 0.6),
      w('in', 0.7, 0.8),
      w('twenty', 0.9, 1.2),
      w('twenty-six', 1.2, 1.6),
      w('for', 1.7, 1.8),
      w('sure', 1.9, 2.2),
    ]);
    expect(out.map((x) => x.text)).toEqual(['We', 'ship', 'in', '2026', 'for', 'sure']);
    const year = out[3];
    expect(year?.start).toBeGreaterThanOrEqual(0.8);
    expect(year?.end).toBeLessThanOrEqual(1.7);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]?.start).toBeGreaterThanOrEqual(out[i - 1]?.start ?? 0);
    }
  });

  it('spreads words over the sound when nothing was heard', () => {
    expect(alignWords('one two', [])).toEqual([
      { text: 'one', start: 0, end: 0, confidence: 0 },
      { text: 'two', start: 0, end: 0, confidence: 0 },
    ]);
  });
});
