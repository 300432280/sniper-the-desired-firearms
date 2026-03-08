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
import { classifyProduct } from './product-classifier';
import * as cheerio from 'cheerio';

/** Reject nav/utility URLs that should never be stored as watermarks */
function isNavOrUtilityUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return /\/(wishlist|cart|checkout|account|login|register|registration|giftcert|contact|about|faq|privacy|terms|shipping|returns|blog|news|pages?\/|#|mailto:)/i.test(lower);
}

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
  hasWaf?: boolean;
}): Promise<WatermarkResult> {
  const { siteId, url, baseBudget, capacity, lastWatermarkUrl, hasWaf } = params;
  const startTime = Date.now();

  const { adapter } = await getAdapterForUrl(url);
  const origin = new URL(url).origin;

  let pagesScanned = 0;
  let tokensUsed = 0;
  const allNewProducts: CatalogProduct[] = [];
  let newWatermarkUrl: string | null = null;
  let hitWatermark = false;

  try {
    // Try API-based catalog first (structured data with prices, preferred)
    if (adapter.fetchCatalogPage) {
      let page = 1;
      let apiWorked = false;
      while (getTier1Remaining(siteId, baseBudget, capacity) > 0) {
        consumeToken(siteId, 1);
        tokensUsed++;

        let catalogPage;
        try {
          catalogPage = await adapter.fetchCatalogPage(origin, page, { sortBy: 'newest', perPage: 50 });
        } catch {
          break; // API failed, fall through to HTML
        }
        pagesScanned++;

        if (catalogPage.products.length === 0) break;
        apiWorked = true;

        // Set watermark to the newest product on first page
        if (page === 1 && catalogPage.products.length > 0) {
          const candidate = catalogPage.products[0].url;
          if (!isNavOrUtilityUrl(candidate)) {
            newWatermarkUrl = candidate;
          }
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

      if (apiWorked) {
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
      }
      // API returned 0 products — fall through to HTML-based crawl
    }

    // Build list of HTML URLs to try for new arrivals (in priority order)
    const candidateUrls: string[] = [];
    if (adapter.getNewArrivalsUrls) {
      candidateUrls.push(...adapter.getNewArrivalsUrls(origin));
    } else if (adapter.getNewArrivalsUrl) {
      candidateUrls.push(adapter.getNewArrivalsUrl(origin));
    } else {
      candidateUrls.push(`${origin}/`);
    }

    // HTML-based watermark crawl — try each candidate URL until one yields products
    let foundProducts = false;
    for (const startUrl of candidateUrls) {
      if (foundProducts) break;
      if (getTier1Remaining(siteId, baseBudget, capacity) <= 0) break;

      let currentUrl: string | null = startUrl;
      while (currentUrl && getTier1Remaining(siteId, baseBudget, capacity) > 0) {
        consumeToken(siteId, 1);
        tokensUsed++;

        let html = '';

        // For known WAF sites, skip static fetch and go straight to Playwright
        if (hasWaf) {
          try {
            const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
            console.log(`[WatermarkCrawler] WAF site ${params.domain}, using Playwright for ${currentUrl}`);
            const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 45000 });
            html = pwResult.html;
            // Log if Playwright returned suspiciously small content (WAF may not have resolved)
            if (html.length < 2000) {
              console.log(`[WatermarkCrawler] WAF site ${params.domain}: Playwright returned only ${html.length}b — WAF challenge may not have resolved`);
            }
          } catch (err) {
            console.log(`[WatermarkCrawler] WAF site ${params.domain}: Playwright failed — ${err instanceof Error ? err.message : err}`);
            break; // Playwright failed on WAF site, try next candidate URL
          }
        } else {
          try {
            const fetchResult = await fetchPageWithMeta(currentUrl, undefined, { difficultyRating: 0 });
            html = fetchResult.html;
          } catch {
            // Static fetch failed — try Playwright before giving up
            try {
              const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
              console.log(`[WatermarkCrawler] Static fetch failed for ${currentUrl}, trying Playwright`);
              const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 30000 });
              html = pwResult.html;
            } catch {
              break; // Both failed, try next candidate URL
            }
          }

          // Playwright fallback: if static HTML is too small or WAF-blocked, try headless browser
          const isBlockedOrEmpty = html.length < 2000 || html.includes('_Incapsula_Resource') ||
            html.includes('Access Denied') || html.includes('403 Forbidden') ||
            html.includes('cf-browser-verification') || html.includes('challenge-platform') ||
            html.includes('Just a moment...') || html.includes('Checking your browser') ||
            html.includes('Attention Required') || html.includes('cf-challenge');
          if (isBlockedOrEmpty && html.length > 0) {
            try {
              const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
              console.log(`[WatermarkCrawler] Static HTML blocked/small (${html.length}b) for ${currentUrl}, trying Playwright`);
              const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 30000 });
              html = pwResult.html;
            } catch {
              // Playwright also failed, continue with what we have
            }
          }
        }

        pagesScanned++;

        const $ = cheerio.load(html);
        let products: CatalogProduct[] = [];

        if (adapter.extractCatalogProducts) {
          products = adapter.extractCatalogProducts($, currentUrl);
        }

        // Playwright fallback: static HTML is large but yielded 0 products → likely AJAX-loaded
        if (products.length === 0 && !hasWaf && html.length > 5000) {
          try {
            const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
            console.log(`[WatermarkCrawler] ${params.domain}: 0 products from ${html.length}b static HTML, trying Playwright fallback`);
            const pwResult = await fetchWithPlaywright(currentUrl, { timeout: 30000 });
            if (pwResult.html.length > html.length) {
              const $pw = cheerio.load(pwResult.html);
              if (adapter.extractCatalogProducts) {
                products = adapter.extractCatalogProducts($pw, currentUrl);
                if (products.length > 0) {
                  console.log(`[WatermarkCrawler] ${params.domain}: Playwright found ${products.length} products`);
                }
              }
            }
          } catch {
            // Playwright also failed, continue
          }
        }

        if (products.length === 0) {
          console.log(`[WatermarkCrawler] ${params.domain}: 0 products from ${currentUrl} (HTML: ${html.length}b)`);
          break; // No products on this URL, try next candidate
        }

        foundProducts = true;

        // Set watermark to the newest product on first page
        // Validate it looks like a real product URL (not a nav/utility page)
        if (!newWatermarkUrl && products.length > 0) {
          const candidate = products[0].url;
          if (!isNavOrUtilityUrl(candidate)) {
            newWatermarkUrl = candidate;
          } else if (products.length > 1 && !isNavOrUtilityUrl(products[1].url)) {
            newWatermarkUrl = products[1].url;
          }
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
        const nextUrl: string | null = adapter.getNextPageUrl?.($, currentUrl) ?? null;
        if (!nextUrl) break;
        currentUrl = nextUrl;
        if (currentUrl) {
          await randomDelay(300, 800);
        }
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
      // Only overwrite stock/price/thumbnail if new data is meaningful —
      // prevents WP REST API data (unknown stock, no price) from clobbering
      // good data already set by Store API or backfill.
      // Classify product type if not already set
      const productType = product.productType || classifyProduct({
        title: product.title,
        url: product.url,
        tags: product.tags,
        sourceCategory: product.sourceCategory,
      });

      const hasRealStock = product.stockStatus && product.stockStatus !== 'unknown';
      const update: Record<string, any> = {
        title: product.title,
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

      const result = await prisma.productIndex.upsert({
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
