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
