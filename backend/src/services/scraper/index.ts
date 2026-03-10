/**
 * Scraper Engine v2 — adapter-based orchestrator.
 *
 * New adapter-aware entry point. Callers can import from here to use
 * the adapter system, or continue importing from '../scraper' for the
 * legacy pipeline (which already uses the shared utility modules).
 *
 * Both paths use the same http-client, utilities, and types.
 */

import * as cheerio from 'cheerio';
import crypto from 'crypto';
import type { ScrapedMatch, ScrapeResult, ScrapeOptions, ExtractionOptions, SiteType } from './types';
import { fetchPage, fetchPageWithMeta, randomDelay, pickUserAgent } from './http-client';
import type { FetchResult } from './http-client';
import { isBareDomain, resolveUrl } from './utils/url';
import { detectSiteType, isLoginPage } from './utils/html';
import { extractPrice, extractPriceFromTitle } from './utils/price';
import { getAdapterForUrl } from './adapter-registry';

export type { ScrapedMatch, ScrapeResult, ScrapeOptions } from './types';
export { fetchPage, fetchPageWithMeta } from './http-client';
export type { FetchResult, DifficultySignals } from './http-client';

/**
 * Adapter-aware scrape: tries the registered adapter first (API + HTML),
 * then falls back to the legacy generic extraction.
 */
export async function scrapeWithAdapter(
  websiteUrl: string,
  keyword: string,
  options: ScrapeOptions = {}
): Promise<ScrapeResult> {
  if (!options.fast) await randomDelay();

  const { adapter, adapterType, searchUrlPattern } = await getAdapterForUrl(websiteUrl);
  let matches: ScrapedMatch[] = [];
  let loginRequired = false;
  let usedPlaywright = false;
  let usedApiSearch = false;
  const errors: string[] = [];

  // Step 1: Try API-based search if adapter supports it
  if (adapter.searchViaApi) {
    try {
      const origin = new URL(websiteUrl).origin;
      const apiMatches = await adapter.searchViaApi(origin, keyword, options);
      // Only use API results if they include prices; otherwise fall back to HTML for richer data
      const hasPrices = apiMatches.some(m => m.price != null);
      if (apiMatches.length > 0 && hasPrices) {
        matches = apiMatches;
        usedApiSearch = true;
        console.log(`[ScraperV2] ${adapter.name} API returned ${matches.length} matches for "${keyword}"`);
      } else if (apiMatches.length > 0) {
        console.log(`[ScraperV2] ${adapter.name} API returned ${apiMatches.length} matches but no prices, falling back to HTML`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      errors.push(`API search failed: ${msg}`);
      console.log(`[ScraperV2] ${adapter.name} API failed: ${msg}, falling back to HTML`);
    }
  }

  // Step 2: If API didn't find anything, fetch HTML and use adapter extraction
  let fetchMeta: ScrapeResult['fetchMeta'];
  if (matches.length === 0) {
    // Determine which URL to scrape
    let scrapeUrl = websiteUrl;
    if (isBareDomain(websiteUrl)) {
      const origin = new URL(websiteUrl).origin;
      if (searchUrlPattern) {
        scrapeUrl = `${origin}${searchUrlPattern.replace('{keyword}', encodeURIComponent(keyword))}`;
      } else {
        scrapeUrl = adapter.getSearchUrl(origin, keyword);
      }
    }
    let html = '';

    // Step 2a: Try static HTTP fetch first
    try {
      const fetchResult = await fetchPageWithMeta(scrapeUrl, options.cookies, {
        difficultyRating: options.difficultyRating,
      });
      html = fetchResult.html;

      fetchMeta = {
        responseTimeMs: fetchResult.responseTimeMs,
        statusCode: fetchResult.statusCode,
        signals: fetchResult.signals,
        headers: fetchResult.headers,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      errors.push(`HTML scrape failed: ${msg}`);
    }

    // Step 2b: If HTML is suspiciously small/empty (SPA/WAF block/fetch failure), try Playwright
    // Uses paginated fetcher to also capture JS-based pagination (Klevu, etc.)
    const isEmptyHtml = html.length < 2000 || html.includes('_Incapsula_Resource');
    let playwrightExtraPages: string[] = [];
    if (isEmptyHtml) {
      try {
        const { fetchWithPlaywrightPaginated } = await import('./playwright-fetcher');
        console.log(`[ScraperV2] ${html.length === 0 ? 'Static fetch failed' : `${html.length} bytes`}, trying Playwright for ${scrapeUrl}`);
        const pwResult = await fetchWithPlaywrightPaginated(scrapeUrl, {
          timeout: 45000,
          maxPages: options.fast ? 1 : 3,
        });
        html = pwResult.pages[0] || '';
        playwrightExtraPages = pwResult.pages.slice(1);
        usedPlaywright = true;

        if (fetchMeta) {
          fetchMeta.responseTimeMs = pwResult.responseTimeMs;
        }
        console.log(`[ScraperV2] Playwright fetched ${html.length} bytes for ${scrapeUrl}${playwrightExtraPages.length > 0 ? ` (+${playwrightExtraPages.length} extra pages)` : ''}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        errors.push(`Playwright fallback failed: ${msg}`);
        console.log(`[ScraperV2] Playwright fallback failed: ${msg}`);
      }
    }

    // Step 2c: Extract matches from HTML (static or Playwright-rendered)
    if (html.length > 0) {
      try {
        const $ = cheerio.load(html);

        if (adapter.siteType === 'forum' && isLoginPage($)) {
          loginRequired = true;
        }

        if (!loginRequired) {
          const extractionOptions: ExtractionOptions = {
            inStockOnly: options.inStockOnly,
            maxPrice: options.maxPrice,
          };
          matches = adapter.extractMatches($, keyword, scrapeUrl, extractionOptions);

          const hostname = new URL(websiteUrl).hostname;
          for (const match of matches) {
            if (!match.seller) match.seller = hostname;
          }

          // Step 2c-extra: Extract matches from Playwright extra pages (JS-based pagination)
          if (playwrightExtraPages.length > 0 && matches.length > 0) {
            for (let i = 0; i < playwrightExtraPages.length; i++) {
              const $extra = cheerio.load(playwrightExtraPages[i]);
              const pageMatches = adapter.extractMatches($extra, keyword, scrapeUrl, extractionOptions);
              for (const match of pageMatches) {
                if (!match.seller) match.seller = hostname;
              }
              if (pageMatches.length > 0) {
                matches.push(...pageMatches);
                console.log(`[ScraperV2] Playwright page ${i + 2}: +${pageMatches.length} matches`);
              }
            }
          }

          // Step 2d: If static HTML found very few matches, try Playwright as a last resort.
          // Triggers when: (a) 0 matches, or (b) suspiciously few matches from a large HTML
          // (indicates SPA where most content is JS-rendered, e.g. Next.js, Klevu)
          const isSuspiciouslyFew = matches.length > 0 && matches.length <= 5 && html.length > 100000;
          if ((matches.length === 0 || isSuspiciouslyFew) && !usedPlaywright && !isEmptyHtml) {
            try {
              // Use paginated Playwright to also capture JS-based pagination (Klevu, etc.)
              const { fetchWithPlaywrightPaginated } = await import('./playwright-fetcher');
              console.log(`[ScraperV2] ${matches.length} matches from static HTML, trying Playwright for ${scrapeUrl}`);
              const pwResult = await fetchWithPlaywrightPaginated(scrapeUrl, {
                timeout: 45000,
                maxPages: options.fast ? 1 : 3,
              });
              usedPlaywright = true;

              if (fetchMeta) {
                fetchMeta.responseTimeMs = pwResult.responseTimeMs;
              }

              // Extract matches from each paginated page
              matches = [];
              for (let i = 0; i < pwResult.pages.length; i++) {
                const $pw = cheerio.load(pwResult.pages[i]);
                const pageMatches = adapter.extractMatches($pw, keyword, scrapeUrl, extractionOptions);
                for (const match of pageMatches) {
                  if (!match.seller) match.seller = hostname;
                }
                matches.push(...pageMatches);
                if (i === 0 && pageMatches.length > 0) {
                  console.log(`[ScraperV2] Playwright recovered ${pageMatches.length} matches for ${scrapeUrl}`);
                } else if (i > 0 && pageMatches.length > 0) {
                  console.log(`[ScraperV2] Playwright page ${i + 1}: +${pageMatches.length} matches`);
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'unknown';
              errors.push(`Playwright fallback failed: ${msg}`);
            }
          }

          // Paginate via URL-based pagination (standard next-page links, not JS-based)
          // Skipped when Playwright was used (Playwright pagination already handled above)
          if (!usedPlaywright) {
            const difficultyMaxPages = (options.difficultyRating ?? 0) > 60 ? 1
              : (options.difficultyRating ?? 0) > 30 ? 2 : 3;
            const maxPages = Math.min(options.maxPages ?? 3, difficultyMaxPages);

            if (matches.length > 0 && adapter.getNextPageUrl && !options.fast && maxPages > 1) {
              let currentUrl = scrapeUrl;
              let currentHtml = html;

              for (let page = 2; page <= maxPages; page++) {
                const $page = cheerio.load(currentHtml);
                const nextUrl = adapter.getNextPageUrl($page, currentUrl);
                if (!nextUrl) break;

                try {
                  const paginationDelay = (options.difficultyRating ?? 0) > 30
                    ? [800, 1500] as const
                    : [300, 800] as const;
                  await randomDelay(paginationDelay[0], paginationDelay[1]);
                  currentHtml = await fetchPage(nextUrl, options.cookies, {
                    difficultyRating: options.difficultyRating,
                  });
                  const $next = cheerio.load(currentHtml);
                  const pageMatches = adapter.extractMatches($next, keyword, nextUrl, extractionOptions);
                  if (pageMatches.length === 0) break;

                  for (const match of pageMatches) {
                    if (!match.seller) match.seller = hostname;
                  }
                  matches.push(...pageMatches);
                  currentUrl = nextUrl;
                  console.log(`[ScraperV2] Page ${page}: +${pageMatches.length} matches`);
                } catch {
                  break;
                }
              }
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        errors.push(`Extraction failed: ${msg}`);
      }
    }
  }

  // Deduplicate
  if (matches.length > 1) {
    const seen = new Set<string>();
    matches = matches.filter(m => {
      const key = m.url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Post-extraction keyword relevance filter:
  // Ensure the keyword appears in the match title or URL slug as a word/token.
  // Skip for API-sourced results — the search API already matched against full
  // product content (title + description), so trust its relevance.
  if (matches.length > 0 && keyword.length >= 2 && !usedApiSearch) {
    const kw = keyword.toLowerCase();
    const beforeCount = matches.length;
    matches = matches.filter(m => {
      // Check title
      const title = m.title.toLowerCase();
      const idx = title.indexOf(kw);
      if (idx !== -1) {
        const charBefore = idx > 0 ? title[idx - 1] : ' ';
        if (!/[a-z0-9]/i.test(charBefore)) return true;
      }
      // Check URL slug (hyphens act as word boundaries)
      const urlSlug = (m.url.split('/').pop() || '').replace(/-/g, ' ').toLowerCase();
      const slugIdx = urlSlug.indexOf(kw);
      if (slugIdx !== -1) {
        const charBefore = slugIdx > 0 ? urlSlug[slugIdx - 1] : ' ';
        if (!/[a-z0-9]/i.test(charBefore)) return true;
      }
      return false;
    });
    if (beforeCount !== matches.length) {
      console.log(`[ScraperV2] Keyword filter: ${beforeCount} → ${matches.length} matches (removed ${beforeCount - matches.length} irrelevant)`);
    }
  }

  // Content hash
  const hashInput = matches.map((m) => m.url).sort().join('|');
  const contentHash = crypto
    .createHash('sha256')
    .update(hashInput || `empty:${websiteUrl}`)
    .digest('hex')
    .slice(0, 16);

  return {
    matches,
    contentHash,
    scrapedAt: new Date(),
    loginRequired,
    adapterUsed: adapterType,
    usedPlaywright,
    errors: errors.length > 0 ? errors : undefined,
    fetchMeta,
  };
}
