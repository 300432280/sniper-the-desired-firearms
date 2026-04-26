import { describe, it, expect } from 'vitest';
import { isLikelyProductUrl, parseSitemapXml } from '../sitemap-parse';

describe('isLikelyProductUrl', () => {
  it('matches BC Stencil product URL pattern', () => {
    expect(isLikelyProductUrl('https://example.com/some-product-slug-1234/')).toBeTruthy();
  });
  it('matches Magento product URL pattern', () => {
    expect(isLikelyProductUrl('https://example.com/catalog/product/view/id/123/s/slug/')).toBeTruthy();
  });
  it('matches CS-Cart _p_NN.html', () => {
    expect(isLikelyProductUrl('https://example.com/some-cat/some-product_p_25.html')).toBeTruthy();
  });
  it('rejects category URL', () => {
    expect(isLikelyProductUrl('https://example.com/product-category/firearms/')).toBe(false);
    expect(isLikelyProductUrl('https://example.com/category/handguns/')).toBe(false);
  });
  it('rejects nav URL', () => {
    expect(isLikelyProductUrl('https://example.com/about-us/')).toBe(false);
    expect(isLikelyProductUrl('https://example.com/contact/')).toBe(false);
    expect(isLikelyProductUrl('https://example.com/blog/post-1/')).toBe(false);
    expect(isLikelyProductUrl('https://example.com/feed/')).toBe(false);
    expect(isLikelyProductUrl('https://example.com/wp-content/uploads/foo')).toBe(false);
  });
  it('rejects category .html (Magento 1.x style — was a false-positive of the dropped /\\.html$/ pattern)', () => {
    expect(isLikelyProductUrl('https://ellwoodepps.com/firearms.html')).toBe(false);
    expect(isLikelyProductUrl('https://example.com/about.html')).toBe(false);
  });
  it('matches BC Stencil bare descriptive slug (30+ chars, ≥3 hyphens)', () => {
    // Real example from nordicmarksman.com: a long descriptive product slug
    // at site root with no numeric ID — the only signal is slug length+hyphens.
    expect(isLikelyProductUrl('https://example.com/sellier-bellot-7-62x54r-soft-point-180-grain')).toBeTruthy();
    expect(isLikelyProductUrl('https://example.com/winchester-30-30win-model-1894-sporter-rifle')).toBeTruthy();
  });
  it('rejects long single-word slug (no hyphens — fails segmentHyphenCount guard)', () => {
    // 30+ chars but only 0-2 hyphens — likely a category landing page, not a product.
    expect(isLikelyProductUrl('https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(isLikelyProductUrl('https://example.com/foo-bar-baz-quux-quuux-quuuux-x')).toBeTruthy();  // 6 hyphens, OK
  });
  it('matches Drupal classifieds 4-segment URL (gunpost: /<cat>/<sub>/<city>/<slug>)', () => {
    expect(isLikelyProductUrl('https://www.gunpost.ca/firearms/rifles/toronto/winchester-94-classic')).toBeTruthy();
  });
  it('matches marketplace 4+ segment with trailing 4-digit id', () => {
    expect(isLikelyProductUrl('https://www.gunpost.ca/firearms/rifles/edmonton/mauser-1450')).toBeTruthy();
  });
});

describe('parseSitemapXml', () => {
  it('extracts <loc> entries', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://example.com/product1</loc></url>
      <url><loc>https://example.com/product2</loc></url>
    </urlset>`;
    expect(parseSitemapXml(xml)).toEqual([
      'https://example.com/product1',
      'https://example.com/product2',
    ]);
  });
  it('handles HTML-entity-encoded URLs', () => {
    const xml = `<urlset><url><loc>https://example.com/p?a=1&amp;b=2</loc></url></urlset>`;
    expect(parseSitemapXml(xml)).toEqual(['https://example.com/p?a=1&b=2']);
  });
});
