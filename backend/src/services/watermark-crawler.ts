/**
 * Watermark Crawler — Tier 1 new-items crawl.
 *
 * THREE crawl methods based on siteProfile.crawlers.watermark.method:
 *
 * Method A: "api-date-since-watermark" (WooCommerce and other API sites with date support)
 *   - Query API with dateAfter=watermark_date, order=asc (oldest first)
 *   - Walk forward from watermark toward newest
 *   - Watermark = last product processed (gap-free on token exhaustion)
 *
 * Method B: "navigate-from-watermark" (HTML sites, BigCommerce, default)
 *   - Navigate from page 1 (newest) toward older pages to FIND the watermark
 *   - Once found, walk BACK toward page 1, indexing new products
 *   - Watermark = last new product indexed (closest to newest)
 *   - Gap-free: always indexes from the watermark toward newest
 *
 * Method C: "full-catalog-sweep" (sites with NO date-based sort anywhere)
 *   - For each catalogUrl, walk every page using buildPaginatedUrl + adapter.getNextPageUrl
 *   - Extract products via adapter.extractCatalogProducts
 *   - Batch DB lookup; collect any URL not already in DB as a "new" product
 *   - Stops on empty page, repeated empty pages, or token exhaustion
 *   - Required for sites where page 1 is not necessarily newest
 */

import { prisma } from '../lib/prisma';
import { getAdapterForUrl, _getSiteCacheEntry } from './scraper/adapter-registry';
import { fetchPageWithMeta, randomDelay } from './scraper/http-client';
import { buildPaginatedUrl } from './catalog-crawler';
import { pushEvent } from './debugLog';
import { consumeToken, getTier1Remaining } from './token-budget';
import type { CatalogProduct, CatalogPage } from './scraper/types';
import { saveProducts, checkExistingProducts, checkExistingProductsWithStock } from './product-upsert';
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
  newWatermarkDate?: string;  // ISO date of newest listing seen (modified/bumped date)
  responseTimeMs?: number;
  statusCode?: number;
  signals?: { hasWaf: boolean; hasRateLimit: boolean; hasCaptcha: boolean };
  headers?: Record<string, any>;
  errorMessage?: string;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Pick a valid watermark URL from a product list (skip nav/utility URLs) */
function pickWatermarkUrl(products: CatalogProduct[]): string | null {
  for (const p of products) {
    if (!isNavOrUtilityUrl(p.url)) return p.url;
  }
  return null;
}

/** Check remaining tier-1 budget */
function hasBudget(siteId: string, baseBudget: number, capacity: number): boolean {
  return getTier1Remaining(siteId, baseBudget, capacity) > 0;
}

/** Fetch HTML for a URL with WAF / Playwright fallback logic. Returns HTML string or null on failure. */
async function fetchHtml(
  pageUrl: string,
  domain: string,
  hasWaf?: boolean,
): Promise<string | null> {
  let html = '';

  if (hasWaf) {
    try {
      const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
      console.log(`[WatermarkCrawler] WAF site ${domain}, using Playwright for ${pageUrl}`);
      const pwResult = await fetchWithPlaywright(pageUrl, { timeout: 45000 });
      html = pwResult.html;
      if (html.length < 2000) {
        console.log(`[WatermarkCrawler] WAF site ${domain}: Playwright returned only ${html.length}b — WAF challenge may not have resolved`);
      }
    } catch (err) {
      console.log(`[WatermarkCrawler] WAF site ${domain}: Playwright failed — ${err instanceof Error ? err.message : err}`);
      return null;
    }
  } else {
    try {
      const fetchResult = await fetchPageWithMeta(pageUrl, undefined, { difficultyRating: 0 });
      html = fetchResult.html;
    } catch {
      try {
        const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
        console.log(`[WatermarkCrawler] Static fetch failed for ${pageUrl}, trying Playwright`);
        const pwResult = await fetchWithPlaywright(pageUrl, { timeout: 30000 });
        html = pwResult.html;
      } catch {
        return null;
      }
    }

    // Playwright fallback: if static HTML is too small or WAF-blocked, try headless browser
    // 'challenge-platform' removed 2026-06-06: CF injects that benign beacon on every passive page →
    // false block → needless Playwright. Real CF blocks still caught by cf-browser-verification / Just a moment /
    // Checking your browser / Attention Required / cf-challenge; non-CF by Incapsula / Access Denied / 403.
    const isBlockedOrEmpty = html.length < 2000 || html.includes('_Incapsula_Resource') ||
      html.includes('Access Denied') || html.includes('403 Forbidden') ||
      html.includes('cf-browser-verification') ||
      html.includes('Just a moment...') || html.includes('Checking your browser') ||
      html.includes('Attention Required') || html.includes('cf-challenge');
    if (isBlockedOrEmpty && html.length > 0) {
      try {
        const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
        console.log(`[WatermarkCrawler] Static HTML blocked/small (${html.length}b) for ${pageUrl}, trying Playwright`);
        const pwResult = await fetchWithPlaywright(pageUrl, { timeout: 30000 });
        html = pwResult.html;
      } catch {
        // Playwright also failed, continue with what we have
      }
    }
  }

  return html;
}

/** Extract products from HTML using the adapter, with Playwright fallback for AJAX-loaded content */
async function extractProductsFromHtml(
  html: string,
  pageUrl: string,
  domain: string,
  hasWaf: boolean | undefined,
  adapter: any,
): Promise<CatalogProduct[]> {
  const $ = cheerio.load(html);
  let products: CatalogProduct[] = [];

  // Per-site opt-in: sites whose listing cards never expose stock (gobles.ca,
  // northprosports.com) → no-signal card maps to 'unknown' not 'out_of_stock'.
  const wmProfile = _getSiteCacheEntry(domain.replace(/^www\./, ''));
  if (!wmProfile) console.warn(`[stock-flag] ${domain}: no adapter-cache entry; listingOmitsStock defaults false (cache cold?)`);
  const extractOpts = { listingOmitsStock: wmProfile?.siteProfile?.listingOmitsStock === true };

  if (adapter.extractCatalogProducts) {
    products = adapter.extractCatalogProducts($, pageUrl, extractOpts);
  }

  // Playwright fallback: static HTML is large but yielded 0 products → likely AJAX-loaded
  if (products.length === 0 && !hasWaf && html.length > 5000) {
    try {
      const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
      console.log(`[WatermarkCrawler] ${domain}: 0 products from ${html.length}b static HTML, trying Playwright fallback`);
      const pwResult = await fetchWithPlaywright(pageUrl, { timeout: 30000 });
      if (pwResult.html.length > html.length) {
        const $pw = cheerio.load(pwResult.html);
        if (adapter.extractCatalogProducts) {
          products = adapter.extractCatalogProducts($pw, pageUrl, extractOpts);
          if (products.length > 0) {
            console.log(`[WatermarkCrawler] ${domain}: Playwright found ${products.length} products`);
          }
        }
      }
    } catch {
      // Playwright also failed, continue
    }
  }

  return products;
}

// ── Method A: api-date-filter ───────────────────────────────────────────────

/**
 * Walk FORWARD from watermark date (oldest→newest) using API date filtering.
 * Gap-free: if tokens run out, watermark = last product we reached.
 */
async function crawlApiDateFilter(params: {
  siteId: string;
  url: string;
  domain: string;
  baseBudget: number;
  capacity: number;
  lastWatermarkUrl: string | null;
  lastWatermarkDate?: string | null;
  hasWaf?: boolean;
  wmKnownThreshold: number;
  wmOldDateThreshold: number;
  adapter: any;
  origin: string;
  perPage?: number; // From siteProfile.perPage — overrides default 50
}): Promise<{ products: CatalogProduct[]; pagesScanned: number; tokensUsed: number; newWatermarkUrl: string | null; newestDateSeen: string | null; fallbackToMethodB: boolean }> {
  const { siteId, domain, baseBudget, capacity, lastWatermarkDate, hasWaf, adapter, origin, perPage } = params;

  let pagesScanned = 0;
  let tokensUsed = 0;
  const allNewProducts: CatalogProduct[] = [];
  let newWatermarkUrl: string | null = null;
  let newestDateSeen: string | null = null;

  // If no watermark date, we can't use date filtering — fall back to Method B
  if (!lastWatermarkDate) {
    console.log(`[WatermarkCrawler] ${domain}: no watermark date for api-date-filter, falling back to navigate-then-walk`);
    return { products: [], pagesScanned: 0, tokensUsed: 0, newWatermarkUrl: null, newestDateSeen: null, fallbackToMethodB: true };
  }

  let page = 1;
  while (hasBudget(siteId, baseBudget, capacity)) {
    consumeToken(siteId, 1);
    tokensUsed++;

    let catalogPage: CatalogPage | null;
    try {
      catalogPage = await adapter.fetchCatalogPage(origin, page, {
        sortBy: 'oldest',
        perPage: perPage || 50,
        dateAfter: lastWatermarkDate,
        hasWaf,
      });
    } catch (err) {
      console.log(`[WatermarkCrawler] ${domain}: API date-filter page ${page} failed — ${err instanceof Error ? err.message : err}`);
      // API returned error — if page 1, fall back to Method B; otherwise stop with what we have
      if (page === 1) {
        return { products: [], pagesScanned, tokensUsed, newWatermarkUrl: null, newestDateSeen: null, fallbackToMethodB: true };
      }
      break;
    }
    // null = adapter doesn't support API crawl for this site — fall back to Method B
    if (catalogPage === null) {
      return { products: [], pagesScanned, tokensUsed, newWatermarkUrl: null, newestDateSeen: null, fallbackToMethodB: true };
    }
    pagesScanned++;

    if (catalogPage.products.length === 0) {
      // If page 1 returns 0 products, the watermark product may have been deleted — fall back
      if (page === 1) {
        console.log(`[WatermarkCrawler] ${domain}: API date-filter returned 0 products (watermark may be deleted), falling back to navigate-then-walk`);
        return { products: [], pagesScanned, tokensUsed, newWatermarkUrl: null, newestDateSeen: null, fallbackToMethodB: true };
      }
      break; // No more products
    }

    // Filter out the watermark URL itself (we already have it)
    const existingUrls = await checkExistingProducts(siteId, catalogPage.products);

    for (const product of catalogPage.products) {
      // Skip the watermark product itself
      if (params.lastWatermarkUrl && product.url === params.lastWatermarkUrl) continue;

      // Track newest date
      if (product.postDate) {
        if (!newestDateSeen || product.postDate > newestDateSeen) {
          newestDateSeen = product.postDate;
        }
      }

      if (!existingUrls.has(product.url)) {
        allNewProducts.push(product);
      }

      // Update watermark to the last product we processed (since we walk oldest→newest,
      // the last one we reach is the furthest forward in time)
      if (!isNavOrUtilityUrl(product.url)) {
        newWatermarkUrl = product.url;
      }
    }

    if (!catalogPage.nextPageUrl) break;
    page++;

    await randomDelay(300, 800);
  }

  return { products: allNewProducts, pagesScanned, tokensUsed, newWatermarkUrl, newestDateSeen, fallbackToMethodB: false };
}

// ── Method B: navigate-then-walk ────────────────────────────────────────────

/**
 * Navigate from page 1 (newest) toward older pages to FIND the watermark,
 * collecting pages along the way. Then walk BACK toward page 1 (newest)
 * to index new products. Gap-free on token exhaustion.
 */
async function crawlNavigateThenWalk(params: {
  siteId: string;
  url: string;
  domain: string;
  baseBudget: number;
  capacity: number;
  lastWatermarkUrl: string | null;
  lastWatermarkDate?: string | null;
  hasWaf?: boolean;
  wmKnownThreshold: number;
  wmOldDateThreshold: number;
  adapter: any;
  origin: string;
  useApi: boolean; // whether adapter has fetchCatalogPage
  perPage?: number; // From siteProfile.perPage — overrides default 50
}): Promise<{ products: CatalogProduct[]; pagesScanned: number; tokensUsed: number; newWatermarkUrl: string | null; newestDateSeen: string | null }> {
  const { siteId, url, domain, baseBudget, capacity, lastWatermarkUrl, lastWatermarkDate, hasWaf, adapter, origin, useApi, perPage } = params;
  const CONSECUTIVE_KNOWN_THRESHOLD = params.wmKnownThreshold;
  const CONSECUTIVE_OLD_DATE_THRESHOLD = params.wmOldDateThreshold;
  const lastWmDate = lastWatermarkDate ? new Date(lastWatermarkDate).getTime() : null;

  let pagesScanned = 0;
  let tokensUsed = 0;
  let newestDateSeen: string | null = null;

  // ── Phase 1: Navigate forward (newest→oldest) to find the watermark ───────
  // Collect pages as we go; we'll process them in reverse in Phase 2.
  const MAX_COLLECTED_PAGES = 100; // Safety cap to prevent unbounded memory growth
  const collectedPages: { products: CatalogProduct[]; existingUrls?: Set<string>; }[] = [];
  let hitWatermark = false;
  // Set true when the API path bailed because fetchCatalogPage returned `null`
  // (adapter exposes the method but no API is configured for THIS site, e.g.
  // GenericRetail BC Stencil / Celerant without Klevu/GraphQL). In that case the
  // API navigation collected nothing and we MUST fall through to HTML navigation.
  // A `null` return means "not configured" — distinct from `{products: []}` which
  // means a working API hit the genuine end of catalog (do NOT fall through).
  let apiReturnedNull = false;

  if (useApi) {
    // API-based navigation (no date filter — just paginate newest-first)
    let page = 1;
    while (hasBudget(siteId, baseBudget, capacity) && collectedPages.length < MAX_COLLECTED_PAGES) {
      consumeToken(siteId, 1);
      tokensUsed++;

      let catalogPage: CatalogPage | null;
      try {
        catalogPage = await adapter.fetchCatalogPage(origin, page, { sortBy: 'newest', perPage: perPage || 50, hasWaf });
      } catch (err) {
        console.log(`[WatermarkCrawler] ${domain}: API page ${page} failed — ${err instanceof Error ? err.message : err}`);
        break;
      }
      // null = adapter doesn't support API crawl for this site — fall through to
      // HTML navigation below (do NOT just stop, or T1 becomes a permanent no-op).
      if (catalogPage === null) { apiReturnedNull = true; break; }
      pagesScanned++;

      if (catalogPage.products.length === 0) break;

      // Check if watermark is on this page
      const wmIndex = lastWatermarkUrl
        ? catalogPage.products.findIndex(p => p.url === lastWatermarkUrl)
        : -1;

      if (wmIndex >= 0) {
        // Watermark found — only keep products BEFORE it (newer ones)
        collectedPages.push({ products: catalogPage.products.slice(0, wmIndex) });
        hitWatermark = true;
        break;
      }

      // Check consecutive-known threshold as a fallback stop
      const existingUrls = await checkExistingProducts(siteId, catalogPage.products);
      let consecutiveKnown = 0;
      let consecutiveOldDate = 0;
      let shouldStop = false;

      for (const product of catalogPage.products) {
        if (existingUrls.has(product.url)) {
          consecutiveKnown++;
          if (consecutiveKnown >= CONSECUTIVE_KNOWN_THRESHOLD) {
            console.log(`[WatermarkCrawler] ${domain}: hit ${CONSECUTIVE_KNOWN_THRESHOLD} consecutive known products during navigation, treating as watermark`);
            hitWatermark = true;
            shouldStop = true;
            break;
          }
        } else {
          consecutiveKnown = 0;
        }
        if (lastWmDate && product.postDate) {
          const productDate = new Date(product.postDate).getTime();
          if (productDate <= lastWmDate) {
            consecutiveOldDate++;
            if (consecutiveOldDate >= CONSECUTIVE_OLD_DATE_THRESHOLD) {
              console.log(`[WatermarkCrawler] ${domain}: hit ${CONSECUTIVE_OLD_DATE_THRESHOLD} consecutive old-date products during navigation, treating as watermark`);
              hitWatermark = true;
              shouldStop = true;
              break;
            }
          } else {
            consecutiveOldDate = 0;
          }
        }
      }

      collectedPages.push({ products: catalogPage.products, existingUrls });

      if (shouldStop || !catalogPage.nextPageUrl) break;
      page++;
      await randomDelay(300, 800);
    }
  }

  // HTML navigation runs when:
  //  (a) the adapter has no API path at all (useApi === false), OR
  //  (b) useApi was true but fetchCatalogPage returned `null` (no API configured
  //      for this site) and the API loop collected nothing — fall through so T1
  //      is not a permanent no-op. Mirrors maintain-readiness.ts:1046-1067.
  // It does NOT run when a working API returned products or a genuine empty page.
  const htmlFallthrough = apiReturnedNull && collectedPages.length === 0 && !!adapter.extractCatalogProducts;
  if (!useApi || htmlFallthrough) {
    // HTML-based navigation
    const candidateUrls: string[] = [];
    if (adapter.getNewArrivalsUrls) {
      candidateUrls.push(...adapter.getNewArrivalsUrls(origin));
    } else if (adapter.getNewArrivalsUrl) {
      candidateUrls.push(adapter.getNewArrivalsUrl(origin));
    } else {
      candidateUrls.push(`${origin}/`);
    }

    for (const startUrl of candidateUrls) {
      if (hitWatermark || collectedPages.length > 0) break;
      if (!hasBudget(siteId, baseBudget, capacity)) break;

      let currentUrl: string | null = startUrl;
      while (currentUrl && hasBudget(siteId, baseBudget, capacity) && collectedPages.length < MAX_COLLECTED_PAGES) {
        consumeToken(siteId, 1);
        tokensUsed++;

        const html = await fetchHtml(currentUrl, domain, hasWaf);
        if (!html) break;
        pagesScanned++;

        const products = await extractProductsFromHtml(html, currentUrl, domain, hasWaf, adapter);

        if (products.length === 0) {
          console.log(`[WatermarkCrawler] ${domain}: 0 products from ${currentUrl} (HTML: ${html?.length ?? 0}b)`);
          break;
        }

        // Check if watermark is on this page
        const wmIndex = lastWatermarkUrl
          ? products.findIndex(p => p.url === lastWatermarkUrl)
          : -1;

        if (wmIndex >= 0) {
          collectedPages.push({ products: products.slice(0, wmIndex) });
          hitWatermark = true;
          break;
        }

        // Check consecutive-known / old-date thresholds
        const existingUrls = await checkExistingProducts(siteId, products);
        let consecutiveKnown = 0;
        let consecutiveOldDate = 0;
        let shouldStop = false;

        for (const product of products) {
          if (existingUrls.has(product.url)) {
            consecutiveKnown++;
            if (consecutiveKnown >= CONSECUTIVE_KNOWN_THRESHOLD) {
              console.log(`[WatermarkCrawler] ${domain}: hit ${CONSECUTIVE_KNOWN_THRESHOLD} consecutive known products during navigation, treating as watermark`);
              hitWatermark = true;
              shouldStop = true;
              break;
            }
          } else {
            consecutiveKnown = 0;
          }
          if (lastWmDate && product.postDate) {
            const productDate = new Date(product.postDate).getTime();
            if (productDate <= lastWmDate) {
              consecutiveOldDate++;
              if (consecutiveOldDate >= CONSECUTIVE_OLD_DATE_THRESHOLD) {
                console.log(`[WatermarkCrawler] ${domain}: hit ${CONSECUTIVE_OLD_DATE_THRESHOLD} consecutive old-date products during navigation, treating as watermark`);
                hitWatermark = true;
                shouldStop = true;
                break;
              }
            } else {
              consecutiveOldDate = 0;
            }
          }
        }

        collectedPages.push({ products, existingUrls });

        if (shouldStop) break;

        // Get next page
        const $ = cheerio.load(html);
        const nextUrl: string | null = adapter.getNextPageUrl?.($, currentUrl) ?? null;
        if (!nextUrl) break;
        currentUrl = nextUrl;
        await randomDelay(300, 800);
      }
    }
  }

  // ── Phase 2: Walk BACK from watermark toward newest, indexing new products ─
  // Pages are collected newest-first, so we reverse to process oldest-first
  // (from watermark toward page 1). This ensures gap-free indexing.

  const allNewProducts: CatalogProduct[] = [];
  let newWatermarkUrl: string | null = null;

  // Process pages in reverse order (oldest → newest)
  for (let i = collectedPages.length - 1; i >= 0; i--) {
    const page = collectedPages[i];
    // Within each page, products are newest-first, so reverse to process oldest-first
    const productsOldestFirst = [...page.products].reverse();

    // Reuse existingUrls from Phase 1 if available, otherwise query DB
    const existingUrls = page.existingUrls ?? await checkExistingProducts(siteId, productsOldestFirst);

    for (const product of productsOldestFirst) {
      if (!existingUrls.has(product.url)) {
        allNewProducts.push(product);
      }
      // Track newest date
      if (product.postDate) {
        if (!newestDateSeen || product.postDate > newestDateSeen) {
          newestDateSeen = product.postDate;
        }
      }
      // Update watermark: since we walk oldest→newest, last valid URL = closest to newest
      if (!isNavOrUtilityUrl(product.url)) {
        newWatermarkUrl = product.url;
      }
    }
  }

  // If we never hit the watermark (tokens ran out during navigation), the collected pages
  // represent the newest content we saw. Set watermark to last product we indexed.
  if (!hitWatermark && lastWatermarkUrl && collectedPages.length > 0) {
    console.log(`[WatermarkCrawler] ${domain}: watermark not found within token budget, indexed ${allNewProducts.length} products from ${collectedPages.length} pages`);
    pushEvent({
      type: 'info',
      message: `Watermark not found for ${domain} — indexed ${allNewProducts.length} products, may have a backlog`,
    });
    // On budget exhaustion during navigation: do NOT advance the watermark past where we navigated.
    // Keep the old watermark so next run picks up from the same spot.
    // Only set newWatermarkUrl if we actually indexed new products.
    if (allNewProducts.length === 0) {
      newWatermarkUrl = null; // Will fall back to lastWatermarkUrl
    }
  }

  // First crawl (no watermark): set watermark to newest product on page 1
  if (!lastWatermarkUrl && collectedPages.length > 0 && collectedPages[0].products.length > 0) {
    const newestPage = collectedPages[0].products;
    newWatermarkUrl = pickWatermarkUrl(newestPage) || newWatermarkUrl;
  }

  return { products: allNewProducts, pagesScanned, tokensUsed, newWatermarkUrl, newestDateSeen };
}

// ── Method C: full-catalog-sweep ────────────────────────────────────────────

/**
 * Walk every page of every catalogUrl, collecting IN-STOCK products not already in DB.
 * For sites with NO date-based sort anywhere — page 1 is not necessarily newest,
 * so we must visit every page to discover new products.
 *
 * IMPORTANT: Out-of-stock products are SKIPPED entirely. T1 only indexes products
 * that are currently purchasable. If an OOS product later comes back in stock, T1
 * will see it as "not in DB" and index it then — that's the desired behavior for
 * "back in stock" alerts.
 *
 * Stops on token exhaustion, repeated empty pages, or end of pagination.
 */
async function crawlFullCatalogSweep(params: {
  siteId: string;
  domain: string;
  baseBudget: number;
  capacity: number;
  hasWaf?: boolean;
  adapter: any;
  origin: string;
  catalogUrls: string[];
  paginationPattern?: any;
}): Promise<{ products: CatalogProduct[]; pagesScanned: number; tokensUsed: number; newWatermarkUrl: string | null; newestDateSeen: string | null; backInStockUrls: Set<string> }> {
  const { siteId, domain, baseBudget, capacity, hasWaf, adapter, catalogUrls, paginationPattern } = params;

  const MAX_PAGES_PER_CATALOG = 500; // safety cap
  const CONSECUTIVE_EMPTY_THRESHOLD = 2;

  let pagesScanned = 0;
  let tokensUsed = 0;
  const newProducts: CatalogProduct[] = [];
  const seenUrls = new Set<string>();
  const backInStockUrls = new Set<string>();

  for (const catalogUrl of catalogUrls) {
    if (!hasBudget(siteId, baseBudget, capacity)) break;

    let pageNum = 1;
    let currentUrl: string | null = catalogUrl;
    let consecutiveEmpty = 0;

    while (currentUrl && hasBudget(siteId, baseBudget, capacity) && pageNum <= MAX_PAGES_PER_CATALOG) {
      consumeToken(siteId, 1);
      tokensUsed++;

      const html = await fetchHtml(currentUrl, domain, hasWaf);
      if (!html) {
        console.log(`[WatermarkCrawler] ${domain}: full-catalog-sweep fetch failed for ${currentUrl}`);
        break;
      }
      pagesScanned++;

      const products = await extractProductsFromHtml(html, currentUrl, domain, hasWaf, adapter);

      if (products.length === 0) {
        consecutiveEmpty++;
        console.log(`[WatermarkCrawler] ${domain}: full-catalog-sweep got 0 products on page ${pageNum} of ${catalogUrl}`);
        if (consecutiveEmpty >= CONSECUTIVE_EMPTY_THRESHOLD) break;
      } else {
        consecutiveEmpty = 0;
        // Skip products that are explicitly out of stock — T1 doesn't index OOS items.
        // Items with stockStatus === 'unknown' are kept (adapter couldn't detect).
        const visibleProducts = products.filter(p => p.stockStatus !== 'out_of_stock');
        const oosSkipped = products.length - visibleProducts.length;
        if (oosSkipped > 0) {
          console.log(`[WatermarkCrawler] ${domain}: full-catalog-sweep skipped ${oosSkipped} OOS product(s) on page ${pageNum} of ${catalogUrl}`);
        }

        if (visibleProducts.length > 0) {
          const existingStock = await checkExistingProductsWithStock(siteId, visibleProducts);
          let backInStockCount = 0;
          for (const product of visibleProducts) {
            if (isNavOrUtilityUrl(product.url)) continue;
            if (seenUrls.has(product.url)) continue;

            const dbStock = existingStock.get(product.url);
            if (dbStock === undefined) {
              // Not in DB → genuinely new product
              seenUrls.add(product.url);
              newProducts.push(product);
            } else if (dbStock === 'out_of_stock') {
              // Back-in-stock event — was OOS in DB, now in stock on page
              seenUrls.add(product.url);
              newProducts.push(product);
              backInStockUrls.add(product.url);
              backInStockCount++;
            }
            // else: dbStock is 'in_stock', 'unknown', or null → already known, skip
          }
          if (backInStockCount > 0) {
            console.log(`[WatermarkCrawler] ${domain}: full-catalog-sweep detected ${backInStockCount} back-in-stock product(s) on page ${pageNum} of ${catalogUrl}`);
          }
        }
      }

      // Try adapter-discovered next page first; fall back to manual increment
      const $ = cheerio.load(html);
      const adapterNext: string | null = adapter.getNextPageUrl?.($, currentUrl) ?? null;
      if (adapterNext && adapterNext !== currentUrl) {
        currentUrl = adapterNext;
      } else {
        const nextPageNum = pageNum + 1;
        const built = buildPaginatedUrl(catalogUrl, nextPageNum, paginationPattern);
        if (!built || built === currentUrl) break;
        currentUrl = built;
      }
      pageNum++;

      await randomDelay(300, 800);
    }
  }

  return {
    products: newProducts,
    pagesScanned,
    tokensUsed,
    newWatermarkUrl: newProducts[0]?.url || null,
    newestDateSeen: null,
    backInStockUrls,
  };
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run a Tier 1 watermark crawl for a site.
 * Selects method based on siteProfile.crawlers.watermark.method.
 */
export async function crawlWatermark(params: {
  siteId: string;
  url: string;
  domain: string;
  baseBudget: number;
  capacity: number;
  lastWatermarkUrl: string | null;
  lastWatermarkDate?: string | null;  // ISO date from previous crawl
  hasWaf?: boolean;
  wmKnownThreshold?: number;         // Configurable via crawlTuning
  wmOldDateThreshold?: number;        // Configurable via crawlTuning
}): Promise<WatermarkResult> {
  const { siteId, url, domain, baseBudget, capacity, lastWatermarkUrl, lastWatermarkDate, hasWaf } = params;
  const startTime = Date.now();

  const { adapter } = await getAdapterForUrl(url);
  const origin = new URL(url).origin;

  // Resolve watermark method from site profile (nested under crawlers.watermark.method)
  const entry = _getSiteCacheEntry(domain.replace(/^www\./, ''));
  const watermarkMethod: string =
    entry?.siteProfile?.crawlers?.watermark?.method || 'navigate-from-watermark';
  // Profile catalogUrls may be stored relative (e.g. canadasgunstore: "/departments/...")
  // or absolute (e.g. triggersandbows: "https://www.../store/..."). full-catalog-sweep
  // passes these directly to fetchPageWithMeta which can't resolve relative paths
  // (http-client.ts:442 throws on `new URL(rel).hostname`, then axios rejects). Normalize
  // to absolute here so Method C works for both storage conventions. Matches the idiom
  // already used by generic-retail.ts:198 / generic.ts:153 / maintain-readiness.ts:891.
  const rawCatalogUrls: string[] = entry?.siteProfile?.catalogUrls || [];
  const catalogUrls = rawCatalogUrls.map(u => {
    if (u.startsWith('http')) return u;
    // Protocol-relative `//cdn.x/y` → `https://cdn.x/y`. Without this, the
    // raw concat below would produce `https://site.com//cdn.x/y` which
    // resolves to the SITE's own host instead of the CDN. Mirrors the
    // resolveThumbUrl idiom at product-verifier.ts:843.
    if (u.startsWith('//')) return `https:${u}`;
    return `${origin}${u}`;
  });
  const paginationPattern = entry?.siteProfile?.paginationPattern;
  const profilePerPage: number | undefined = entry?.siteProfile?.perPage ?? undefined;

  const CONSECUTIVE_KNOWN_THRESHOLD = params.wmKnownThreshold ?? 40;
  const CONSECUTIVE_OLD_DATE_THRESHOLD = params.wmOldDateThreshold ?? 25;

  try {
    let allNewProducts: CatalogProduct[] = [];
    let pagesScanned = 0;
    let tokensUsed = 0;
    let newWatermarkUrl: string | null = null;
    let newestDateSeen: string | null = null;
    let backInStockUrls: Set<string> | undefined;

    if (watermarkMethod === 'full-catalog-sweep') {
      // ── Method C: full-catalog-sweep ──────────────────────────────────
      console.log(`[WatermarkCrawler] ${domain}: using full-catalog-sweep method (${catalogUrls.length} catalogUrls)`);

      if (catalogUrls.length === 0) {
        console.log(`[WatermarkCrawler] ${domain}: full-catalog-sweep requested but no catalogUrls in profile`);
      }

      const result = await crawlFullCatalogSweep({
        siteId, domain, baseBudget, capacity, hasWaf,
        adapter, origin, catalogUrls, paginationPattern,
      });

      pagesScanned = result.pagesScanned;
      tokensUsed = result.tokensUsed;
      allNewProducts = result.products;
      newWatermarkUrl = result.newWatermarkUrl;
      newestDateSeen = result.newestDateSeen;
      backInStockUrls = result.backInStockUrls;
    } else if (watermarkMethod === 'api-date-since-watermark' && adapter.fetchCatalogPage) {
      // ── Method A: API date filter (oldest→newest from watermark) ────────
      console.log(`[WatermarkCrawler] ${domain}: using api-date-since-watermark method`);

      const result = await crawlApiDateFilter({
        siteId, url, domain, baseBudget, capacity,
        lastWatermarkUrl, lastWatermarkDate, hasWaf,
        wmKnownThreshold: CONSECUTIVE_KNOWN_THRESHOLD,
        wmOldDateThreshold: CONSECUTIVE_OLD_DATE_THRESHOLD,
        adapter, origin,
        perPage: profilePerPage,
      });

      pagesScanned = result.pagesScanned;
      tokensUsed = result.tokensUsed;

      if (!result.fallbackToMethodB) {
        allNewProducts = result.products;
        newWatermarkUrl = result.newWatermarkUrl;
        newestDateSeen = result.newestDateSeen;
      } else {
        // Fall back to Method B with remaining budget
        console.log(`[WatermarkCrawler] ${domain}: falling back to navigate-from-watermark`);
        const fallback = await crawlNavigateThenWalk({
          siteId, url, domain, baseBudget, capacity,
          lastWatermarkUrl, lastWatermarkDate, hasWaf,
          wmKnownThreshold: CONSECUTIVE_KNOWN_THRESHOLD,
          wmOldDateThreshold: CONSECUTIVE_OLD_DATE_THRESHOLD,
          adapter, origin,
          useApi: !!adapter.fetchCatalogPage,
          perPage: profilePerPage,
        });

        pagesScanned += fallback.pagesScanned;
        tokensUsed += fallback.tokensUsed;
        allNewProducts = fallback.products;
        newWatermarkUrl = fallback.newWatermarkUrl;
        newestDateSeen = fallback.newestDateSeen;
      }
    } else {
      // ── Method B: navigate-from-watermark (default) ─────────────────────
      const methodLabel = watermarkMethod === 'api-date-since-watermark'
        ? 'navigate-from-watermark (api-date-since-watermark requested but no API adapter)'
        : 'navigate-from-watermark';
      console.log(`[WatermarkCrawler] ${domain}: using ${methodLabel} method`);

      const result = await crawlNavigateThenWalk({
        siteId, url, domain, baseBudget, capacity,
        lastWatermarkUrl, lastWatermarkDate, hasWaf,
        wmKnownThreshold: CONSECUTIVE_KNOWN_THRESHOLD,
        wmOldDateThreshold: CONSECUTIVE_OLD_DATE_THRESHOLD,
        adapter, origin,
        useApi: !!adapter.fetchCatalogPage,
        perPage: profilePerPage,
      });

      pagesScanned = result.pagesScanned;
      tokensUsed = result.tokensUsed;
      allNewProducts = result.products;
      newWatermarkUrl = result.newWatermarkUrl;
      newestDateSeen = result.newestDateSeen;
    }

    // Save to ProductIndex (indexing + content-change hook).
    // `backInStockUrls` (only set by full-catalog-sweep) forces previously-OOS
    // products to be included in the saved array so they get re-indexed; the
    // generic contentChangedAt hook then records the restock. Alert matching is
    // handled by the cursor-based dispatcher, not here.
    await saveProducts(siteId, allNewProducts, backInStockUrls);

    // Broken-T1 detector: a healthy run scans >=1 page even when it finds the
    // watermark on page 1 (found=0, pages=1 is fine). pages=0 means the crawl
    // produced NO signal at all — null adapter with no HTML extractor, a throw
    // on page 1, or fetchHtml returning null. Surface it instead of returning a
    // silent status:'success' productsFound:0 pages:0.
    if (pagesScanned === 0) {
      const warnMsg = `[WatermarkCrawler] ${domain}: T1 scanned 0 pages (watermark method='${watermarkMethod}') — crawl produced no signal; watermark/adapter likely misconfigured`;
      console.warn(warnMsg);
      // DebugEvent.type has no 'warn' member (see debugLog.ts:7-19); use the
      // file's established 'info' convention (matches the budget-exhaustion
      // pushEvent above). console.warn carries the severity to the logs.
      pushEvent({ type: 'info', message: warnMsg });
    }

    return {
      status: 'success',
      productsFound: allNewProducts.length,
      pagesScanned,
      tokensUsed,
      newWatermarkUrl: newWatermarkUrl || lastWatermarkUrl,
      newWatermarkDate: newestDateSeen || lastWatermarkDate || undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const status = msg.includes('timeout') ? 'timeout'
      : msg.includes('429') ? 'blocked'
      : 'fail';

    return {
      status,
      productsFound: 0,
      pagesScanned: 0,
      tokensUsed: 0,
      newWatermarkUrl: lastWatermarkUrl,
      newWatermarkDate: lastWatermarkDate || undefined,
      errorMessage: msg,
      responseTimeMs: Date.now() - startTime,
    };
  }
}

// ── Check which URLs already exist in ProductIndex ─────────────────────────

// saveProducts and checkExistingProducts are now imported from './product-upsert'
