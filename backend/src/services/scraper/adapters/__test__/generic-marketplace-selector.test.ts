// backend/src/services/scraper/adapters/__test__/generic-marketplace-selector.test.ts
//
// Batch-6 R4 B2 #1: generic.ts:91-130 extractCatalogProducts was missing the
// `a[href*="/marketplace/"]` selector that generic-retail.ts:964 already has.
// Townpost.ca (Next.js classifieds, anchor-wrapped cards) returned 0 products
// when routed through the `generic` adapter even though pages have ~62
// marketplace anchors. The numeric trailing-segment ID
// (e.g. /marketplace/calgary/guns/foo/1171321 → "1171321") must also be
// extracted so downstream ProductIndex rows have a stable sourceId.
import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { GenericAdapter } from '../generic';

describe('GenericAdapter.extractCatalogProducts — marketplace anchor selector', () => {
  const adapter = new GenericAdapter();

  it('extracts anchor-wrapped marketplace cards with numeric trailing-segment IDs', () => {
    const html = `
      <html><body>
        <ul class="results">
          <li>
            <a href="/marketplace/calgary/guns/sample-rifle/1171321">
              <h3 class="product-title">Sample Rifle Title For Sale</h3>
              <span class="price">$1,299.00</span>
            </a>
          </li>
          <li>
            <a href="/marketplace/edmonton/optics/scope-listing/1234567">
              <h3 class="product-title">Sample Scope Listing With Reticle</h3>
              <span class="price">$450.00</span>
            </a>
          </li>
        </ul>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const baseUrl = 'https://townpost.ca/listings';
    const products = adapter.extractCatalogProducts($, baseUrl);

    expect(products.length).toBeGreaterThanOrEqual(2);
    const byId = new Map(products.map(p => [p.sourceId, p]));

    const p1 = byId.get('1171321');
    expect(p1).toBeDefined();
    expect(p1!.url).toBe('https://townpost.ca/marketplace/calgary/guns/sample-rifle/1171321');
    expect(p1!.title).toMatch(/Sample Rifle Title/);

    const p2 = byId.get('1234567');
    expect(p2).toBeDefined();
    expect(p2!.url).toBe('https://townpost.ca/marketplace/edmonton/optics/scope-listing/1234567');
  });

  it('extracts each marketplace anchor only once when the selector matches multiple times', () => {
    // Sanity check on dedup via the `seen` URL Set: even if our new selector
    // overlaps with a future card-class selector, the same URL should produce
    // a single product row.
    const html = `
      <div>
        <a href="/marketplace/calgary/guns/foo/9999991">
          <h3 class="product-title">Unique Marketplace Listing One</h3>
        </a>
        <a href="/marketplace/calgary/guns/foo/9999991">
          <h3 class="product-title">Unique Marketplace Listing One</h3>
        </a>
      </div>
    `;
    const $ = cheerio.load(html);
    const products = adapter.extractCatalogProducts($, 'https://townpost.ca/');
    const uniq = products.filter(p => p.url.endsWith('/9999991'));
    expect(uniq.length).toBe(1);
    expect(uniq[0].sourceId).toBe('9999991');
  });
});
