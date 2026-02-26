/**
 * Watermark Crawler — Tier 1 new-items crawl.
 *
 * Fetches "new arrivals" / "sort by newest" pages and paginates forward
 * until hitting the last-known product (watermark). New products are
 * saved to ProductIndex and keyword-matched against active Searches.
 *
 * Self-adjusting: busy site = more pages consumed, quiet site = 1 page.
 * Unused Tier 1 tokens flow downstream to catalog tiers.
 */

import { prisma } from '../lib/prisma';
import { getAdapterForUrl } from './scraper/adapter-registry';
import { fetchPageWithMeta, randomDelay } from './scraper/http-client';
import { pushEvent } from './debugLog';
import { consumeToken, getTier1Remaining } from './token-budget';
import { matchNewProducts } from './keyword-matcher';
import type { CatalogProduct } from './scraper/types';
import * as cheerio from 'cheerio';

interface WatermarkResult {
  status: 'success' | 'fail' | 'timeout' | 'blocked';
  productsFound: number;
  pagesScanned: number;
  tokensUsed: number;
  newWatermarkUrl: string | null;
  responseTimeMs?: number;
  statusCode?: number;
  signals?: { hasWaf: boolean; hasRateLimit: boolean; hasCaptcha: boolean };
  headers?: Record<string, any>;
  errorMessage?: string;
}

/**
 * Run a Tier 1 watermark crawl for a site.
 * Paginates from newest until hitting lastWatermarkUrl or exhausting tokens.
 */
export async function crawlWatermark(params: {
  siteId: string;
  url: string;
  domain: string;
  baseBudget: number;
  capacity: number;
  lastWatermarkUrl: string | null;
}): Promise<WatermarkResult> {
  const { siteId, url, baseBudget, capacity, lastWatermarkUrl } = params;
  const startTime = Date.now();

  const { adapter } = await getAdapterForUrl(url);
  const origin = new URL(url).origin;

  let pagesScanned = 0;
  let tokensUsed = 0;
  const allNewProducts: CatalogProduct[] = [];
  let newWatermarkUrl: string | null = null;
  let hitWatermark = false;

  try {
    // Determine the starting URL for new arrivals
    let pageUrl: string | undefined;
    if (adapter.getNewArrivalsUrl) {
      pageUrl = adapter.getNewArrivalsUrl(origin);
    } else if (adapter.fetchCatalogPage) {
      // Use API-based catalog with newest sort
      let page = 1;
      while (getTier1Remaining(siteId, baseBudget, capacity) > 0) {
        consumeToken(siteId, 1);
        tokensUsed++;

        const catalogPage = await adapter.fetchCatalogPage(origin, page, { sortBy: 'newest', perPage: 50 });
        pagesScanned++;

        if (catalogPage.products.length === 0) break;

        // Set watermark to the newest product on first page
        if (page === 1 && catalogPage.products.length > 0) {
          newWatermarkUrl = catalogPage.products[0].url;
        }

        // Check each product against watermark
        for (const product of catalogPage.products) {
          if (lastWatermarkUrl && product.url === lastWatermarkUrl) {
            hitWatermark = true;
            break;
          }
          allNewProducts.push(product);
        }

        if (hitWatermark || !catalogPage.nextPageUrl) break;
        page++;

        await randomDelay(300, 800);
      }

      // Save to ProductIndex and run keyword matcher
      const savedProducts = await saveProducts(siteId, allNewProducts);
      if (savedProducts.length > 0) {
        await matchNewProducts(savedProducts);
      }

      return {
        status: 'success',
        productsFound: allNewProducts.length,
        pagesScanned,
        tokensUsed,
        newWatermarkUrl: newWatermarkUrl || lastWatermarkUrl,
      };
    } else {
      // HTML-based: use search URL sorted by newest, or base URL
      pageUrl = `${origin}/`;
    }

    // HTML-based watermark crawl
    let currentUrl = pageUrl;
    while (currentUrl && getTier1Remaining(siteId, baseBudget, capacity) > 0) {
      consumeToken(siteId, 1);
      tokensUsed++;

      const fetchResult = await fetchPageWithMeta(currentUrl, undefined, { difficultyRating: 0 });
      pagesScanned++;

      const $ = cheerio.load(fetchResult.html);
      let products: CatalogProduct[] = [];

      if (adapter.extractCatalogProducts) {
        products = adapter.extractCatalogProducts($, currentUrl);
      }

      if (products.length === 0) break;

      // Set watermark to the newest product on first page
      if (pagesScanned === 1 && products.length > 0) {
        newWatermarkUrl = products[0].url;
      }

      for (const product of products) {
        if (lastWatermarkUrl && product.url === lastWatermarkUrl) {
          hitWatermark = true;
          break;
        }
        allNewProducts.push(product);
      }

      if (hitWatermark) break;

      // Get next page
      const nextUrl = adapter.getNextPageUrl?.($, currentUrl) ?? null;
      if (!nextUrl) break;
      currentUrl = nextUrl;
      if (currentUrl) {
        await randomDelay(300, 800);
      }
    }

    // Save to ProductIndex
    const savedProducts = await saveProducts(siteId, allNewProducts);
    if (savedProducts.length > 0) {
      await matchNewProducts(savedProducts);
    }

    if (!hitWatermark && lastWatermarkUrl && allNewProducts.length > 0) {
      console.log(`[WatermarkCrawler] ${params.domain}: watermark not found within token budget, indexed ${allNewProducts.length} products`);
      pushEvent({
        type: 'info',
        message: `Watermark not found for ${params.domain} — indexed ${allNewProducts.length} products, may have a backlog`,
      });
    }

    return {
      status: 'success',
      productsFound: allNewProducts.length,
      pagesScanned,
      tokensUsed,
      newWatermarkUrl: newWatermarkUrl || lastWatermarkUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const status = msg.includes('timeout') ? 'timeout'
      : msg.includes('429') ? 'blocked'
      : 'fail';

    return {
      status,
      productsFound: allNewProducts.length,
      pagesScanned,
      tokensUsed,
      newWatermarkUrl: newWatermarkUrl || lastWatermarkUrl,
      errorMessage: msg,
      responseTimeMs: Date.now() - startTime,
    };
  }
}

// ── Save Products to ProductIndex ───────────────────────────────────────────

async function saveProducts(
  siteId: string,
  products: CatalogProduct[],
): Promise<Array<{ id: string; siteId: string; url: string; title: string; price?: number | null; thumbnail?: string | null }>> {
  if (products.length === 0) return [];

  const saved: Array<{ id: string; siteId: string; url: string; title: string; price?: number | null; thumbnail?: string | null }> = [];

  for (const product of products) {
    try {
      const result = await prisma.productIndex.upsert({
        where: { siteId_url: { siteId, url: product.url } },
        update: {
          title: product.title,
          price: product.price ?? null,
          stockStatus: product.stockStatus ?? null,
          thumbnail: product.thumbnail ?? null,
          category: product.category ?? null,
          closingAt: product.closingAt ?? null,
          lastSeenAt: new Date(),
          isActive: true,
        },
        create: {
          siteId,
          url: product.url,
          title: product.title,
          price: product.price ?? null,
          stockStatus: product.stockStatus ?? null,
          thumbnail: product.thumbnail ?? null,
          category: product.category ?? null,
          closingAt: product.closingAt ?? null,
        },
      });

      // Only include in "new" list if it was just created (firstSeenAt === lastSeenAt)
      if (result.firstSeenAt.getTime() === result.lastSeenAt.getTime()) {
        saved.push(result);
      }
    } catch (err) {
      // Skip duplicates silently
      if (!(err instanceof Error && err.message.includes('Unique constraint'))) {
        console.error(`[WatermarkCrawler] Failed to save product ${product.url}:`, err);
      }
    }
  }

  return saved;
}
