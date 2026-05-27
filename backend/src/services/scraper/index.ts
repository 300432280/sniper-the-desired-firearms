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
import { prisma } from '../../lib/prisma';

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

  // Auto-detect hasWaf from the site record if not explicitly set
  if (options.hasWaf === undefined) {
    try {
      const domain = new URL(websiteUrl).hostname.replace(/^www\./, '');
      const site = await prisma.monitoredSite.findFirst({
        where: { OR: [{ domain }, { domain: `www.${domain}` }] },
        select: { hasWaf: true },
      });
      if (site?.hasWaf) options.hasWaf = true;
    } catch { /* ignore — non-critical */ }
  }

  // Compute the "site base URL" -- origin, plus a LOCALE path prefix only
  // when the configured URL path is exactly a known locale code. Example:
  // groupepronature.ca's configured URL is `https://groupepronature.ca/en`;
  // without /en, Shopify's /search/suggest.json returns French product titles
  // even though the operator picked the English version.
  //
  // The locale-code allowlist matters: westernmetal.ca's configured URL is
  // `https://westernmetal.ca/shooting/` (a SUBSITE path, not a locale).
  // Treating /shooting/ as a locale prefix breaks the search URL. So we only
  // append the path when it matches a recognized 2-letter locale code.
  const __u = new URL(websiteUrl);
  const __localeRe = /^\/(en|fr|de|es|it|pt|nl|ja|zh|ko)(\/.*)?$/i;
  const siteBase = __localeRe.test(__u.pathname)
    ? __u.origin + __u.pathname.replace(/\/$/, '').replace(/\/.+/, m => m.match(__localeRe) ? '/' + m.split('/')[1] : '')
    : __u.origin;

  // Step 1: Try API-based search if adapter supports it
  if (adapter.searchViaApi) {
    try {
      const apiMatches = await adapter.searchViaApi(siteBase, keyword, options);
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
  let scrapedFromSearchUrl = false; // true when we built a search URL via the adapter -- post-filter must be skipped
  if (matches.length === 0) {
    // Determine which URL to scrape
    let scrapeUrl = websiteUrl;
    if (isBareDomain(websiteUrl) || siteBase !== __u.origin) {
      // Use siteBase (origin + locale prefix), not bare origin, so the search
      // URL hits the configured locale's endpoint (e.g. /en/search on bilingual sites).
      if (searchUrlPattern) {
        scrapeUrl = `${siteBase}${searchUrlPattern.replace('{keyword}', encodeURIComponent(keyword))}`;
      } else {
        scrapeUrl = adapter.getSearchUrl(siteBase, keyword);
      }
      scrapedFromSearchUrl = true;
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
            isSearchPage: true,
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

  // Drop matches with empty/missing URLs (extractLink rejects image-extension
  // hrefs, so a match here with an empty url was a non-product element the
  // selectors matched only by mistake).
  matches = matches.filter(m => m.url && m.url.length > 0);

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
  // Skip for API-sourced results AND when we scraped a search-results URL --
  // both cases the upstream search already matched. Re-filtering by literal
  // keyword silently drops foreign-language hits ("Carabine" vs "rifle") and
  // synonym/model-name hits ("Aridus Remington 870" -> "rifle").
  if (matches.length > 0 && keyword.length >= 2 && !usedApiSearch && !scrapedFromSearchUrl) {
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
