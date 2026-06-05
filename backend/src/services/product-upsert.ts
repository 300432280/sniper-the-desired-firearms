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
import { classifyProduct, classifyOutOfScope } from './product-classifier';
import type { CatalogProduct } from './scraper/types';

/**
 * Watched content fields for change detection: price, regularPrice, stockStatus ONLY.
 * Title/thumbnail/category/tags changes do NOT count (they are not alert-worthy and
 * would make contentChangedAt noisy).
 */
export interface ContentSnapshot {
  price: number | null;
  regularPrice: number | null;
  stockStatus: string | null;
}

export interface ContentChange {
  /** True when contentChangedAt should be bumped on the ProductIndex row. */
  changed: boolean;
  /** The ProductHistory row to append (sans productIndexId), or null if nothing to record. */
  history: { price: number | null; regularPrice: number | null; stockStatus: string | null; changeKind: string } | null;
}

/**
 * Compare a prior content snapshot against the next one and decide whether the
 * watched content (price / regularPrice / stockStatus) actually changed.
 *
 * Rules:
 * - First insert (prior === null) → changeKind 'new', always records a baseline.
 * - Stock transition: prior.stockStatus !== next.stockStatus (after normalization).
 * - Price transition: number→number (or number→null) for price OR regularPrice.
 *   NULL guard: a transient null caused by the source merely omitting the price
 *   this cycle (i.e. next is null) is NOT a price change ON ITS OWN — it only
 *   counts when it coincides with a real stock transition. null→number IS a real
 *   price change (the product gained a price). Callers pass null for observed-null.
 * - changeKind combines the dimensions that changed: 'price' | 'stock' | 'price+stock'.
 */
export function applyContentChange(
  prior: ContentSnapshot | null,
  next: ContentSnapshot,
): ContentChange {
  if (prior === null) {
    return {
      changed: true,
      history: {
        price: next.price,
        regularPrice: next.regularPrice,
        stockStatus: next.stockStatus,
        changeKind: 'new',
      },
    };
  }

  const stockChanged = (next.stockStatus ?? null) !== (prior.stockStatus ?? null);

  // A field counts as a real price change when it gains a value (null→number),
  // changes between two numbers (number→number), or drops a value (number→null)
  // ONLY when a stock transition is also happening this cycle.
  const fieldPriceChanged = (p: number | null, n: number | null): boolean => {
    if (p === n) return false;
    if (n !== null) return true;        // null→number or number→number(diff)
    return stockChanged;                // number→null: only real if stock also moved
  };

  const priceChanged =
    fieldPriceChanged(prior.price, next.price) ||
    fieldPriceChanged(prior.regularPrice, next.regularPrice);

  if (!stockChanged && !priceChanged) {
    return { changed: false, history: null };
  }

  const changeKind =
    priceChanged && stockChanged ? 'price+stock' : priceChanged ? 'price' : 'stock';

  return {
    changed: true,
    history: {
      price: next.price,
      regularPrice: next.regularPrice,
      stockStatus: next.stockStatus,
      changeKind,
    },
  };
}

/**
 * Tracking/search query parameters that should be stripped from product URLs
 * to prevent duplicate entries from search results, UTM campaigns, etc.
 */
const TRACKING_PARAMS = new Set([
  // BigCommerce search result tracking
  'searchid', 'search_query',
  // Listing/sort/pagination params that leak onto product URLs (e.g. a product
  // link inheriting `?orderby=date` from a sorted category page). These create
  // a distinct URL key for the same product → duplicate ProductIndex rows when
  // the product has no sourceId to dedup on. NOTE: do NOT add variant/option
  // selectors (variant, sku, color, option, attribute) — those are MEANINGFUL
  // product selectors and must be preserved.
  'orderby', 'order', 'sortby', 'sort_by', 'sort', 'dir', 'view', 'page',
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

/**
 * Detect error / not-found / soft-404 page titles. A soft-404 scrape returns
 * HTTP 200 with an error-page body; without this guard it would either create a
 * junk ProductIndex row OR overwrite a real product's title/price/thumbnail with
 * garbage. We reject these so last-known product data is preserved — the
 * verify/stale path is what legitimately delists a gone product.
 */
function isErrorPageTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return /^\s*(page not found|404\b|not found|error 404|oops|no longer available|nothing found)/i.test(title);
}

export async function saveProducts(
  siteId: string,
  products: CatalogProduct[],
  forceNew?: Set<string>,
): Promise<SavedProduct[]> {
  if (products.length === 0) return [];

  // Filter out category/collection pages before saving
  const filtered = products.filter(p => {
    if (isCategoryUrl(p.url)) return false;
    // Reject products with very short titles that look like category names
    if (p.title && p.title.length < 4 && !p.price) return false;
    // Reject soft-404 / error-page scrapes so they never create a junk row or
    // overwrite a real product's title/price/thumbnail (delisting is handled by
    // the verify/stale path, not by a bad listing-page scrape).
    if (isErrorPageTitle(p.title)) return false;
    return true;
  });
  if (filtered.length < products.length) {
    const dropped = products.length - filtered.length;
    if (dropped > 0) console.log(`[ProductUpsert] Filtered ${dropped} category/non-product URLs`);
  }

  const saved: SavedProduct[] = [];
  // Collected ProductHistory rows for a single batched createMany after the loop.
  const historyRows: { productIndexId: string; price: number | null; regularPrice: number | null; stockStatus: string | null; changeKind: string }[] = [];

  for (const product of filtered) {
    try {
      // Normalize URL to strip tracking/search params before deduplication
      product.url = normalizeProductUrl(product.url);

      // OOS veto ALWAYS wins, even over a scraper-preset product.productType — a
      // preset 'gear'/'firearm' must not let an apparel/lifestyle item bypass the
      // Layer-0 out_of_scope check (CATEGORY_MAP no longer maps apparel→gear, but
      // a preset type would otherwise short-circuit classifyProduct entirely).
      // (BLOCKER 2, 2026-06-05.)
      const oos = classifyOutOfScope(product.title, { sourceCategory: product.sourceCategory, url: product.url, tags: product.tags });
      const productType = oos ?? (product.productType || classifyProduct({
        title: product.title,
        url: product.url,
        tags: product.tags,
        sourceCategory: product.sourceCategory,
      }));

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
          // Detect content change vs the prior row (price/regularPrice/stockStatus).
          // The DB update preserves the prior price/regularPrice when the source
          // omits the field (the `if (product.price != null)` guards above), so the
          // diff's `next` must mirror that pass-through — otherwise an omitted price
          // during a stock change would be misclassified as a price drop.
          const change = applyContentChange(
            { price: existing.price, regularPrice: existing.regularPrice, stockStatus: existing.stockStatus },
            {
              price: product.price ?? existing.price,
              regularPrice: product.regularPrice ?? existing.regularPrice,
              stockStatus: hasRealStock ? product.stockStatus! : existing.stockStatus,
            },
          );
          if (change.changed) update.contentChangedAt = new Date();
          // Update existing row with current URL, title, price
          result = await prisma.productIndex.update({
            where: { id: existing.id },
            data: update,
          });
          if (change.history) historyRows.push({ productIndexId: result.id, ...change.history });
        } else {
          // No sourceId match — check if URL already exists (pre-sourceId row)
          const byUrl = await prisma.productIndex.findUnique({
            where: { siteId_url: { siteId, url: product.url } },
          });

          if (byUrl) {
            // Backfill sourceId onto existing URL-matched row.
            // Pass prior price through when the source omits it (mirrors the DB
            // update's conditional price guards — see note above).
            const change = applyContentChange(
              { price: byUrl.price, regularPrice: byUrl.regularPrice, stockStatus: byUrl.stockStatus },
              {
                price: product.price ?? byUrl.price,
                regularPrice: product.regularPrice ?? byUrl.regularPrice,
                stockStatus: hasRealStock ? product.stockStatus! : byUrl.stockStatus,
              },
            );
            if (change.changed) update.contentChangedAt = new Date();
            result = await prisma.productIndex.update({
              where: { id: byUrl.id },
              data: { ...update, sourceId: product.sourceId },
            });
            if (change.history) historyRows.push({ productIndexId: result.id, ...change.history });
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
            // Baseline history row so the price/stock timeline has an origin.
            historyRows.push({
              productIndexId: result.id,
              price: result.price,
              regularPrice: result.regularPrice,
              stockStatus: result.stockStatus,
              changeKind: 'new',
            });
          }
        }
      } else {
        // ── URL-only path: fallback for adapters without sourceId ──
        // Read the prior row to diff content (price/regularPrice/stockStatus),
        // but keep the WRITE atomic via upsert so a concurrent insert for the
        // same (siteId, url) updates instead of throwing a unique-constraint
        // violation (the catch would otherwise silently drop the row + history).
        const existingByUrl = await prisma.productIndex.findUnique({
          where: { siteId_url: { siteId, url: product.url } },
        });
        isNew = !existingByUrl;
        const change = existingByUrl
          ? applyContentChange(
              { price: existingByUrl.price, regularPrice: existingByUrl.regularPrice, stockStatus: existingByUrl.stockStatus },
              {
                price: product.price ?? existingByUrl.price,
                regularPrice: product.regularPrice ?? existingByUrl.regularPrice,
                stockStatus: hasRealStock ? product.stockStatus! : existingByUrl.stockStatus,
              },
            )
          : null;
        if (change?.changed) update.contentChangedAt = new Date();

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

        if (isNew) {
          // Baseline history row so the price/stock timeline has an origin.
          historyRows.push({
            productIndexId: result.id,
            price: result.price,
            regularPrice: result.regularPrice,
            stockStatus: result.stockStatus,
            changeKind: 'new',
          });
        } else if (change?.history) {
          historyRows.push({ productIndexId: result.id, ...change.history });
        }
      }

      // Only include in "new" list if it was just created, OR if the caller
      // explicitly requested this URL be treated as new (e.g. back-in-stock).
      if (
        isNew ||
        result.firstSeenAt.getTime() === result.lastSeenAt.getTime() ||
        (forceNew && forceNew.has(result.url))
      ) {
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

  // Batch-insert all collected price/stock history rows in one round-trip.
  if (historyRows.length > 0) {
    await prisma.productHistory.createMany({ data: historyRows });
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

/**
 * Like checkExistingProducts, but returns the CURRENT DB stockStatus for each
 * known product (keyed by the URL as supplied in the input list).
 *
 * Return value: Map<inputUrl, 'in_stock' | 'out_of_stock' | 'unknown' | null>
 * - Products NOT in DB are absent from the map.
 * - Products in DB whose stockStatus column is NULL map to `null`.
 *
 * Uses the same URL + sourceId fallback matching as checkExistingProducts so
 * that a row whose URL has changed is still found via sourceId.
 */
export async function checkExistingProductsWithStock(
  siteId: string,
  products: CatalogProduct[],
): Promise<Map<string, 'in_stock' | 'out_of_stock' | 'unknown' | null>> {
  const result = new Map<string, 'in_stock' | 'out_of_stock' | 'unknown' | null>();
  if (products.length === 0) return result;

  const urls = products.map(p => p.url);
  const sourceIds = products.filter(p => p.sourceId).map(p => p.sourceId!);

  const [byUrl, bySourceId] = await Promise.all([
    prisma.productIndex.findMany({
      where: { siteId, url: { in: urls } },
      select: { url: true, sourceId: true, stockStatus: true },
    }),
    sourceIds.length > 0
      ? prisma.productIndex.findMany({
          where: { siteId, sourceId: { in: sourceIds } },
          select: { url: true, sourceId: true, stockStatus: true },
        })
      : [],
  ]);

  const urlToStock = new Map<string, string | null>();
  for (const row of byUrl) urlToStock.set(row.url, row.stockStatus);
  const sourceIdToStock = new Map<string, string | null>();
  for (const row of bySourceId) {
    if (row.sourceId) sourceIdToStock.set(row.sourceId, row.stockStatus);
  }

  const normalize = (s: string | null): 'in_stock' | 'out_of_stock' | 'unknown' | null => {
    if (s === null) return null;
    if (s === 'in_stock' || s === 'out_of_stock' || s === 'unknown') return s;
    return null;
  };

  for (const product of products) {
    if (urlToStock.has(product.url)) {
      result.set(product.url, normalize(urlToStock.get(product.url)!));
      continue;
    }
    if (product.sourceId && sourceIdToStock.has(product.sourceId)) {
      result.set(product.url, normalize(sourceIdToStock.get(product.sourceId)!));
    }
  }

  return result;
}
