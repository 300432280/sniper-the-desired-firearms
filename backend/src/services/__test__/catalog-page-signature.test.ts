// backend/src/services/__test__/catalog-page-signature.test.ts
//
// FIX 2 — out-of-range / repeat-page detection. Odoo (and others) return page-1
// content for overflow pages WITH products, so the walk never sees 0 products
// and loops forever. We end the stream when a page's signature
// (firstURL|lastURL|count) repeats the previous page's. The lastURL component
// prevents a false positive on legit catalogs that pin a featured product to
// position 0 of every page (those differ in the tail).
import { describe, it, expect } from 'vitest';
import { pageSignature, isRepeatPage } from '../catalog-page-signature';

const page = (...urls: string[]) => urls.map((url) => ({ url }));

describe('pageSignature / isRepeatPage (FIX 2)', () => {
  it('first page is never a repeat (prev = null)', () => {
    const sig = pageSignature(page('/p/a', '/p/b', '/p/c'));
    expect(isRepeatPage(null, sig)).toBe(false);
  });

  it('flags an identical-end-to-end overflow page (same first, last AND count) as a repeat', () => {
    const p1 = pageSignature(page('/p/a', '/p/b', '/p/c'));
    const overflow = pageSignature(page('/p/a', '/p/b', '/p/c')); // page-1 served again
    expect(isRepeatPage(p1, overflow)).toBe(true);
  });

  it('does NOT flag a pinned-featured legit next page (same first URL + count, different tail)', () => {
    // WooCommerce/Shopify "featured first": product /p/feat is pinned to slot 0
    // of every page, and both pages are full (count 3), but the rest differs.
    const p2 = pageSignature(page('/p/feat', '/p/b', '/p/c'));
    const p3 = pageSignature(page('/p/feat', '/p/d', '/p/e'));
    expect(isRepeatPage(p2, p3)).toBe(false); // must NOT truncate the catalog
  });

  it('does NOT flag a genuinely different next page', () => {
    const p1 = pageSignature(page('/p/a', '/p/b', '/p/c'));
    const p2 = pageSignature(page('/p/d', '/p/e', '/p/f'));
    expect(isRepeatPage(p1, p2)).toBe(false);
  });

  it('distinguishes by count even when the first URL matches (partial last page)', () => {
    const full = pageSignature(page('/p/a', '/p/b', '/p/c'));
    const shorter = pageSignature(page('/p/a', '/p/b')); // same first URL, fewer items
    expect(isRepeatPage(full, shorter)).toBe(false);
  });

  it('distinguishes by first URL even when counts match', () => {
    const a = pageSignature(page('/p/a', '/p/b'));
    const b = pageSignature(page('/p/x', '/p/y')); // same count, different first URL
    expect(isRepeatPage(a, b)).toBe(false);
  });

  it('never treats a zero-products signature as a repeat (empty page handled by caller)', () => {
    const empty = pageSignature(page()); // '||0'
    expect(empty).toBe('||0');
    expect(isRepeatPage(empty, empty)).toBe(false);
  });
});
