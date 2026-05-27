// backend/src/services/__test__/profile-validator-urlshape-2026-05-25.test.ts
//
// C7 (batch-5 R3 frontierfirearms): sitemap-shape productCountMethod entries
// require path-only `url` / `urls[]`. An absolute URL here produces a
// double-prefix at runtime (`${origin}${m.url}`) and silently returns null,
// disabling the coverage gate via the `verifyBootstrapCoverage` ratio=null
// branch. This new required-severity check rejects the bad shape at promote
// time.
import { describe, it, expect } from 'vitest';
import { validateSiteProfile } from '../profile-validator';

function baseProfile(): any {
  return {
    platform: 'woocommerce',
    hasWaf: false,
    expectedProductCount: 100,
    catalogUrls: ['/shop/'],
    paginationPattern: { type: 'query', template: '?page={N}' },
    perPage: 24,
    adapterType: 'woocommerce',
    sortParam: '?orderby=date',
    crawlers: {
      watermark: { method: 'api-date-since-watermark' },
      maintain: { verifyMethod: 'detail-page' },
    },
    productCountMethod: { method: 'sitemap', url: '/sitemap_products.xml' },
  };
}

describe('validateSiteProfile -- productCountMethod.urlShape (C7, batch-5 R3)', () => {
  it('rejects sitemap method with absolute https URL', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'sitemap', url: 'https://example.com/sitemap.xml' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape');
    expect(failure).toBeDefined();
    expect(failure?.severity).toBe('required');
    expect(failure?.message).toMatch(/path-only/i);
  });

  it('rejects sitemap method with absolute http URL', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'sitemap', url: 'http://example.com/sitemap.xml' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('rejects sitemap method with protocol-relative URL', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'sitemap', url: '//example.com/sitemap.xml' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('rejects sitemap method with missing leading slash', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'sitemap', url: 'sitemap.xml' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('accepts sitemap method with path-only URL', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'sitemap', url: '/sitemap.xml' };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('accepts generic-product-sitemap method with path-only URL', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'generic-product-sitemap', url: '/webapp/wcs/stores/servlet/sitemap_10151.xml.gz', pattern: '/p/' };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('rejects generic-product-sitemap method with absolute URL', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'generic-product-sitemap', url: 'https://example.com/sitemap.xml', pattern: '/p/' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('rejects sitemap-index missing urls array', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'sitemap-index' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('rejects sitemap-index with empty urls array', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'sitemap-index', urls: [] };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('rejects sitemap-index with any absolute URL in urls[]', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'sitemap-index',
      urls: ['/sitemap1.xml', 'https://example.com/sitemap2.xml'],
    };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('accepts sitemap-index with all path-only URLs', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'sitemap-index',
      urls: ['/sitemap1.xml', '/sitemap2.xml', '/sitemap_products.xml'],
    };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('does not apply the urlShape check to non-sitemap methods (wp-rest-header)', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'wp-rest-header',
      endpoint: '/wp-json/wp/v2/product',
      header: 'x-wp-total',
    };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('does not apply the urlShape check when productCountMethod is absent', () => {
    const p = baseProfile();
    delete p.productCountMethod;
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });
});

// ── Adversarial-round-1 (2026-05-25): the original C7 missed wp-rest-header,
//   json-api-*, html-pagination, and shopify-products-walk -- all of which
//   the runtime concatenates with ${origin}. Same silent-null risk as the
//   sitemap shapes. These tests close that gap.
describe('validateSiteProfile -- productCountMethod.urlShape (extended coverage, adv-round-1)', () => {
  it('rejects wp-rest-header with absolute endpoint URL', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'wp-rest-header',
      endpoint: 'https://example.com/wp-json/wp/v2/product',
      header: 'x-wp-total',
    };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('accepts wp-rest-header with path-only endpoint', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'wp-rest-header',
      endpoint: '/wp-json/wp/v2/product',
      header: 'x-wp-total',
    };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('rejects json-api-count with absolute endpoint', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'json-api-count',
      endpoint: 'https://example.com/api/count',
      field: 'totalResults',
    };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('rejects json-api-length with missing leading slash', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'json-api-length',
      endpoint: 'api/products',
      field: 'data',
      perPage: 50,
    };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('rejects html-pagination with absolute url when url is present', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'html-pagination',
      url: 'https://example.com/shop/',
      selector: '.pagination .last',
      perPage: 24,
    };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('accepts html-pagination with no url (defaults to origin at runtime)', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'html-pagination',
      selector: '.pagination .last',
      perPage: 24,
    };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('accepts html-pagination with path-only url', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'html-pagination',
      url: '/shop/',
      selector: '.pagination .last',
      perPage: 24,
    };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('rejects shopify-products-walk with absolute endpoint when endpoint is present', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'shopify-products-walk',
      endpoint: 'https://example.com/products.json',
    };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('accepts shopify-products-walk with no endpoint (defaults to /products.json at runtime)', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'shopify-products-walk' };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('does NOT apply path-only check to ecwid-storefront-search (uses full absolute URL by design)', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'ecwid-storefront-search',
      endpoint: 'https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/12345/catalog/search',
    };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  // Adversarial-round-2 (2026-05-25): mirror-image check -- ecwid/klevu post the
  // endpoint AS-IS (no origin concat) so a path-only value throws at runtime and
  // silently disables the coverage gate.
  it('rejects ecwid-storefront-search with path-only endpoint (must be absolute)', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'ecwid-storefront-search',
      endpoint: '/storefront/api/v1/12345/catalog/search',
    };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape');
    expect(failure).toBeDefined();
    expect(failure?.message).toMatch(/absolute URL/i);
  });

  it('rejects ecwid-storefront-search with missing endpoint', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'ecwid-storefront-search' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('rejects klevu-api-count with path-only endpoint', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'klevu-api-count',
      endpoint: '/api/search',
      apiKey: 'klevu-1234',
    };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'productCountMethod.urlShape')).toBeDefined();
  });

  it('accepts klevu-api-count with absolute endpoint', () => {
    const p = baseProfile();
    p.productCountMethod = {
      method: 'klevu-api-count',
      endpoint: 'https://eucs9.ksearchnet.com/cloud-search/n-search/search',
      apiKey: 'klevu-1234',
    };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'productCountMethod.urlShape' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });
});

// C8 (adv-round-3 2026-05-25 tommyenterprises.com): path-style pagination
// templates must NOT redundantly start with a catalogUrl path segment, or the
// runtime URL builder at catalog-crawler.ts:118-125 produces duplicate-segment
// URLs (e.g. catalogUrl=/shop/ + template=/shop/page/{N}/ produces
// /shop/shop/page/2/ which 404s).
describe('validateSiteProfile -- paginationPattern.templateRedundantCatalogPrefix (C8)', () => {
  it('rejects /shop/page/{N}/ template when catalogUrl is /shop/', () => {
    const p = baseProfile();
    p.catalogUrls = ['/shop/'];
    p.paginationPattern = { type: 'path', template: '/shop/page/{N}/' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    const failure = r.failed.find(f => f.field === 'paginationPattern.templateRedundantCatalogPrefix');
    expect(failure).toBeDefined();
    expect(failure?.severity).toBe('required');
    expect(failure?.message).toMatch(/duplicate-segment/i);
  });

  it('rejects /firearms/page/{N}/ template when catalogUrl is /firearms/', () => {
    const p = baseProfile();
    p.catalogUrls = ['/firearms/'];
    p.paginationPattern = { type: 'path', template: '/firearms/page/{N}/' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'paginationPattern.templateRedundantCatalogPrefix')).toBeDefined();
  });

  it('accepts /page/{N}/ template (no catalog prefix) with /shop/ catalogUrl', () => {
    const p = baseProfile();
    p.catalogUrls = ['/shop/'];
    p.paginationPattern = { type: 'path', template: '/page/{N}/' };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'paginationPattern.templateRedundantCatalogPrefix' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('rejects when ANY of multiple catalogUrls has the redundant prefix', () => {
    const p = baseProfile();
    p.catalogUrls = ['/firearms/', '/ammunition/'];
    p.paginationPattern = { type: 'path', template: '/firearms/page/{N}/' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'paginationPattern.templateRedundantCatalogPrefix')).toBeDefined();
  });

  it('accepts root-only catalogUrl with any path-style template', () => {
    const p = baseProfile();
    p.catalogUrls = ['/'];
    p.paginationPattern = { type: 'path', template: '/page/{N}/' };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'paginationPattern.templateRedundantCatalogPrefix' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('does not apply to query-style pagination', () => {
    const p = baseProfile();
    p.catalogUrls = ['/shop/'];
    p.paginationPattern = { type: 'query', template: 'page' };
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'paginationPattern.templateRedundantCatalogPrefix' && f.severity === 'required');
    expect(failure).toBeUndefined();
  });

  it('handles absolute catalogUrls correctly', () => {
    const p = baseProfile();
    p.catalogUrls = ['https://example.com/shop/'];
    p.paginationPattern = { type: 'path', template: '/shop/page/{N}/' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'paginationPattern.templateRedundantCatalogPrefix')).toBeDefined();
  });
});
