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
import { fetchPage, randomDelay, pickUserAgent } from './http-client';
import { isBareDomain, resolveUrl } from './utils/url';
import { detectSiteType, isLoginPage } from './utils/html';
import { extractPrice, extractPriceFromTitle } from './utils/price';
import { getAdapterForUrl } from './adapter-registry';

export type { ScrapedMatch, ScrapeResult, ScrapeOptions } from './types';
export { fetchPage } from './http-client';

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
  if (matches.length === 0) {
    try {
      // Determine which URL to scrape
      let scrapeUrl = websiteUrl;
      if (isBareDomain(websiteUrl)) {
        // Use the adapter's search URL or a custom pattern from the DB
        const origin = new URL(websiteUrl).origin;
        if (searchUrlPattern) {
          scrapeUrl = `${origin}${searchUrlPattern.replace('{keyword}', encodeURIComponent(keyword))}`;
        } else {
          scrapeUrl = adapter.getSearchUrl(origin, keyword);
        }
      }

      const html = await fetchPage(scrapeUrl, options.cookies);

      // Check for login page (forums)
      const $ = cheerio.load(html);
      if (adapter.siteType === 'forum' && isLoginPage($)) {
        loginRequired = true;
      }

      if (!loginRequired) {
        // Use adapter-specific extraction
        const extractionOptions: ExtractionOptions = {
          inStockOnly: options.inStockOnly,
          maxPrice: options.maxPrice,
        };
        matches = adapter.extractMatches($, keyword, scrapeUrl, extractionOptions);

        // Set seller for all matches from known sites
        const hostname = new URL(websiteUrl).hostname;
        for (const match of matches) {
          if (!match.seller) match.seller = hostname;
        }

        // Paginate if adapter supports it
        if (matches.length > 0 && adapter.getNextPageUrl && !options.fast) {
          const maxPages = options.maxPages ?? 3;
          let currentUrl = scrapeUrl;
          let currentHtml = html;

          for (let page = 2; page <= maxPages; page++) {
            const $page = cheerio.load(currentHtml);
            const nextUrl = adapter.getNextPageUrl($page, currentUrl);
            if (!nextUrl) break;

            try {
              await randomDelay(300, 800);
              currentHtml = await fetchPage(nextUrl, options.cookies);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      errors.push(`HTML scrape failed: ${msg}`);
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
    errors: errors.length > 0 ? errors : undefined,
  };
}
