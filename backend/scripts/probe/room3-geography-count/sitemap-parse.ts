/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/room3-geography-count/sitemap-parse.ts
// Sitemap discovery + parsing + product-URL classification.
// Cherry-pick: static-mode XML fetch, broadened WAF bail-out, expanded URL patterns,
// byte-identical shard md5 dedup, sitemap-index follow-through.

import { createHash } from 'crypto';
import { fetchUrl } from '../shared/fetch';
import { hasChallengeMarkers } from '../room2-access-identity/canonical-host';

const PRODUCT_URL_POSITIVE: RegExp[] = [
  /\/products?\//i,
  /\/product-page\//i,
  /\/catalog\/product\/view\/id\/\d+/i,
  /\/shop\/[^/]+(?:-\d{2,})?$/i,
  /[-_]p[-_]?\d{2,}\.html?$/i,
  /\/[a-z0-9-]+-\d{4,}\/?$/i,                // single-segment slug-NNNN
  /\/\d{3,}\.html?$/i,                       // pure numeric .html (legacy CMS)
  /\/product\.php\?/i,                       // custom-PHP product detail (irunguns precedent)
  /\/detail\/[^/?#]+\/?$/i,                  // generic /detail/<slug>
  /(?:\/[a-z][a-z0-9-]*){3,}\/\d{4,}\/?$/i,  // marketplace/classifieds: 4+ segments + trailing 4-digit id
  /\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]{3,}\/?$/i,
  // ↑ Drupal classifieds 4-segment without trailing digits (gunpost: /firearms/rifles/<city>/<slug>)
  // BC Stencil bare-slug products: single-segment path, 30+ chars, ≥3 hyphens
  // (the hyphen-count guard is applied in isLikelyProductUrl below to avoid
  //  matching long single-word category slugs).
  /^https?:\/\/[^/]+\/[a-z0-9][a-z0-9-]{29,}\/?$/i,
];

// Index of the BC-Stencil-bare-slug pattern — used by the segmentHyphenCount
// guard in isLikelyProductUrl so the pattern only matches descriptive product
// slugs (≥3 hyphens) and not long single-word category slugs.
const BARE_SLUG_PATTERN_IDX = PRODUCT_URL_POSITIVE.length - 1;

const PRODUCT_URL_NEGATIVE: RegExp[] = [
  /\/(product-)?category\//i,
  /\/(product_)?categories?\//i,
  /\/collections\//i,
  /\/brand\//i,
  /\/brands\//i,
  /\/tag\//i,
  /\/tags\//i,
  /\/author\//i,
  /\/page\/\d+/i,
  /\/(cart|login|checkout|account|search|sitemap|wp-admin|wp-login|wp-content|wp-includes|robots)/i,
  /\/sitemap[^/]*\.xml/i,
  /\/(about|about-us|contact|contact-us|faq|help|support|blog|news|press|privacy|terms|policy|policies|shipping|returns|warranty|store-locator|locations|careers|jobs)\b/i,
  /\/feed\/?$/i,
  /\/rss\/?$/i,
  /\/(en|fr|es|de|cn|zh)\/?$/i,              // language-root only (no path after)
];

function segmentHyphenCount(url: string): number {
  try {
    const u = new URL(url);
    const seg = u.pathname.replace(/\/$/, '').split('/').pop() || '';
    return (seg.match(/-/g) || []).length;
  } catch {
    return 0;
  }
}

export function isLikelyProductUrl(url: string): boolean {
  if (PRODUCT_URL_NEGATIVE.some(re => re.test(url))) return false;
  for (let i = 0; i < PRODUCT_URL_POSITIVE.length; i++) {
    if (!PRODUCT_URL_POSITIVE[i].test(url)) continue;
    // BC Stencil bare-slug pattern: also require ≥3 hyphens in the slug
    // to avoid matching very long single-word category slugs (which would be
    // rare but could be category landing pages on long-named categories).
    if (i === BARE_SLUG_PATTERN_IDX && segmentHyphenCount(url) < 3) continue;
    return true;
  }
  return false;
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
