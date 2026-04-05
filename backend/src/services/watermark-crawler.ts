/**
 * Watermark Crawler — Tier 1 new-items crawl.
 *
 * TWO crawl methods based on siteProfile.t1ResumeMethod:
 *
 * Method A: "api-date-filter" (WooCommerce and other API sites with date support)
 *   - Query API with dateAfter=watermark_date, order=asc (oldest first)
 *   - Walk forward from watermark toward newest
 *   - Watermark = last product processed (gap-free on token exhaustion)
 *
 * Method B: "navigate-then-walk" (HTML sites, BigCommerce, default)
 *   - Navigate from page 1 (newest) toward older pages to FIND the watermark
 *   - Once found, walk BACK toward page 1, indexing new products
 *   - Watermark = last new product indexed (closest to newest)
 *   - Gap-free: always indexes from the watermark toward newest
 */

import { prisma } from '../lib/prisma';
import { getAdapterForUrl, _getSiteCacheEntry } from './scraper/adapter-registry';
import { fetchPageWithMeta, randomDelay } from './scraper/http-client';
import { pushEvent } from './debugLog';
import { consumeToken, getTier1Remaining } from './token-budget';
import { matchNewProducts } from './keyword-matcher';
import type { CatalogProduct, CatalogPage } from './scraper/types';
import { saveProducts, checkExistingProducts } from './product-upsert';
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
    const isBlockedOrEmpty = html.length < 2000 || html.includes('_Incapsula_Resource') ||
      html.includes('Access Denied') || html.includes('403 Forbidden') ||
      html.includes('cf-browser-verification') || html.includes('challenge-platform') ||
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

  if (adapter.extractCatalogProducts) {
    products = adapter.extractCatalogProducts($, pageUrl);
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
          products = adapter.extractCatalogProducts($pw, pageUrl);
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
}): Promise<{ products: CatalogProduct[]; pagesScanned: number; tokensUsed: number; newWatermarkUrl: string | null; newestDateSeen: string | null; fallbackToMethodB: boolean }> {
  const { siteId, domain, baseBudget, capacity, lastWatermarkDate, hasWaf, adapter, origin } = params;

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
        perPage: 50,
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
}): Promise<{ products: CatalogProduct[]; pagesScanned: number; tokensUsed: number; newWatermarkUrl: string | null; newestDateSeen: string | null }> {
  const { siteId, url, domain, baseBudget, capacity, lastWatermarkUrl, lastWatermarkDate, hasWaf, adapter, origin, useApi } = params;
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

  if (useApi) {
    // API-based navigation (no date filter — just paginate newest-first)
    let page = 1;
    while (hasBudget(siteId, baseBudget, capacity) && collectedPages.length < MAX_COLLECTED_PAGES) {
      consumeToken(siteId, 1);
      tokensUsed++;

      let catalogPage: CatalogPage | null;
      try {
        catalogPage = await adapter.fetchCatalogPage(origin, page, { sortBy: 'newest', perPage: 50, hasWaf });
      } catch (err) {
        console.log(`[WatermarkCrawler] ${domain}: API page ${page} failed — ${err instanceof Error ? err.message : err}`);
        break;
      }
      // null = adapter doesn't support API crawl — fall through to HTML navigation
      if (catalogPage === null) break;
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
  } else {
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

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run a Tier 1 watermark crawl for a site.
 * Selects method based on siteProfile.t1ResumeMethod.
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

  // Resolve t1ResumeMethod from site profile
  const entry = _getSiteCacheEntry(domain.replace(/^www\./, ''));
  const t1ResumeMethod: string = entry?.siteProfile?.t1ResumeMethod || 'navigate-then-walk';

  const CONSECUTIVE_KNOWN_THRESHOLD = params.wmKnownThreshold ?? 40;
  const CONSECUTIVE_OLD_DATE_THRESHOLD = params.wmOldDateThreshold ?? 25;

  try {
    let allNewProducts: CatalogProduct[] = [];
    let pagesScanned = 0;
    let tokensUsed = 0;
    let newWatermarkUrl: string | null = null;
    let newestDateSeen: string | null = null;

    if (t1ResumeMethod === 'api-date-filter' && adapter.fetchCatalogPage) {
      // ── Method A: API date filter (oldest→newest from watermark) ────────
      console.log(`[WatermarkCrawler] ${domain}: using api-date-filter method`);

      const result = await crawlApiDateFilter({
        siteId, url, domain, baseBudget, capacity,
        lastWatermarkUrl, lastWatermarkDate, hasWaf,
        wmKnownThreshold: CONSECUTIVE_KNOWN_THRESHOLD,
        wmOldDateThreshold: CONSECUTIVE_OLD_DATE_THRESHOLD,
        adapter, origin,
      });

      pagesScanned = result.pagesScanned;
      tokensUsed = result.tokensUsed;

      if (!result.fallbackToMethodB) {
        allNewProducts = result.products;
        newWatermarkUrl = result.newWatermarkUrl;
        newestDateSeen = result.newestDateSeen;
      } else {
        // Fall back to Method B with remaining budget
        console.log(`[WatermarkCrawler] ${domain}: falling back to navigate-then-walk`);
        const fallback = await crawlNavigateThenWalk({
          siteId, url, domain, baseBudget, capacity,
          lastWatermarkUrl, lastWatermarkDate, hasWaf,
          wmKnownThreshold: CONSECUTIVE_KNOWN_THRESHOLD,
          wmOldDateThreshold: CONSECUTIVE_OLD_DATE_THRESHOLD,
          adapter, origin,
          useApi: !!adapter.fetchCatalogPage,
        });

        pagesScanned += fallback.pagesScanned;
        tokensUsed += fallback.tokensUsed;
        allNewProducts = fallback.products;
        newWatermarkUrl = fallback.newWatermarkUrl;
        newestDateSeen = fallback.newestDateSeen;
      }
    } else {
      // ── Method B: navigate-then-walk (default) ─────────────────────────
      const methodLabel = t1ResumeMethod === 'api-date-filter'
        ? 'navigate-then-walk (api-date-filter requested but no API adapter)'
        : 'navigate-then-walk';
      console.log(`[WatermarkCrawler] ${domain}: using ${methodLabel} method`);

      const result = await crawlNavigateThenWalk({
        siteId, url, domain, baseBudget, capacity,
        lastWatermarkUrl, lastWatermarkDate, hasWaf,
        wmKnownThreshold: CONSECUTIVE_KNOWN_THRESHOLD,
        wmOldDateThreshold: CONSECUTIVE_OLD_DATE_THRESHOLD,
        adapter, origin,
        useApi: !!adapter.fetchCatalogPage,
      });

      pagesScanned = result.pagesScanned;
      tokensUsed = result.tokensUsed;
      allNewProducts = result.products;
      newWatermarkUrl = result.newWatermarkUrl;
      newestDateSeen = result.newestDateSeen;
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
