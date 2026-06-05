// backend/scripts/probe/runtime-simulate/index.ts
//
// Gap 1 — pre-bootstrap runtime URL fetchability simulator.
//
// Audit-only check that simulates how the production catalog crawler would
// fetch each candidate catalogUrl, BEFORE those URLs are promoted to DB.
//
// Why this exists: canadasgunstore.ca had a correct audit (right umbrella URL,
// right adapter) that the production runtime could not actually fetch due to a
// relative-path bug (fixed via A1). The audit never tried to fetch the URL
// through the same code path the runtime would use, so the gap went undetected.
//
// This module re-uses production helpers (no fresh HTTP stack):
//   - fetchPageWithMeta from src/services/scraper/http-client.ts (static path)
//   - fetchWithPlaywright from src/services/scraper/playwright-fetcher.ts (WAF / fallback)
//   - adapter.fetchCatalogPage (API-first when available)
//   - adapter.extractCatalogProducts (HTML fallback)
// Same Playwright-fallback policy as backend/src/services/watermark-crawler.ts:71-125.
//
// Pure audit — no DB writes, no token-budget consumption.

import * as cheerio from 'cheerio';
import { fetchPageWithMeta } from '../../../src/services/scraper/http-client';
import type { SiteAdapter, CatalogProduct } from '../../../src/services/scraper/types';

// ── URL normalization (A1 idiom) ─────────────────────────────────────────────

/**
 * Resolve a catalog URL candidate against the site origin. Same idiom as the
 * A1 fix: protocol-relative `//host/path` → `https:` prefix; absolute kept as-is;
 * relative joined to siteUrl with no double-slash.
 */
export function resolveCatalogUrl(siteUrl: string, candidate: string): string {
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) return candidate;
  if (candidate.startsWith('//')) return 'https:' + candidate;
  const base = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
  const path = candidate.startsWith('/') ? candidate : '/' + candidate;
  return base + path;
}

// ── WAF / challenge body detection (shared) ─────────────────────────────────
//
// Used in two places: (a) the static-fetch upgrade trigger inside
// fetchHtmlForSimulation, and (b) the post-Playwright check that closes the
// silent-200 failure mode where a challenge page survives Playwright. Mirrors
// the markers list in watermark-crawler.ts:107-121.
const CHALLENGE_MARKERS = [
  '_Incapsula_Resource',
  'Access Denied',
  '403 Forbidden',
  'cf-browser-verification',
  'challenge-platform',
  'Just a moment...',
  'Checking your browser',
  'Attention Required',
  'cf-challenge',
];

function looksLikeChallengeBody(html: string): boolean {
  if (html.length < 2000) return true;
  for (const marker of CHALLENGE_MARKERS) {
    if (html.includes(marker)) return true;
  }
  return false;
}

// ── Nav-URL filter (local mirror of base.ts:360-379) ────────────────────────
//
// `AbstractAdapter.isNavUrl` is `protected`, so it can't be called from outside
// the adapter. This is a SHORT local regex matching the SAME patterns as
// backend/src/services/scraper/adapters/base.ts:360-379. Kept in sync with that
// method — if the production filter changes, update this too.
function looksLikeNavUrl(url: string): boolean {
  if (/\/(product-category|categorie-produit|category|categories|collections|brands|tags|subcategory|shop\/?\?|manufacturer)\b/i.test(url)) return true;
  if (/\/(wishlist|cart|checkout|account|login|register|registration|giftcert|contact|about|faq|privacy|terms|shipping|returns|blog|news|content\.php|pages?\/)/i.test(url)) return true;
  if (/\/(buysell|sellers|forsale)(\/|$|\?)/i.test(url)) return true;
  if (/\/(shoppingcart|myaccount|default)\.(asp|php|htm)/i.test(url)) return true;
  if (/\/search\.php/i.test(url)) return true;
  if (/\/giftcertificates/i.test(url)) return true;
  try {
    const path = new URL(url).pathname;
    if (path === '/' || path === '') return true;
  } catch { /* ignore parse errors */ }
  return false;
}

// ── Nav-title filter (local mirror of base.ts:385-426) ──────────────────────
//
// `AbstractAdapter.isNavTitle` is `protected`, so it can't be called from
// outside the adapter. This is a local mirror matching the same patterns as
// backend/src/services/scraper/adapters/base.ts:385-426. Kept in sync with
// that method — if the production filter changes, update this too. Same
// kept-in-sync compromise as `looksLikeNavUrl` above.
function looksLikeNavTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 5 && !/\d/.test(t)) return true;
  const NAV_PATTERNS = [
    /^(home|homepage|search|login|register|sign\s*in|sign\s*up|contact|about|faq|help|cart|checkout|wishlist|account|menu|view\s+cart|my\s+account|sign\s*out)$/i,
    /^(clearance|sale|new|new\s+products?|best\s+sellers?|featured|on\s+sale|specials?)$/i,
    /^(manufacturers?|brands?|categories|all\s+products?|shop\s+all|view\s+all|see\s+all)$/i,
    /^(rifles?|shotguns?|handguns?|pistols?|revolvers?|ammunition|ammo|optics?|accessories|parts|magazines?)$/i,
    /^(semi[- ]?automatic|bolt[- ]?action|lever[- ]?action|pump[- ]?action|single[- ]?shot|break[- ]?action|side[- ]?by[- ]?side|over[- ]?under)$/i,
    /^(jobs?|services?|vehicles?|real\s+estate|used\s+furniture|hay\s+for\s+sale|used\s+farm|farm\s+equipment)$/i,
    /^(fish|fishing|hunt|hunting|outdoor|outdoors|camping|archery|marine|apparel|clothing|footwear)$/i,
    /^(search\s+find|return\s+to|go\s+to|click\s+here|read\s+more|learn\s+more|view\s+details?|see\s+more)/i,
    /homepage\s+return/i,
  ];
  for (const pat of NAV_PATTERNS) {
    if (pat.test(t)) return true;
  }
  if (!/[a-zA-Z]/.test(t)) return true;
  if (/^(CA)?\$[\d,.]+$/i.test(t)) return true;
  // Bare URL or hostname extracted as a "title"
  if (/^(https?:\/\/|www\.)/i.test(t)) return true;
  if (/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,24}\/?$/i.test(t)) return true;
  if (/^(derringer|tactical|black\s*powder|lower\s+receivers?|muzzleloaders?)$/i.test(t)) return true;
  if (/^(contact\s*us|gun\s+auctions?|featured\s+items?|import\s*\/?\s*export|custom\s+engraving)$/i.test(t)) return true;
  if (/^(parts\s*&\s*gear|us\s+store|news\s*&?\s*events?|commonly\s+asked|warranty|terms|privacy|create\s+an?\s+account)$/i.test(t)) return true;
  if (/^(puppies|dogs|trucks|furniture|used\s+\w+|see\s+the\s+newest)/i.test(t)) return true;
  if (/^(out of stock!?|sold out|choose options?|quick view|product view|buy now|add to cart|view product|sitemap|compare)/i.test(t)) return true;
  if (/^\|?\s*(sitemap|copyright|all rights)/i.test(t)) return true;
  if (/^(carabines?|fusils?|armes?\s+(à|a)\s+feu|salines?|chasse|pêche|pech[eé]|vêtements?|accessoires?)$/i.test(t)) return true;
  if (/equipment\s+exchanging.*responsibilit/i.test(t)) return true;
  if (/^ee\s+transactions/i.test(t)) return true;
  return false;
}

// ── Soft-404 sentinel scan ───────────────────────────────────────────────────
//
// Some sites return HTTP 200 + a "no results / category empty / related
// products" page rather than a real 404. Such pages can pass assertions 1-4
// when the adapter still extracts the related-products carousel. Scan the
// first 5000 chars of the raw HTML body (lowercased) for known sentinels.
const SOFT_NOT_FOUND_SENTINELS = [
  'page not found',
  'no products found',
  '0 results',
  'category does not exist',
  'no items match',
  'this category is empty',
];

function detectSoftNotFound(html: string): string | null {
  const sample = html.slice(0, 5000).toLowerCase();
  for (const sentinel of SOFT_NOT_FOUND_SENTINELS) {
    if (sample.includes(sentinel)) return sentinel;
  }
  return null;
}

// ── HTML fetch with WAF / Playwright fallback ───────────────────────────────
//
// Mirrors watermark-crawler.ts:71-125. fetchHtml there is not exported, and the
// task documents fetchPageWithMeta as the allowed alternative. Same policy:
//   - hasWaf=true   → Playwright direct (45s timeout)
//   - hasWaf=false  → static first; fall back to Playwright if challenge markers
//                     or html < 2000b (after a non-empty static response)
//
// RISK 1 fix: after ANY Playwright path, re-check the returned HTML against the
// challenge markers + minimum size. If it still looks like a challenge body,
// surface httpStatus=null with an explicit reason — never silently pass as 200.
async function fetchHtmlForSimulation(
  pageUrl: string,
  hasWaf?: boolean,
): Promise<{ html: string | null; httpStatus: number | null; error?: string; challengeAfterPlaywright?: boolean }> {
  if (hasWaf) {
    try {
      const { fetchWithPlaywright } = await import('../../../src/services/scraper/playwright-fetcher');
      const pw = await fetchWithPlaywright(pageUrl, { timeout: 45000 });
      if (!pw.html) {
        return { html: null, httpStatus: null };
      }
      if (looksLikeChallengeBody(pw.html)) {
        return { html: pw.html, httpStatus: null, challengeAfterPlaywright: true };
      }
      return { html: pw.html, httpStatus: 200 };
    } catch (err) {
      return { html: null, httpStatus: null, error: `playwright: ${(err as Error).message}` };
    }
  }

  let html = '';
  let httpStatus: number | null = null;
  try {
    const result = await fetchPageWithMeta(pageUrl, undefined, { difficultyRating: 0 });
    html = result.html;
    httpStatus = result.statusCode ?? null;
  } catch (err) {
    // Static fetch failed — try Playwright once as fallback
    try {
      const { fetchWithPlaywright } = await import('../../../src/services/scraper/playwright-fetcher');
      const pw = await fetchWithPlaywright(pageUrl, { timeout: 30000 });
      if (!pw.html) {
        return { html: null, httpStatus: null, error: `static+playwright failed: ${(err as Error).message} / empty playwright html` };
      }
      if (looksLikeChallengeBody(pw.html)) {
        return { html: pw.html, httpStatus: null, error: `static failed: ${(err as Error).message}`, challengeAfterPlaywright: true };
      }
      html = pw.html;
      httpStatus = 200;
    } catch (err2) {
      return { html: null, httpStatus: null, error: `static+playwright failed: ${(err as Error).message} / ${(err2 as Error).message}` };
    }
  }

  // Mirror watermark-crawler.ts:107-121: small-or-blocked → try Playwright once
  const isBlockedOrEmpty = html.length > 0 && looksLikeChallengeBody(html);
  if (isBlockedOrEmpty) {
    try {
      const { fetchWithPlaywright } = await import('../../../src/services/scraper/playwright-fetcher');
      const pw = await fetchWithPlaywright(pageUrl, { timeout: 30000 });
      if (pw.html && pw.html.length > html.length) {
        if (looksLikeChallengeBody(pw.html)) {
          return { html: pw.html, httpStatus: null, challengeAfterPlaywright: true };
        }
        html = pw.html;
        httpStatus = 200;
      }
    } catch {
      // Keep what we have
    }
  }

  return { html: html || null, httpStatus };
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface SimulateRuntimeFetchArgs {
  /** e.g. "https://www.canadasgunstore.ca" — no trailing slash. */
  siteUrl: string;
  /** Candidate catalogUrls from the audit. May be relative or absolute. */
  catalogUrls: string[];
  /** Resolved via getAdapterForUrl. Caller provides. */
  adapter: SiteAdapter;
  /** Honored exactly like the production crawler. */
  hasWaf?: boolean;
}

export interface SimulatedUrlResult {
  catalogUrl: string;
  absoluteUrl: string;
  httpStatus: number | null;
  productCount: number;
  productsWithUrlAndTitle: number;
  navUrlMatches: number;
  /** Sentinel string that triggered the soft-404 detection, or null. */
  softNotFoundDetected: string | null;
  /** Which path produced the product count for assertions 2-4. */
  extractionPath: 'api' | 'html' | 'none';
  error?: string;
  /** All 5 assertions held. */
  pass: boolean;
  reasons: string[];
}

export interface SimulateRuntimeFetchResult {
  passed: boolean;
  results: SimulatedUrlResult[];
  summary: string;
}

/**
 * Simulate the production catalog crawl against each candidate catalogUrl.
 *
 * Per catalogUrl assertions (ALL 5 must hold for that URL to pass):
 *   1. Resolved absolute URL fetch returns HTTP 200 via the production helpers
 *      (honors `hasWaf` — Playwright path when true). A Playwright response
 *      that still looks like a WAF challenge body fails this assertion.
 *   2. Product extraction returns at least 5 products. When the adapter
 *      exposes `fetchCatalogPage` (Shopify, WC, Ecwid-on-WordPress), that
 *      API path is tried FIRST; HTML extraction is the fallback.
 *   3. ≥80% of returned products have non-empty `url` AND `title`, AND none
 *      of those titles look like nav/utility labels (local mirror of
 *      AbstractAdapter.isNavTitle).
 *   4. ZERO returned products look like nav/utility URLs (local regex mirroring
 *      AbstractAdapter.isNavUrl).
 *   5. Raw HTML body does NOT contain a soft-404 sentinel ("page not found",
 *      "no products found", "0 results", etc).
 *
 * Top-level `passed` = ALL urls pass. Caller decides whether to set
 * `siteProfile.extractionTested = true`.
 */
export async function simulateRuntimeFetch(
  args: SimulateRuntimeFetchArgs,
): Promise<SimulateRuntimeFetchResult> {
  const { siteUrl, catalogUrls, adapter, hasWaf } = args;
  const results: SimulatedUrlResult[] = [];

  for (const candidate of catalogUrls) {
    const absoluteUrl = resolveCatalogUrl(siteUrl, candidate);
    const reasons: string[] = [];
    let httpStatus: number | null = null;
    let productCount = 0;
    let productsWithUrlAndTitle = 0;
    let navUrlMatches = 0;
    let softNotFoundDetected: string | null = null;
    let extractionPath: 'api' | 'html' | 'none' = 'none';
    let errMsg: string | undefined;
    let products: CatalogProduct[] = [];

    // Assertion 1: HTTP 200 (and NOT a surviving WAF challenge)
    const fetchResult = await fetchHtmlForSimulation(absoluteUrl, hasWaf);
    httpStatus = fetchResult.httpStatus;
    if (fetchResult.error) errMsg = fetchResult.error;

    let pass1 = false;
    if (fetchResult.challengeAfterPlaywright) {
      reasons.push('assertion-1 FAIL: WAF challenge body survived Playwright');
    } else if (httpStatus === 200 && fetchResult.html) {
      pass1 = true;
      reasons.push('assertion-1 OK: HTTP 200');
    } else {
      reasons.push(`assertion-1 FAIL: status=${httpStatus ?? 'null'}${errMsg ? ` (${errMsg})` : ''}`);
    }

    // Assertion 2: ≥5 products. API-first when adapter exposes fetchCatalogPage.
    let pass2 = false;
    if (pass1 && fetchResult.html) {
      let apiAttemptError: string | null = null;
      if (typeof adapter.fetchCatalogPage === 'function') {
        try {
          const page = await adapter.fetchCatalogPage(siteUrl, 1, { hasWaf });
          if (page && Array.isArray(page.products) && page.products.length > 0) {
            products = page.products;
            extractionPath = 'api';
          } else {
            apiAttemptError = page === null ? 'fetchCatalogPage returned null' : 'fetchCatalogPage returned 0 products';
          }
        } catch (err) {
          apiAttemptError = `fetchCatalogPage threw: ${(err as Error).message}`;
        }
      }

      if (extractionPath === 'none') {
        try {
          const $ = cheerio.load(fetchResult.html);
          if (!adapter.extractCatalogProducts) {
            reasons.push('assertion-2 FAIL: adapter has no extractCatalogProducts');
            if (apiAttemptError) reasons.push(`assertion-2 note: ${apiAttemptError}`);
          } else {
            products = adapter.extractCatalogProducts($, absoluteUrl);
            extractionPath = 'html';
            if (apiAttemptError) reasons.push(`assertion-2 note: ${apiAttemptError}; fell back to HTML`);
          }
        } catch (err) {
          reasons.push(`assertion-2 FAIL: extraction threw ${(err as Error).message}`);
          errMsg = errMsg || (err as Error).message;
        }
      }

      if (extractionPath !== 'none') {
        productCount = products.length;
        if (productCount >= 5) {
          pass2 = true;
          reasons.push(`assertion-2 OK: ${productCount} products (path=${extractionPath})`);
        } else if (apiAttemptError && extractionPath === 'html') {
          reasons.push(`assertion-2 FAIL: API path returned 0; HTML path returned ${productCount}`);
        } else {
          reasons.push(`assertion-2 FAIL: ${productCount} products (<5, path=${extractionPath})`);
        }
      }
    } else if (!pass1) {
      reasons.push('assertion-2 SKIP: assertion-1 failed');
    }

    // Assertion 3: ≥80% have non-empty url AND title AND title is not nav-shaped
    let pass3 = false;
    if (pass2 && products.length > 0) {
      productsWithUrlAndTitle = products.filter(p =>
        !!(p.url && p.url.trim()) &&
        !!(p.title && p.title.trim()) &&
        !looksLikeNavTitle(p.title),
      ).length;
      const ratio = productsWithUrlAndTitle / products.length;
      if (ratio >= 0.8) {
        pass3 = true;
        reasons.push(`assertion-3 OK: ${productsWithUrlAndTitle}/${products.length} have url+title and non-nav title (${(ratio * 100).toFixed(0)}%)`);
      } else {
        reasons.push(`assertion-3 FAIL: only ${productsWithUrlAndTitle}/${products.length} have url+title and non-nav title (${(ratio * 100).toFixed(0)}% < 80%)`);
      }
    } else if (!pass2) {
      reasons.push('assertion-3 SKIP: assertion-2 failed');
    }

    // Assertion 4: ZERO products look like nav URLs
    let pass4 = false;
    if (pass2 && products.length > 0) {
      navUrlMatches = products.filter(p => p.url && looksLikeNavUrl(p.url)).length;
      if (navUrlMatches === 0) {
        pass4 = true;
        reasons.push('assertion-4 OK: 0 nav-shaped URLs');
      } else {
        reasons.push(`assertion-4 FAIL: ${navUrlMatches} products look like nav/utility URLs`);
      }
    } else if (!pass2) {
      reasons.push('assertion-4 SKIP: assertion-2 failed');
    }

    // Assertion 5: no soft-404 sentinel in raw HTML body
    let pass5 = false;
    if (pass1 && fetchResult.html) {
      softNotFoundDetected = detectSoftNotFound(fetchResult.html);
      if (softNotFoundDetected === null) {
        pass5 = true;
        reasons.push('assertion-5 OK: no soft-404 sentinel');
      } else {
        reasons.push(`assertion-5 FAIL: soft-404 sentinel found ("${softNotFoundDetected}")`);
      }
    } else if (!pass1) {
      reasons.push('assertion-5 SKIP: assertion-1 failed');
    }

    const pass = pass1 && pass2 && pass3 && pass4 && pass5;
    results.push({
      catalogUrl: candidate,
      absoluteUrl,
      httpStatus,
      productCount,
      productsWithUrlAndTitle,
      navUrlMatches,
      softNotFoundDetected,
      extractionPath,
      error: errMsg,
      pass,
      reasons,
    });
  }

  const passedCount = results.filter(r => r.pass).length;
  const passed = results.length > 0 && passedCount === results.length;
  const summary = `${passedCount}/${results.length} catalogUrls passed all 5 runtime-simulation assertions`;

  return { passed, results, summary };
}
