// backend/src/services/__test__/tag-normalize-2026-06-02.test.ts
//
// normalizeTag strips a trailing file extension from a catalog category before
// it is stamped into ProductIndex.tags. Regression: catalogUrls ending in
// `firearms.html` / `categories.php` produced tags like `ammunition.html`,
// which caused keyword tag-matches against the extension noise (false
// positives on mis-categorized rows). normalizeTag must NOT alter clean slugs
// (it is also applied to the API stream path where categories are already
// clean) and must return null for empty input so callers can skip tagging.
import { describe, it, expect } from 'vitest';
import { normalizeTag } from '../tag-normalize';

describe('normalizeTag', () => {
  it('strips a trailing .html / .htm extension', () => {
    expect(normalizeTag('firearms.html')).toBe('firearms');
    expect(normalizeTag('ammunition.htm')).toBe('ammunition');
  });

  it('strips a trailing .php extension', () => {
    expect(normalizeTag('categories.php')).toBe('categories');
  });

  it('strips a trailing .aspx / .asp extension', () => {
    expect(normalizeTag('optics.aspx')).toBe('optics');
    expect(normalizeTag('gear.asp')).toBe('gear');
  });

  it('is case-insensitive on the extension', () => {
    expect(normalizeTag('Firearms.HTML')).toBe('Firearms');
  });

  it('leaves a clean slug unchanged (no-op on API stream categories)', () => {
    expect(normalizeTag('firearms')).toBe('firearms');
    expect(normalizeTag('non-restricted')).toBe('non-restricted');
    expect(normalizeTag('7.62x39')).toBe('7.62x39'); // internal dot, no trailing ext
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeTag('  firearms.html  ')).toBe('firearms');
    expect(normalizeTag('  firearms  ')).toBe('firearms');
  });

  it('returns null for empty / whitespace-only / extension-only input', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('.html')).toBeNull();
  });

  it('only strips a single trailing extension, not internal segments', () => {
    // pagination junk is NOT stripped here — the trailing token isn't an
    // extension, so the value passes through (the cleanup script handles junk).
    expect(normalizeTag('firearms.htmlpage209')).toBe('firearms.htmlpage209');
  });
});
