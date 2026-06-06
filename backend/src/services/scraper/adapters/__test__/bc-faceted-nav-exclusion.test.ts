// backend/src/services/scraper/adapters/__test__/bc-faceted-nav-exclusion.test.ts
//
// Fix 1 (2026-06-05): BigCommerce Stencil faceted-navigation URLs were being
// indexed as products. truenortharms.com had 364 active ProductIndex rows titled
// "Brakes"/"Muzzle Devices" etc. with URLs like
//   /ar-15-parts/muzzle-devices/brakes.html?_bc_fsnf=1&brand=252
// These are category pages filtered by a brand facet, NOT products (null
// thumbnail, null sourceId). isNavUrl() now rejects any URL carrying the BC
// `_bc_fsnf=` faceted-search-nav param, while real product URLs are kept.
import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { GenericRetailAdapter } from '../generic-retail';

describe('BigCommerce faceted-nav exclusion (_bc_fsnf)', () => {
  const adapter = new GenericRetailAdapter();

  it('excludes _bc_fsnf faceted-nav cards but keeps real product cards', () => {
    const html = `
      <html><body>
        <div class="card">
          <h4 class="card-title">
            <a href="/ar-15-parts/muzzle-devices/brakes.html?_bc_fsnf=1&brand=252">Brakes</a>
          </h4>
        </div>
        <div class="card">
          <h4 class="card-title">
            <a href="/ar-15-parts/muzzle-devices/brakes.html?_bc_fsnf=1&is_featured=1">Brakes</a>
          </h4>
        </div>
        <div class="card" data-product-id="55501">
          <h4 class="card-title">
            <a href="/some-real-muzzle-brake-9mm/">Real Muzzle Brake 9mm Threaded</a>
          </h4>
          <img class="card-image" src="https://cdn.example.com/products/1/2/img.jpg" />
          <span class="price--withoutTax">$129.99</span>
        </div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const products = adapter.extractCatalogProducts($, 'https://www.truenortharms.com/ar-15-parts/muzzle-devices/');

    const faceted = products.filter((p) => /_bc_fsnf=/.test(p.url));
    expect(faceted.length).toBe(0);

    const real = products.filter((p) => /real-muzzle-brake/.test(p.url));
    expect(real.length).toBe(1);
    expect(real[0].title).toMatch(/Real Muzzle Brake/);
  });

  it('keeps a real product URL that legitimately carries an unrelated query param', () => {
    const html = `
      <div class="card" data-product-id="900">
        <h4 class="card-title">
          <a href="/optic-mount-30mm/?variant=blue">30mm Optic Mount Picatinny</a>
        </h4>
        <img class="card-image" src="https://cdn.example.com/products/3/4/m.jpg" />
        <span class="price--withoutTax">$79.99</span>
      </div>
    `;
    const $ = cheerio.load(html);
    const products = adapter.extractCatalogProducts($, 'https://www.truenortharms.com/optics/');
    const kept = products.filter((p) => /optic-mount-30mm/.test(p.url));
    expect(kept.length).toBe(1);
  });
});
