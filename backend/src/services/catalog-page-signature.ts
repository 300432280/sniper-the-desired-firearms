// backend/src/services/catalog-page-signature.ts
//
// Pure helpers for the out-of-range / repeat-page guard in the catalog stream
// walk (FIX 2). Some platforms (e.g. Odoo) silently return page-1 content for
// out-of-range pages instead of an empty page, so the walk never sees 0
// products and loops forever. We detect a repeat by comparing each page's
// signature to the previous page's.
//
// The signature is firstURL|lastURL|count. The LAST url is load-bearing: a real
// Odoo overflow page serves page-1 content end-to-end (first AND last AND count
// all identical), but a legitimately-paginated catalog that PINS a featured /
// sticky product to position 0 of every page (WooCommerce/Shopify "featured
// first" sorts) shares the same first URL and count across pages yet differs in
// its tail — so including lastURL stops us from silently truncating those.
//
// Extracted as a pure module so the dupe-detection logic can be unit-tested
// without running the live crawler.

/** Build an identity signature for a page of catalog products. */
export function pageSignature(products: Array<{ url: string }>): string {
  const first = products[0]?.url ?? '';
  const last = products[products.length - 1]?.url ?? '';
  return `${first}|${last}|${products.length}`;
}

/**
 * True when the current page is an exact repeat of the previous page — i.e. an
 * out-of-range/overflow page serving page-1 content. `prev` is null on the
 * first page of a stream (never a repeat). An empty/zero-products signature
 * (`||0`) never counts as a repeat — empty pages are handled by the caller's
 * end-of-catalog logic, not this guard.
 */
export function isRepeatPage(prev: string | null, current: string): boolean {
  if (prev === null) return false;
  if (current === '||0') return false;
  return prev === current;
}
