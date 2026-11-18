import { describe, expect, it } from 'vitest';
import { readSource, sourceLabel, sourceOf } from '../app/source.tsx';

// The tags a tagged link leaves for the sign-up: what is kept, what is refused.

describe('source tags', () => {
  it('keeps source, campaign and content of a tagged link', () => {
    expect(sourceOf('?utm_source=reddit&utm_campaign=capcut&utm_content=bollywood')).toBe(
      'reddit~capcut~bollywood',
    );
  });

  it('keeps a link with only a source', () => {
    expect(sourceOf('?utm_source=Reddit')).toBe('reddit~~');
  });

  it('ignores a visit with no source, so the earlier one stays', () => {
    expect(sourceOf('?utm_campaign=capcut')).toBeUndefined();
    expect(sourceOf('')).toBeUndefined();
    expect(sourceOf('?utm_source=%21%21')).toBeUndefined();
  });

  it('reduces odd characters and long values', () => {
    expect(sourceOf('?utm_source=r/CapCut%20ads;x')).toBe('r-capcut-ads-x~~');
    expect(sourceOf(`?utm_source=${'a'.repeat(200)}`)).toBe(`${'a'.repeat(40)}~~`);
  });

  it('refuses a cookie value that is not well formed', () => {
    expect(readSource('reddit~capcut~bollywood')).toBe('reddit~capcut~bollywood');
    expect(readSource('reddit~~')).toBe('reddit~~');
    expect(readSource('~~')).toBeUndefined();
    expect(readSource('<script>~a~b')).toBeUndefined();
    expect(readSource('reddit')).toBeUndefined();
    expect(readSource(undefined)).toBeUndefined();
  });

  it('writes a label a person can read', () => {
    expect(sourceLabel('reddit~capcut~bollywood')).toBe('reddit / capcut / bollywood');
    expect(sourceLabel('reddit~~')).toBe('reddit');
  });
});
