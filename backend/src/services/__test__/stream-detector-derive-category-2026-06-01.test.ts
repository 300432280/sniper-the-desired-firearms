// backend/src/services/__test__/stream-detector-derive-category-2026-06-01.test.ts
//
// Regression: northprosports.com (OpenCart) has 6 catalogUrls that all route
// through `/index.php?route=product/category&path=NN`. deriveCategoryFromUrl()
// previously inspected only URL.pathname (= "/index.php") for ALL six, so they
// collided on the id "index.php" and detectStreams()'s seenIds dedup dropped 5
// of 6 — leaving ~1,750 products (ammo/reloading/optics/archery/hunting) never
// crawled. Fix: when the pathname yields a generic id, fold a discriminating
// category query param (path/cat/category/...) into the stream id.
//
// Backward-compat guard: catalogUrls whose pathname ALREADY yields a unique,
// meaningful category id (/firearms/, /ammunition/) MUST keep that exact id, or
// existing sites' streamState progress would be orphaned.
import { describe, it, expect } from 'vitest';
import { deriveCategoryFromUrl } from '../stream-detector';

describe('deriveCategoryFromUrl', () => {
  it('gives the 6 northprosports index.php?path=NN catalogUrls distinct stream ids', () => {
    const base = 'https://northprosports.com/index.php?route=product/category';
    const paths = [28, 766, 267, 552, 45, 400];
    const ids = paths.map(p => deriveCategoryFromUrl(`${base}&path=${p}`));

    // All defined
    expect(ids.every(id => typeof id === 'string' && id!.length > 0)).toBe(true);
    // All distinct — this is the bug: previously all === "index.php"
    expect(new Set(ids).size).toBe(6);
    // And the discriminator is the path value, not a hash
    expect(ids).toEqual([
      'index.php-28', 'index.php-766', 'index.php-267',
      'index.php-552', 'index.php-45', 'index.php-400',
    ]);
  });

  it('REGRESSION: meaningful pathname-derived ids are unchanged (no query-param fold)', () => {
    // These IDs are what existing sites' streamState is keyed on. They must NOT shift.
    expect(deriveCategoryFromUrl('https://x.com/firearms/')).toBe('firearms');
    expect(deriveCategoryFromUrl('https://x.com/ammunition/')).toBe('ammunition');
    expect(deriveCategoryFromUrl('https://x.com/product-category/firearms/')).toBe('firearms');
    expect(deriveCategoryFromUrl('https://x.com/firearms/rifles/')).toBe('firearms-rifles');
    // Meaningful pathname WITH a trailing query param: the query is ignored
    // because the pathname id is already unique (e.g. sort/pagination params).
    expect(deriveCategoryFromUrl('https://x.com/firearms/?orderby=date')).toBe('firearms');
    expect(deriveCategoryFromUrl('https://x.com/firearms/?page=2&path=99')).toBe('firearms');
  });

  it('handles other generic endpoints and query-param precedence', () => {
    // path takes precedence over cat
    expect(deriveCategoryFromUrl('https://x.com/shop?cat=5&path=9')).toBe('shop-9');
    // cat when path absent
    expect(deriveCategoryFromUrl('https://x.com/index.php?cat=ammo')).toBe('index.php-ammo');
    // cPath (osCommerce-style)
    expect(deriveCategoryFromUrl('https://x.com/catalog?cPath=23')).toBe('catalog-23');
    // category_id
    expect(deriveCategoryFromUrl('https://x.com/store?category_id=7')).toBe('store-7');
  });

  it('falls back to a stable querystring hash when a generic path has no known category param', () => {
    const a = deriveCategoryFromUrl('https://x.com/index.php?route=product/special&foo=1');
    const b = deriveCategoryFromUrl('https://x.com/index.php?route=product/special&foo=2');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);          // distinct querystrings → distinct ids
    expect(a).toMatch(/^index\.php-/); // keeps the base id prefix
    // Stable: same input → same output
    expect(deriveCategoryFromUrl('https://x.com/index.php?route=product/special&foo=1')).toBe(a);
  });

  it('returns undefined for unparseable urls', () => {
    expect(deriveCategoryFromUrl('not a url')).toBeUndefined();
  });
});
