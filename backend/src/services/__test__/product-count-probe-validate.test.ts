// backend/src/services/__test__/product-count-probe-validate.test.ts
//
// Fix 4: schema validator for ProductCountMethod.
//
// Previously, an unknown / drifted `method` value (e.g. 'dual-api', a typo,
// or a profile field nobody updated when methods were renamed) hit the
// switch's `default` branch and returned null silently. The new
// `validateMethod` function rejects unknown methods upfront with a clear
// error message naming the offending value.
import { describe, it, expect } from 'vitest';
import { validateMethod, VALID_METHOD_NAMES } from '../product-count-probe';

describe('validateMethod (Fix 4)', () => {
  it('throws on unknown method names', () => {
    expect(() => validateMethod({ method: 'dual-api' } as any))
      .toThrow(/unknown product-count method.*dual-api/i);
  });

  it('throws when method field is missing entirely', () => {
    expect(() => validateMethod({} as any))
      .toThrow(/unknown product-count method/i);
  });

  it('does not throw for any of the 11 canonical method names', () => {
    for (const name of VALID_METHOD_NAMES) {
      // sitemap-index requires a non-empty urls[] to be valid (B2 2026-06-02);
      // supply one so this test asserts name-recognition, not shape completeness.
      const m = name === 'sitemap-index' ? { method: name, urls: ['/sitemap1.xml'] } : { method: name };
      expect(() => validateMethod(m as any)).not.toThrow();
    }
  });

  it('throws for sitemap-index without a non-empty urls[] (B2 — legacy {sitemapUrl} shape)', () => {
    expect(() => validateMethod({ method: 'sitemap-index' } as any)).toThrow(/non-empty urls\[\] array/i);
    expect(() => validateMethod({ method: 'sitemap-index', urls: [] } as any)).toThrow(/non-empty urls\[\] array/i);
    expect(() => validateMethod({ method: 'sitemap-index', sitemapUrl: '/x', subSitemapPattern: '?p={N}' } as any)).toThrow(/non-empty urls\[\] array/i);
  });

  it('exposes exactly the 11 canonical method names', () => {
    expect(VALID_METHOD_NAMES.slice().sort()).toEqual([
      'ecwid-storefront-search',
      'generic-product-sitemap',
      'html-pagination',
      'json-api-count',
      'json-api-length',
      'klevu-api-count',
      'shopify-products-walk',
      'sitemap',
      'sitemap-index',
      'stream-page-count',
      'wp-rest-header',
    ]);
  });
});

// ── Batch-5 R4 C1: sitemap.url and sitemap-index.urls[] MUST be path-only ──
//
// product-count-probe.ts:233 prepends `${origin}${m.url}`. When `m.url` is
// absolute (e.g. "https://frontierfirearms.ca/sitemap.xml"), the result is
// "https://frontierfirearms.cahttps://frontierfirearms.ca/sitemap.xml" —
// fetch fails, expectedCount becomes null, the coverage gate silently passes.
// Live caught on frontierfirearms.ca R3 (2026-05-22). Reject at validateMethod
// so the failure is loud at promote time, not silent at runtime.
describe('validateMethod — sitemap path-only URL (C1, batch-5 R4)', () => {
  it('throws on sitemap with absolute http URL', () => {
    expect(() =>
      validateMethod({ method: 'sitemap', url: 'http://example.com/sitemap.xml' } as any)
    ).toThrow(/path-only|start with \//i);
  });

  it('throws on sitemap with absolute https URL', () => {
    expect(() =>
      validateMethod({ method: 'sitemap', url: 'https://frontierfirearms.ca/sitemap.xml' } as any)
    ).toThrow(/path-only|start with \//i);
  });

  it('accepts sitemap with path-only URL', () => {
    expect(() =>
      validateMethod({ method: 'sitemap', url: '/sitemap_products.xml' } as any)
    ).not.toThrow();
  });

  it('throws on sitemap-index when ANY entry in urls[] is absolute', () => {
    expect(() =>
      validateMethod({
        method: 'sitemap-index',
        urls: [
          '/media/sitemaps/sitemap_product_001.xml',
          'https://store.example.com/sitemap_product_002.xml',
        ],
      } as any)
    ).toThrow(/path-only|start with \//i);
  });

  it('accepts sitemap-index when ALL entries are path-only', () => {
    expect(() =>
      validateMethod({
        method: 'sitemap-index',
        urls: [
          '/media/sitemaps/sitemap_product_001.xml',
          '/media/sitemaps/sitemap_product_002.xml',
        ],
      } as any)
    ).not.toThrow();
  });
});

// ── Batch-5 R4 C2: close-match suggestion in error message ──────────────────
//
// Operators keep writing `wc-store-api-header` (DB on thegundealer.ca, audit
// history). It is NOT in VALID_METHOD_NAMES — `wp-rest-header` is the canonical
// name and Store API ≠ WP REST surfaces, so the alias decision is REJECT.
// Improve the error message with a "did you mean wp-rest-header?" suggestion
// so the operator fixes the profile without diving into source.
describe('validateMethod — close-match suggestion (C2, batch-5 R4)', () => {
  it('rejects wc-store-api-header with a "did you mean wp-rest-header?" hint', () => {
    expect(() =>
      validateMethod({ method: 'wc-store-api-header' } as any)
    ).toThrow(/did you mean.*wp-rest-header/i);
  });

  it('rejects wp_rest_header (underscores) with a "did you mean wp-rest-header?" hint', () => {
    expect(() =>
      validateMethod({ method: 'wp_rest_header' } as any)
    ).toThrow(/did you mean.*wp-rest-header/i);
  });

  it('still throws unknown-method on a wildly different name (no spurious suggestion)', () => {
    expect(() =>
      validateMethod({ method: 'totally-fake-method' } as any)
    ).toThrow(/unknown product-count method/i);
  });
});
