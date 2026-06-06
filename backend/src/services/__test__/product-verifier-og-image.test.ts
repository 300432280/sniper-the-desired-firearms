// backend/src/services/__test__/product-verifier-og-image.test.ts
//
// Fix 2(b) (2026-06-05): TownPost detail pages set og:image to a generic
// "OG card generator" URL (/api/og?title=...&fallbackUrl=<real photo>), NOT the
// listing photo. The verifier's Open Graph layer was storing this text card,
// overwriting the real CDN thumbnail (518 polluted rows). extractProductData()
// now (i) recovers the real photo from the card URL's fallbackUrl= param when
// present, else (ii) drops the og:image so the HTML-selector thumbnail wins.
import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { extractProductData } from '../product-verifier';

const base = 'https://townpost.ca/marketplace/calgary/guns/sample/123';

describe('product-verifier og:image /api/og rejection (Fix 2b)', () => {
  it('recovers the real photo from the fallbackUrl param of an /api/og card', () => {
    const realPhoto =
      'https://townpost.sfo3.cdn.digitaloceanspaces.com/images%2Fads%2Fabc%2F123_IMG.jpeg';
    const og = `https://townpost.ca/api/og?title=Sample&fallbackUrl=${encodeURIComponent(realPhoto)}&v=1`;
    const html = `<html><head>
      <meta property="og:image" content="${og}" />
    </head><body></body></html>`;
    const $ = cheerio.load(html);
    const data = extractProductData($, html, base);
    expect(data.thumbnail).toBe(realPhoto);
  });

  it('drops an /api/og card with no fallbackUrl, falling through to the HTML img', () => {
    const og = 'https://townpost.ca/api/og?title=Sample&v=1';
    const realImg = 'https://townpost.sfo3.cdn.digitaloceanspaces.com/images/ads/xyz/photo.jpg';
    const html = `<html><head>
      <meta property="og:image" content="${og}" />
    </head><body>
      <div class="product-image"><img src="${realImg}" /></div>
    </body></html>`;
    const $ = cheerio.load(html);
    const data = extractProductData($, html, base);
    // The /api/og card must NOT be stored. The thumbnail is either the real HTML
    // image or unset — in both cases it never contains the card-generator path.
    expect(data.thumbnail ?? '').not.toContain('/api/og');
    expect(data.thumbnail).toBe(realImg);
  });

  it('keeps a normal og:image untouched on a non-card site', () => {
    const og = 'https://cdn.example.com/products/real-photo.jpg';
    const html = `<html><head>
      <meta property="og:image" content="${og}" />
    </head><body></body></html>`;
    const $ = cheerio.load(html);
    const data = extractProductData($, html, base);
    expect(data.thumbnail).toBe(og);
  });
});
