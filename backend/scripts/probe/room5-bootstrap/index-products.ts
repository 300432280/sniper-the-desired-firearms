/**
 * @deprecated 2026-04-27 — Generic discovery superseded by AI-driven per-site audit.
 * See `_DEPRECATED.md` in this folder and `docs/superpowers/plans/2026-04-27-pivot-to-ai-audit.md`.
 * Do not import from this file in new code.
 */
// backend/scripts/probe/room5-bootstrap/index-products.ts
// Per spec §4.5 steps 4-7: run chosen strategy → produce products → enrich →
// saveProducts → seed watermark → compute drift.

import { saveProducts } from '../../../src/services/product-upsert';
import { enrichProducts } from './detail-enrich';
import { htmlWalk, shopifyApiWalk, woocommerceApiWalk, ecwidApiWalk, normalizeToIso } from './walk-strategies';
import type { IndexingStrategy, AdapterEntry } from './strategy-dispatch';
import type { NavigationState, RoomFailure } from '../shared/types';
import type { CatalogProduct } from '../../../src/services/scraper/types';
import { prisma } from '../../../src/lib/prisma';

export type IndexProductsResult = {
  productsIndexed: number;
  detailEnrichmentStats: {
    productsEnriched: number;
    avgDetailFetchMs: number;
    detailFetchFailures: number;
  };
  newestProduct: {
    url: string;
    sourceId?: string;
    postDate: string | null;
    title: string;
    price?: number;
  };
  finalDriftPct: number;
  driftBand: 'pass' | 'soft-warn' | 'fail';
  passCriteriaWarnings: string[];
  dbWrites: {
    productIndexRows: number;
    monitoredSiteCreated: boolean;
    lastWatermarkUrlSet: boolean;
    lastWatermarkDateSet: boolean;
    isEnabledSet: boolean;
  };
};

// ── Main entry ──────────────────────────────────────────────────────────────

export async function indexProducts(
  state: NavigationState,
  siteId: string,
  strategy: IndexingStrategy,
  adapterEntry: AdapterEntry,
  monitoredSiteCreated: boolean,
): Promise<IndexProductsResult | RoomFailure> {
  process.stderr.write(`  [Room 5] indexing via ${strategy} (adapter=${adapterEntry})\n`);

  // Step 1: Run chosen strategy to get raw products
  let products: CatalogProduct[];

  switch (strategy) {
    case 'api-walk':
      if (adapterEntry === 'shopify') {
        products = await shopifyApiWalk(state, siteId);
      } else if (adapterEntry === 'woocommerce') {
        products = await woocommerceApiWalk(state, siteId);
      } else if (adapterEntry === 'ecwid-storefront') {
        products = await ecwidApiWalk(state, siteId);
      } else {
        products = await htmlWalk(state, siteId);
      }
      break;
    case 'hybrid':
    case 'html-walk':
    default:
      products = await htmlWalk(state, siteId);
      break;
  }

  process.stderr.write(`  [Room 5] raw products extracted: ${products.length}\n`);

  if (products.length === 0) {
    return {
      roomFailed: true,
      roomNumber: 5,
      reason: 'Zero products extracted during indexing walk',
      evidence: { strategy, adapterEntry, catalogUrls: state.catalogUrls },
      timestamp: new Date().toISOString(),
    };
  }

  // Step 2: Enrich products missing price (in-stock) or postDate
  const enrichResult = await enrichProducts(products, siteId, state);
  products = enrichResult.enrichedProducts;
  process.stderr.write(`  [Room 5] enriched ${enrichResult.productsEnriched} products (${enrichResult.detailFetchFailures} failures)\n`);

  // Step 3: Upsert via saveProducts (handles dedupe + classification)
  const saved = await saveProducts(siteId, products);
  const productsIndexed = saved.length;
  process.stderr.write(`  [Room 5] saveProducts wrote ${productsIndexed} rows\n`);

  // Step 4: Compute drift (Fix #1 — enforce 3-band gating per spec §4.5)
  const globalCount = state.globalProductCount || products.length;
  const finalDriftPct = globalCount > 0
    ? Math.abs(productsIndexed - globalCount) / globalCount * 100
    : 0;
  process.stderr.write(`  [Room 5] drift: ${finalDriftPct.toFixed(1)}% (indexed=${productsIndexed}, expected=${globalCount})\n`);

  // Step 5: Per-product pass criteria (Fix #10 — spec §4.5)
  const inStockMissingPrice = products.filter(p => p.stockStatus === 'in_stock' && p.price == null).length;
  const missingDateNonMethodC = state.watermarkMethod !== 'full-catalog-sweep'
    ? products.filter(p => !p.postDate).length
    : 0;
  const inStockMissingPricePct = products.length > 0 ? (inStockMissingPrice / products.length) * 100 : 0;
  const missingDatePct = products.length > 0 ? (missingDateNonMethodC / products.length) * 100 : 0;

  const passCriteriaWarnings: string[] = [];
  if (inStockMissingPricePct > 5) passCriteriaWarnings.push(`${inStockMissingPrice} in-stock products missing price (${inStockMissingPricePct.toFixed(1)}%)`);
  if (missingDatePct > 5) passCriteriaWarnings.push(`${missingDateNonMethodC} products missing postDate for Method ${state.watermarkMethod} (${missingDatePct.toFixed(1)}%)`);

  // Step 6: Identify newest product (Fix #6 — never inject synthetic date)
  const withDate = products.filter(p => p.postDate);
  let newestProduct: CatalogProduct;

  if (withDate.length > 0) {
    withDate.sort((a, b) => new Date(b.postDate!).getTime() - new Date(a.postDate!).getTime());
    newestProduct = withDate[0];
  } else if (state.watermarkMethod === 'full-catalog-sweep') {
    // Method C: postDate may be null; use first product from walk (typically newest by page order)
    newestProduct = products[0];
  } else {
    // Method A or B requires postDate — hard fail per spec §4.5
    return {
      roomFailed: true,
      roomNumber: 5,
      reason: `Watermark seed failed: Method ${state.watermarkMethod} requires postDate but none could be extracted from ${products.length} products`,
      evidence: { productsTotal: products.length, watermarkMethod: state.watermarkMethod, enrichedCount: enrichResult.productsEnriched },
      timestamp: new Date().toISOString(),
    };
  }

  // Step 7: Drift gating — 3-band per spec §4.5 (Fix #1)
  //   ≤ 3%   → auto-enable (pass)
  //   3-5%   → soft-warn (seed watermark but leave isEnabled=false for operator)
  //   > 5%   → hard fail (do NOT write watermark)
  if (finalDriftPct > 5) {
    return {
      roomFailed: true,
      roomNumber: 5,
      reason: `Drift ${finalDriftPct.toFixed(2)}% exceeds 5% hard-fail threshold (indexed=${productsIndexed}, expected=${globalCount})`,
      evidence: { finalDriftPct, productsIndexed, globalProductCount: globalCount, catalogUrls: state.catalogUrls },
      timestamp: new Date().toISOString(),
    };
  }

  const driftBand: 'pass' | 'soft-warn' | 'fail' = finalDriftPct <= 3 ? 'pass' : 'soft-warn';
  const shouldEnable = driftBand === 'pass';

  const watermarkDate = normalizeToIso(newestProduct.postDate) ?? null;
  const watermarkSeeded = !!newestProduct.url && (state.watermarkMethod === 'full-catalog-sweep' || watermarkDate != null);

  // Step 8: Write watermark + crawlTuning + isEnabled ONLY after drift verdict (Fix #2)
  let lastWatermarkUrlSet = false;
  let lastWatermarkDateSet = false;
  let isEnabledSet = false;

  if (watermarkSeeded) {
    // Fetch existing crawlTuning to merge (Fix #7 — done here to avoid overwrite)
    const existingRow = await prisma.monitoredSite.findUnique({
      where: { id: siteId },
      select: { crawlTuning: true },
    });
    const crawlTuning = {
      ...(existingRow?.crawlTuning as Record<string, any> ?? {}),
      ...(watermarkDate ? { lastWatermarkDate: watermarkDate } : {}),
    };

    if (shouldEnable) {
      await prisma.monitoredSite.update({
        where: { id: siteId },
        data: {
          lastWatermarkUrl: newestProduct.url,
          crawlTuning,
          isEnabled: true,
          nextCrawlAt: new Date(),
          bootstrapCompletedAt: new Date(),
          crawlPhase: 'maintain',
        },
      });
      lastWatermarkUrlSet = true;
      lastWatermarkDateSet = !!watermarkDate;
      isEnabledSet = true;
    } else {
      // soft-warn: seed watermark but leave isEnabled=false (operator confirms)
      await prisma.monitoredSite.update({
        where: { id: siteId },
        data: {
          lastWatermarkUrl: newestProduct.url,
          crawlTuning,
          // isEnabled stays as-is — operator must flip
        },
      });
      lastWatermarkUrlSet = true;
      lastWatermarkDateSet = !!watermarkDate;
    }
  }
  // On !watermarkSeeded for Method A/B: already hard-failed above.
  // On Method C with no date: watermarkSeeded = true (url only), watermarkDate = null — writes URL only.

  return {
    productsIndexed,
    detailEnrichmentStats: {
      productsEnriched: enrichResult.productsEnriched,
      avgDetailFetchMs: enrichResult.avgDetailFetchMs,
      detailFetchFailures: enrichResult.detailFetchFailures,
    },
    newestProduct: {
      url: newestProduct.url,
      sourceId: newestProduct.sourceId,
      postDate: watermarkDate,
      title: newestProduct.title,
      price: newestProduct.price,
    },
    finalDriftPct,
    driftBand,
    passCriteriaWarnings,
    dbWrites: {
      productIndexRows: productsIndexed,
      monitoredSiteCreated,
      lastWatermarkUrlSet,
      lastWatermarkDateSet,
      isEnabledSet,
    },
  };
}
