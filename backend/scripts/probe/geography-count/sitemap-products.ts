/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/geography-count/sitemap-products.ts
// Step 1 of the Geography & Count stage: extract canonical product URL Set from sitemaps.
// The URL set is the GROUND TRUTH for the set-cover algorithm in select-catalog-set.ts.
// Also provides a count (sitemap.size) that global-count.ts can consume.
//
// Delegates to sitemap-parse.ts for discovery + parsing + classification.
// This module adds: URL Set emission, breadcrumb-category extraction from product pages.

import { discoverProductSitemap, isLikelyProductUrl, parseSitemapXml } from './sitemap-parse';
import type { AccessIdentityState } from '../shared/types';

export type SitemapProductsResult = {
  /** Canonical product URL set — ground truth for set-cover */
  urlSet: Set<string>;
  /** Sitemap shards consulted */
  shardsConsulted: string[];
  /** Total <loc> entries across all shards (products + non-products) */
  totalLocs: number;
  /** Number of product URLs found */
  productCount: number;
  /** Whether sitemap was available and usable */
  available: boolean;
  /** Whether WAF bailed out before completing sitemap scan */
  wafBailedOut: boolean;
  /** Duplicate shards detected by md5 */
  duplicateShardsByMd5: number;
};

export async function extractSitemapProducts(state: AccessIdentityState): Promise<SitemapProductsResult> {
  const origin = state.canonicalOrigin;

  const sitemap = await discoverProductSitemap(origin);

  const urlSet = new Set(sitemap.productUrls);

  const result: SitemapProductsResult = {
    urlSet,
    shardsConsulted: sitemap.shardsCounted,
    totalLocs: sitemap.totalLocs,
    productCount: urlSet.size,
    available: urlSet.size > 0,
    wafBailedOut: sitemap.wafBailedOut,
    duplicateShardsByMd5: sitemap.duplicateShardsByMd5,
  };

  process.stderr.write(
    `  [sitemap-products] ${result.available ? `found ${result.productCount} product URLs across ${result.shardsConsulted.length} shards` : 'no product URLs found'}${result.wafBailedOut ? ' (WAF bail-out)' : ''}\n`
  );

  return result;
}
