// backend/scripts/probe/room5-bootstrap/index-products.ts
// Per spec §4.5 steps 4-7: run chosen strategy → produce products → enrich →
// saveProducts → seed watermark → compute drift.

import { saveProducts } from '../../../src/services/product-upsert';
import { enrichProducts } from './detail-enrich';
import { htmlWalk, shopifyApiWalk, woocommerceApiWalk } from './walk-strategies';
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
    postDate: string;
    title: string;
    price?: number;
  };
  finalDriftPct: number;
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

  // Step 3: Identify newest product (sort by postDate desc, fallback to first in walk)
  const withDate = products.filter(p => p.postDate);
  let newestProduct: CatalogProduct;

  if (withDate.length > 0) {
    withDate.sort((a, b) => new Date(b.postDate!).getTime() - new Date(a.postDate!).getTime());
    newestProduct = withDate[0];
  } else if (state.watermarkMethod !== 'full-catalog-sweep') {
    return {
      roomFailed: true,
      roomNumber: 5,
      reason: 'No product has a postDate — cannot seed watermark for method A/B. Consider method C (full-catalog-sweep).',
      evidence: { productsTotal: products.length, watermarkMethod: state.watermarkMethod },
      timestamp: new Date().toISOString(),
    };
  } else {
    newestProduct = products[0];
  }

  // Step 4: Upsert via saveProducts (handles dedupe + classification)
  const saved = await saveProducts(siteId, products);
  process.stderr.write(`  [Room 5] saveProducts wrote ${saved.length} rows\n`);

  // Step 5: Seed watermark on MonitoredSite
  const watermarkDate = newestProduct.postDate ?? null;
  const existingRow = await prisma.monitoredSite.findUnique({
    where: { id: siteId },
    select: { crawlTuning: true },
  });
  const crawlTuning = {
    ...(existingRow?.crawlTuning as Record<string, any> ?? {}),
    ...(watermarkDate ? { lastWatermarkDate: watermarkDate } : {}),
  };

  await prisma.monitoredSite.update({
    where: { id: siteId },
    data: { lastWatermarkUrl: newestProduct.url, crawlTuning },
  });

  // Step 6: Compute drift
  const globalCount = state.globalProductCount || products.length;
  const finalDriftPct = globalCount > 0
    ? Math.abs(saved.length - globalCount) / globalCount * 100
    : 0;
  process.stderr.write(`  [Room 5] drift: ${finalDriftPct.toFixed(1)}% (indexed=${saved.length}, expected=${globalCount})\n`);

  // Step 7: Pass/fail based on drift + watermark
  if (finalDriftPct > 5 && state.watermarkMethod !== 'full-catalog-sweep') {
    return {
      roomFailed: true,
      roomNumber: 5,
      reason: `Drift ${finalDriftPct.toFixed(1)}% exceeds 5% (indexed=${saved.length}, expected=${globalCount}). Check catalogUrls coverage.`,
      evidence: { productsIndexed: saved.length, globalProductCount: globalCount, catalogUrls: state.catalogUrls, driftPct: finalDriftPct },
      timestamp: new Date().toISOString(),
    };
  }

  const watermarkSeeded = !!newestProduct.url;
  const watermarkDateSeeded = !!watermarkDate;
  const shouldEnable = finalDriftPct <= 5 && watermarkSeeded;

  if (shouldEnable) {
    await prisma.monitoredSite.update({
      where: { id: siteId },
      data: { isEnabled: true, nextCrawlAt: new Date(), bootstrapCompletedAt: new Date() },
    });
  }

  return {
    productsIndexed: saved.length,
    detailEnrichmentStats: {
      productsEnriched: enrichResult.productsEnriched,
      avgDetailFetchMs: enrichResult.avgDetailFetchMs,
      detailFetchFailures: enrichResult.detailFetchFailures,
    },
    newestProduct: {
      url: newestProduct.url,
      sourceId: newestProduct.sourceId,
      postDate: watermarkDate ?? new Date().toISOString(),
      title: newestProduct.title,
      price: newestProduct.price,
    },
    finalDriftPct,
    dbWrites: {
      productIndexRows: saved.length,
      monitoredSiteCreated: false,
      lastWatermarkUrlSet: watermarkSeeded,
      lastWatermarkDateSet: watermarkDateSeeded,
      isEnabledSet: shouldEnable,
    },
  };
}
