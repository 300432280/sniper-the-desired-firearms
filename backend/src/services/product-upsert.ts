/**
 * Shared product upsert module.
 *
 * Handles saving products to ProductIndex with sourceId-first deduplication.
 * When a product has a sourceId, it's used as the primary lookup key instead of URL.
 * This prevents duplicate entries when URL slugs change (e.g. classifieds sites
 * regenerate URLs when sellers edit listing titles).
 *
 * Used by both catalog-crawler.ts and watermark-crawler.ts.
 */

import { prisma } from '../lib/prisma';
import { classifyProduct } from './product-classifier';
import type { CatalogProduct } from './scraper/types';

/**
 * Tracking/search query parameters that should be stripped from product URLs
 * to prevent duplicate entries from search results, UTM campaigns, etc.
 */
const TRACKING_PARAMS = new Set([
  // BigCommerce search result tracking
  'searchid', 'search_query',
  // UTM parameters
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  // Common tracking/session params
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid',
  'mc_cid', 'mc_eid',
  'ref', 'ref_', 'referrer',
  '_ga', '_gl',
  'si', 'spm',
]);

/**
 * Normalize a product URL by stripping tracking/search query parameters.
 * Preserves meaningful query params (like variant selectors) while removing
 * params that create duplicate entries for the same product.
 */
function normalizeProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const param of TRACKING_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.delete(param);
        changed = true;
      }
    }
    if (!changed) return url;
    // Remove trailing ? if no params remain
    const result = parsed.toString();
    return result.endsWith('?') ? result.slice(0, -1) : result;
  } catch {
    return url;
  }
}

export type SavedProduct = {
  id: string;
  siteId: string;
  url: string;
  title: string;
  price?: number | null;
  thumbnail?: string | null;
};

/**
 * Save products to ProductIndex with sourceId-aware deduplication.
 *
 * Priority:
 * 1. If product has sourceId → find by (siteId, sourceId) → update existing (including URL)
 * 2. If no sourceId match → fall back to (siteId, url) upsert
 * 3. If URL match exists but has no sourceId → backfill sourceId onto it
 *
 * Returns only NEW products (firstSeenAt === lastSeenAt) for notification matching.
 */
/**
 * Generic filter: reject URLs that are category/collection pages, not individual products.
 * These patterns are platform-agnostic and apply to all adapters.
 */
function isCategoryUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    // WooCommerce category pages
    if (path.includes('/product-category/')) return true;
    // Generic /category/ path (townpost, etc.)
    if (/^\/category\//.test(path)) return true;
    // Shopify collections root (but NOT /collections/all/products/slug which is a real product)
    if (path.includes('/collections/') && !path.includes('/products/')) return true;
    // WP admin pages (should never be products)
    if (path.includes('/wp-admin/')) return true;
    // Tag/archive pages
    if (path.includes('/product-tag/')) return true;
    return false;
  } catch {
    return false;
  }
}

export async function saveProducts(
  siteId: string,
  products: CatalogProduct[],
): Promise<SavedProduct[]> {
  if (products.length === 0) return [];

  // Filter out category/collection pages before saving
  const filtered = products.filter(p => {
    if (isCategoryUrl(p.url)) return false;
    // Reject products with very short titles that look like category names
    if (p.title && p.title.length < 4 && !p.price) return false;
    return true;
  });
  if (filtered.length < products.length) {
    const dropped = products.length - filtered.length;
    if (dropped > 0) console.log(`[ProductUpsert] Filtered ${dropped} category/non-product URLs`);
  }

  const saved: SavedProduct[] = [];

  for (const product of filtered) {
    try {
      // Normalize URL to strip tracking/search params before deduplication
      product.url = normalizeProductUrl(product.url);

      const productType = product.productType || classifyProduct({
        title: product.title,
        url: product.url,
        tags: product.tags,
        sourceCategory: product.sourceCategory,
      });

      const hasRealStock = product.stockStatus && product.stockStatus !== 'unknown';
      const update: Record<string, any> = {
        title: product.title,
        url: product.url, // Always update URL (may have changed if sourceId matched)
        category: product.category ?? null,
        tags: product.tags ?? null,
        closingAt: product.closingAt ?? null,
        lastSeenAt: new Date(),
        isActive: true,
      };
      if (hasRealStock) update.stockStatus = product.stockStatus;
      if (product.price != null) update.price = product.price;
      if (product.regularPrice != null) update.regularPrice = product.regularPrice;
      if (product.thumbnail) update.thumbnail = product.thumbnail;
      if (productType) update.productType = productType;
      if (product.sourceId) update.sourceId = product.sourceId;

      let result;
      let isNew = false;

      if (product.sourceId) {
        // ── sourceId path: find by stable ID first ──
        const existing = await prisma.productIndex.findFirst({
          where: { siteId, sourceId: product.sourceId },
        });

        if (existing) {
          // URL may have changed — check for collision with another row
          if (existing.url !== product.url) {
            const urlConflict = await prisma.productIndex.findUnique({
              where: { siteId_url: { siteId, url: product.url } },
            });
            if (urlConflict && urlConflict.id !== existing.id) {
              // Merge: move any Match FKs from the conflicting row, then delete it
              await prisma.match.updateMany({
                where: { productIndexId: urlConflict.id },
                data: { productIndexId: existing.id },
              });
              await prisma.productIndex.delete({ where: { id: urlConflict.id } });
            }
          }
          // Update existing row with current URL, title, price
          result = await prisma.productIndex.update({
            where: { id: existing.id },
            data: update,
          });
        } else {
          // No sourceId match — check if URL already exists (pre-sourceId row)
          const byUrl = await prisma.productIndex.findUnique({
            where: { siteId_url: { siteId, url: product.url } },
          });

          if (byUrl) {
            // Backfill sourceId onto existing URL-matched row
            result = await prisma.productIndex.update({
              where: { id: byUrl.id },
              data: { ...update, sourceId: product.sourceId },
            });
          } else {
            // Truly new product
            result = await prisma.productIndex.create({
              data: {
                siteId,
                url: product.url,
                sourceId: product.sourceId,
                title: product.title,
                price: product.price ?? null,
                regularPrice: product.regularPrice ?? null,
                stockStatus: product.stockStatus ?? null,
                thumbnail: product.thumbnail ?? null,
                category: product.category ?? null,
                tags: product.tags ?? null,
                productType: productType ?? null,
                closingAt: product.closingAt ?? null,
              },
            });
            isNew = true;
          }
        }
      } else {
        // ── URL-only path: fallback for adapters without sourceId ──
        result = await prisma.productIndex.upsert({
          where: { siteId_url: { siteId, url: product.url } },
          update,
          create: {
            siteId,
            url: product.url,
            title: product.title,
            price: product.price ?? null,
            regularPrice: product.regularPrice ?? null,
            stockStatus: product.stockStatus ?? null,
            thumbnail: product.thumbnail ?? null,
            category: product.category ?? null,
            tags: product.tags ?? null,
            productType: productType ?? null,
            closingAt: product.closingAt ?? null,
          },
        });
      }

      // Only include in "new" list if it was just created
      if (isNew || result.firstSeenAt.getTime() === result.lastSeenAt.getTime()) {
        saved.push(result);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Unique constraint')) {
        console.log(`[ProductUpsert] Unique constraint conflict for ${product.url} (sourceId: ${product.sourceId})`);
      } else {
        console.error(`[ProductUpsert] Failed to save product ${product.url}:`, err);
      }
    }
  }

  return saved;
}

/**
 * Check which products already exist in ProductIndex.
 * Checks both by URL and by sourceId (when available).
 * Returns a Set of product URLs that are already known.
 */
export async function checkExistingProducts(
  siteId: string,
  products: CatalogProduct[],
): Promise<Set<string>> {
  const urls = products.map(p => p.url);
  const sourceIds = products.filter(p => p.sourceId).map(p => p.sourceId!);

  const [byUrl, bySourceId] = await Promise.all([
    prisma.productIndex.findMany({
      where: { siteId, url: { in: urls } },
      select: { url: true, sourceId: true },
    }),
    sourceIds.length > 0
      ? prisma.productIndex.findMany({
          where: { siteId, sourceId: { in: sourceIds } },
          select: { url: true, sourceId: true },
        })
      : [],
  ]);

  const known = new Set<string>();
  for (const p of byUrl) known.add(p.url);
  for (const p of bySourceId) if (p.url) known.add(p.url);

  // Also mark products whose sourceId matches (even if URL changed)
  const knownSourceIds = new Set(bySourceId.map(p => p.sourceId).filter(Boolean));
  for (const product of products) {
    if (product.sourceId && knownSourceIds.has(product.sourceId)) {
      known.add(product.url);
    }
  }

  return known;
}
