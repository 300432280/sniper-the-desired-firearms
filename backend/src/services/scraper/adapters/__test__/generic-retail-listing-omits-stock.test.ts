// backend/src/services/scraper/adapters/__test__/generic-retail-listing-omits-stock.test.ts
//
// Regression for the per-site `listingOmitsStock` opt-in (generic-retail.ts
// extractCatalogProducts). Some listing themes expose NO stock signal on the
// card (gobles.ca lightspeed-ecom `.product-element`, northprosports.com
// opencart whose "Cart" button also renders for OOS items) → isInStock()
// returns undefined for every card → the default no-signal=OOS rule falsely
// flags the WHOLE catalog out_of_stock (gobles: 3371/3371). With the flag on,
// a no-signal card maps to 'unknown' (which product-upsert.ts treats as
// "don't touch stored stock" → zero false restock alerts). The flag MUST NOT
// change behavior for: (a) unflagged sites, or (b) cards with an EXPLICIT
// out-of-stock / disabled-cart signal.
import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { GenericRetailAdapter } from '../generic-retail';

const baseUrl = 'https://example.com/firearms';

// A card with NO stock signal at all: image + title + price + quickview only.
// Mirrors gobles.ca `.product-element` cards. isInStock() → undefined.
const noSignalCard = `
  <div class="product-element">
    <a class="product-image" href="/firearms/tikka-t3x-lite-308"><img src="/img/t3x.jpg"></a>
    <div class="product-title"><a href="/firearms/tikka-t3x-lite-308">Tikka T3X Lite 308 Winchester Rifle</a></div>
    <span class="price">$1,099.99</span>
  </div>`;

// A card with an EXPLICIT out-of-stock text signal. isInStock() → false.
const explicitOosCard = `
  <div class="product-element">
    <a class="product-image" href="/firearms/sako-90-bavarian-65"><img src="/img/sako.jpg"></a>
    <div class="product-title"><a href="/firearms/sako-90-bavarian-65">Sako 90 Bavarian 6.5 Creedmoor Rifle</a></div>
    <span class="price">$2,499.99</span>
    <span class="stock">Sold out</span>
  </div>`;

// A card with an EXPLICIT in-stock text signal. isInStock() → true.
const explicitInStockCard = `
  <div class="product-element">
    <a class="product-image" href="/firearms/cz-457-varmint-22lr"><img src="/img/cz457.jpg"></a>
    <div class="product-title"><a href="/firearms/cz-457-varmint-22lr">CZ 457 Varmint 22 LR Bolt Action Rifle</a></div>
    <span class="price">$799.99</span>
    <span class="availability">In stock</span>
  </div>`;

function extract(html: string, opts?: { listingOmitsStock?: boolean }) {
  const adapter = new GenericRetailAdapter();
  const $ = cheerio.load(`<html><body>${html}</body></html>`);
  return adapter.extractCatalogProducts($, baseUrl, opts);
}

function stockOf(html: string, opts?: { listingOmitsStock?: boolean }) {
  const products = extract(html, opts);
  expect(products.length).toBe(1);
  return products[0].stockStatus;
}

describe('GenericRetailAdapter.extractCatalogProducts — listingOmitsStock opt-in', () => {
  it('(a) flag OFF + no stock signal → out_of_stock (historical behavior unchanged)', () => {
    expect(stockOf(noSignalCard)).toBe('out_of_stock');
    expect(stockOf(noSignalCard, {})).toBe('out_of_stock');
    expect(stockOf(noSignalCard, { listingOmitsStock: false })).toBe('out_of_stock');
  });

  it('(b) flag ON + no stock signal → unknown (alert-safe, does not overwrite stored stock)', () => {
    expect(stockOf(noSignalCard, { listingOmitsStock: true })).toBe('unknown');
  });

  it('(c) explicit out-of-stock signal → out_of_stock regardless of flag', () => {
    expect(stockOf(explicitOosCard, { listingOmitsStock: false })).toBe('out_of_stock');
    expect(stockOf(explicitOosCard, { listingOmitsStock: true })).toBe('out_of_stock');
  });

  it('(d) explicit in-stock signal → in_stock regardless of flag', () => {
    expect(stockOf(explicitInStockCard, { listingOmitsStock: false })).toBe('in_stock');
    expect(stockOf(explicitInStockCard, { listingOmitsStock: true })).toBe('in_stock');
  });
});
