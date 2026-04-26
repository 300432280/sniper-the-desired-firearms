// backend/scripts/probe/room3-geography-count/sitemap-parse.ts
// Sitemap discovery + parsing + product-URL classification.
// Cherry-pick: static-mode XML fetch, broadened WAF bail-out, expanded URL patterns,
// byte-identical shard md5 dedup, sitemap-index follow-through.

import { createHash } from 'crypto';
import { fetchUrl } from '../shared/fetch';
import { hasChallengeMarkers } from '../room2-access-identity/canonical-host';

const PRODUCT_URL_POSITIVE = [
  /\/products?\//i,
  /\/product-page\//i,
  /\/catalog\/product\/view\/id\/\d+/i,
  /\/shop\/[^/]+(?:-\d{2,})?$/i,
  /[-_]p[-_]?\d{2,}\.html$/i,
  /\/[a-z0-9-]+-\d{4,}\/?$/i,    // slug-NNNN
  /\.html$/i,                      // generic
];

const PRODUCT_URL_NEGATIVE = [
  /\/(product-)?category\//i,
  /\/collections\//i,
  /\/brand\//i,
  /\/tag\//i,
  /\/page\/\d+/i,
  /\/(cart|login|checkout|account|search|sitemap|wp-admin|wp-login|robots)/i,
  /\/sitemap[^/]*\.xml/i,
];

export function isLikelyProductUrl(url: string): boolean {
  if (PRODUCT_URL_NEGATIVE.some(re => re.test(url))) return false;
  return PRODUCT_URL_POSITIVE.some(re => re.test(url));
}

export function parseSitemapXml(xml: string): string[] {
  const re = /<loc>([^<]+)<\/loc>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(decodeXmlEntities(m[1].trim()));
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export type SitemapDiscoveryResult = {
  productUrls: string[];
  totalLocs: number;
  shardsCounted: string[];
  duplicateShardsByMd5: number;
  wafBailedOut: boolean;
};

const SITEMAP_CANDIDATES = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/product-sitemap.xml',
  '/products-sitemap.xml',
  '/sitemap_products.xml',
  '/sitemap/products.xml',
  '/sitemap_products_1.xml',          // Shopify shard-1
  '/xmlsitemap.php',                  // BigCommerce sitemap-index (follow-children unlocks ?type=products&page=N)
  '/xmlsitemap.php?type=products',    // BigCommerce direct product sub-sitemap (some installs)
  '/store-products-sitemap.xml',      // Wix
  '/ecstore-1-sitemap.xml',           // Ecwid Yoast shard-1
];

export async function discoverProductSitemap(origin: string): Promise<SitemapDiscoveryResult> {
  const result: SitemapDiscoveryResult = {
    productUrls: [],
    totalLocs: 0,
    shardsCounted: [],
    duplicateShardsByMd5: 0,
    wafBailedOut: false,
  };
  const seenMd5 = new Set<string>();
  let consecutiveWafFails = 0;

  for (const path of SITEMAP_CANDIDATES) {
    const url = `${origin}${path}`;
    let body: string;
    try {
      // Static-mode: XML doesn't need Playwright, even on WAF sites
      const r = await fetchUrl(url, { timeoutMs: 15000 });
      // Bail counter ONLY counts true WAF challenge bodies (detected via markers).
      // A 404 is "this candidate path doesn't exist" — normal, not a WAF event —
      // and must NOT count toward bail (otherwise BC sites whose first 3 generic
      // candidates 404 never reach /xmlsitemap.php; same for Wix /store-products-sitemap.xml).
      if (hasChallengeMarkers(r.body)) {
        consecutiveWafFails++;
        if (consecutiveWafFails >= 3) { result.wafBailedOut = true; return result; }
        continue;
      }
      if (r.status >= 400) continue;  // legitimate 404 — try next candidate
      body = r.body;
    } catch { continue; }
    consecutiveWafFails = 0;

    const md5 = createHash('md5').update(body).digest('hex');
    if (seenMd5.has(md5)) { result.duplicateShardsByMd5++; continue; }
    seenMd5.add(md5);
    result.shardsCounted.push(url);

    const locs = parseSitemapXml(body);
    result.totalLocs += locs.length;

    // sitemap-index → follow children
    if (/<sitemapindex/i.test(body)) {
      for (const childUrl of locs.slice(0, 40)) {
        try {
          const cr = await fetchUrl(childUrl, { timeoutMs: 15000 });
          if (hasChallengeMarkers(cr.body) || cr.status >= 400) continue;
          const cmd5 = createHash('md5').update(cr.body).digest('hex');
          if (seenMd5.has(cmd5)) { result.duplicateShardsByMd5++; continue; }
          seenMd5.add(cmd5);
          result.shardsCounted.push(childUrl);
          const childLocs = parseSitemapXml(cr.body);
          result.totalLocs += childLocs.length;
          result.productUrls.push(...childLocs.filter(isLikelyProductUrl));
        } catch { /* skip */ }
      }
    } else {
      result.productUrls.push(...locs.filter(isLikelyProductUrl));
    }

    // Stop after first valid sitemap (don't double-count)
    if (result.productUrls.length > 0) break;
  }

  // Dedupe product URLs across shards
  result.productUrls = [...new Set(result.productUrls)];
  return result;
}
