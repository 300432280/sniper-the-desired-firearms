/**
 * Product Verification Module
 *
 * Visits a single product's detail page URL and extracts current data.
 * This is the core of the maintain-phase crawler — it determines whether
 * a previously-indexed product is still alive, sold, wanted, or deleted,
 * and extracts fresh pricing/stock/title/thumbnail data.
 *
 * Fetch strategy:
 *   1. Plain HTTP first (fast, low resource)
 *   2. Playwright fallback for WAF sites or when blocked indicators detected
 *   3. Retry on transient Cloudflare errors (520/502/503)
 *
 * Data extraction layers (most reliable first):
 *   1. JSON-LD structured data (Shopify, WooCommerce, BigCommerce, Magento)
 *   2. Open Graph meta tags (universal)
 *   3. HTML selectors (last resort)
 */

import * as cheerio from 'cheerio';
import { extractPrice } from './scraper/utils/price';
import { resolveUrl } from './scraper/utils/url';
import { _getSiteCacheEntry } from './scraper/adapter-registry';

// ── Public interface ────────────────────────────────────────────────────────

export interface VerifyProductResult {
  status: 'alive' | 'sold' | 'wanted' | 'deleted' | 'error';
  title?: string;
  price?: number;
  regularPrice?: number;
  stockStatus?: 'in_stock' | 'out_of_stock';
  thumbnail?: string;
  responseTimeMs: number;
  statusCode?: number;
  errorMessage?: string;
}

// ── Default constants (overridable via site profile) ────────────────────────

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const DEFAULT_MAX_RETRIES = 2;

/** Minimum response body size — anything smaller is likely a WAF challenge page */
const DEFAULT_MIN_REAL_PAGE_BYTES = 2_000;

/** Patterns that indicate a WAF/bot-protection page rather than real content */
const DEFAULT_WAF_PATTERNS = [
  'cf-browser-verification',
  'Just a moment...',
  'challenge-platform',
  '_cf_chl',
  'Attention Required',
  '_Incapsula_Resource',
  'Incapsula incident',
  'sucuri.net',
  'Access Denied - Sucuri',
  'Checking your browser',
  'Verifying you are human',
];

// ── Main entry point ────────────────────────────────────────────────────────

export async function verifyProduct(params: {
  url: string;
  domain: string;
  hasWaf?: boolean;
}): Promise<VerifyProductResult> {
  const { url, domain, hasWaf } = params;
  const startTime = Date.now();

  // Look up site profile for per-site overrides
  const profile = _getSiteCacheEntry(domain)?.siteProfile;
  const FETCH_TIMEOUT_MS = profile?.httpTimeout ?? profile?.timeout ?? DEFAULT_FETCH_TIMEOUT_MS;
  const RETRY_DELAY_MS = profile?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const MAX_RETRIES = profile?.maxHttpRetries ?? DEFAULT_MAX_RETRIES;
  const MIN_REAL_PAGE_BYTES = profile?.wafConfig?.minPageBytes ?? DEFAULT_MIN_REAL_PAGE_BYTES;
  const WAF_PATTERNS: string[] = profile?.wafConfig?.challengePatterns ?? DEFAULT_WAF_PATTERNS;

  try {
    const playwrightTimeout = profile?.playwrightTimeout ?? profile?.timeout ?? 30_000;
    const { html, statusCode, responseTimeMs, resolvedUrl } = await fetchProductPage(url, domain, !!hasWaf, {
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
      retryDelayMs: RETRY_DELAY_MS,
      maxRetries: MAX_RETRIES,
      minRealPageBytes: MIN_REAL_PAGE_BYTES,
      wafPatterns: WAF_PATTERNS,
      playwrightTimeout,
    });

    // HTTP-level deletion signals
    if (statusCode === 404 || statusCode === 410) {
      return { status: 'deleted', responseTimeMs, statusCode };
    }

    // Redirect-to-homepage deletion signal (Shopify 302 → home zombie).
    // When a delisted product is removed, Shopify (and some other platforms)
    // respond 302 → `/` and the fetcher follows it transparently — the caller
    // gets 200 OK with the storefront homepage HTML, which `analyzeProductPage`
    // would happily parse as the product (extracting the site title as the
    // product name). Detect this by comparing the original product URL's path
    // to the resolved URL's path: if the resolver landed on `/` (or the bare
    // origin), the original URL was a delisted product. Must run BEFORE
    // analyzeProductPage so we don't pollute the result with homepage data.
    if (resolvedUrl) {
      try {
        const reqUrl = new URL(url);
        const finalUrl = new URL(resolvedUrl);
        // Only treat as deleted when the redirect crosses paths AND the original
        // URL had a non-root path (i.e. it was a product page, not a homepage
        // probe that legitimately stayed at `/`).
        // Shopify delisted-product redirects target several non-product paths:
        // `/` (homepage), `/cart`, `/account/login`, `/collections/all`. Each
        // of these returns HTTP 200 with non-product HTML that analyzeProductPage
        // would happily parse as the product. Extended 2026-06-01 (Fix 1 R2 rework
        // per Concern 4 — `/cart` and `/account/login` MED severity).
        const finalPath = finalUrl.pathname || '/';
        const DELETION_REDIRECT_PATHS = new Set(['/', '', '/cart', '/account/login', '/collections/all']);
        const finalIsDeletionTarget = DELETION_REDIRECT_PATHS.has(finalPath);
        const reqWasProduct = reqUrl.pathname !== '/' && reqUrl.pathname !== '';
        const reqWasDifferentPath = reqUrl.pathname !== finalPath;
        const sameOrigin = finalUrl.origin === reqUrl.origin;
        if (finalIsDeletionTarget && reqWasProduct && reqWasDifferentPath && sameOrigin) {
          return { status: 'deleted', responseTimeMs, statusCode };
        }
      } catch {
        // Malformed URL — fall through to normal page analysis
      }
    }

    const $ = cheerio.load(html);
    const result = analyzeProductPage($, html, url, domain);
    result.responseTimeMs = responseTimeMs;
    result.statusCode = statusCode;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      responseTimeMs: Date.now() - startTime,
      errorMessage: message,
    };
  }
}

// ── Fetch logic with fallback ───────────────────────────────────────────────

interface FetchedPage {
  html: string;
  statusCode: number;
  responseTimeMs: number;
  /**
   * Final URL after server-side redirects (axios manual hops, native fetch
   * redirect:'follow', or Playwright JS navigation). Used to detect "302 →
   * storefront homepage" zombies — e.g. delisted Shopify products that
   * silently redirect to `/` and would otherwise be parsed as the homepage
   * and incorrectly kept active.
   */
  resolvedUrl?: string;
}

/** Per-call fetch configuration derived from site profile */
interface FetchConfig {
  fetchTimeoutMs: number;
  retryDelayMs: number;
  maxRetries: number;
  minRealPageBytes: number;
  wafPatterns: string[];
  playwrightTimeout?: number;
}

async function fetchProductPage(
  url: string,
  domain: string,
  hasWaf: boolean,
  cfg: FetchConfig,
): Promise<FetchedPage> {
  // WAF sites go straight to Playwright — no point wasting a plain HTTP attempt
  if (hasWaf) {
    return fetchViaPlaywright(url, cfg);
  }

  // Try plain HTTP first
  for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
    try {
      const { fetchPageWithMeta } = await import('./scraper/http-client');
      const result = await fetchPageWithMeta(url, undefined, { difficultyRating: 0 });

      // Transient Cloudflare errors — retry
      if ([520, 502, 503].includes(result.statusCode)) {
        if (attempt < cfg.maxRetries) {
          await delay(cfg.retryDelayMs);
          continue;
        }
        // Last attempt still transient — fall back to Playwright
        console.warn(`[ProductVerifier] ${url}: transient ${result.statusCode} after ${attempt} attempts, trying Playwright`);
        return fetchViaPlaywright(url, cfg);
      }

      // 404/410 can be returned immediately — no WAF concern
      if (result.statusCode === 404 || result.statusCode === 410) {
        return {
          html: result.html,
          statusCode: result.statusCode,
          responseTimeMs: result.responseTimeMs,
          resolvedUrl: result.resolvedUrl,
        };
      }

      // Check if we got a real page or a WAF challenge
      if (isBlockedResponse(result.html, cfg)) {
        console.warn(`[ProductVerifier] ${url}: blocked response detected (${result.html.length}b), falling back to Playwright`);
        return fetchViaPlaywright(url, cfg);
      }

      return {
        html: result.html,
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
        resolvedUrl: result.resolvedUrl,
      };
    } catch (err) {
      if (attempt < cfg.maxRetries) {
        await delay(cfg.retryDelayMs);
        continue;
      }
      // All HTTP attempts failed — try Playwright as last resort
      console.warn(`[ProductVerifier] ${url}: HTTP failed after ${attempt} attempts, trying Playwright`);
      return fetchViaPlaywright(url, cfg);
    }
  }

  // TypeScript needs this — unreachable in practice
  throw new Error(`[ProductVerifier] fetchProductPage exhausted all paths for ${url}`);
}

async function fetchViaPlaywright(url: string, cfg: FetchConfig): Promise<FetchedPage> {
  const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
  const pwTimeout = cfg.playwrightTimeout ?? 30_000;
  const result = await fetchWithPlaywright(url, { timeout: pwTimeout });

  // Playwright doesn't give us a status code directly — infer from content
  const statusCode = result.html.length < 500 ? 404 : 200;
  return {
    html: result.html,
    statusCode,
    responseTimeMs: result.responseTimeMs,
    resolvedUrl: result.resolvedUrl,
  };
}

function isBlockedResponse(html: string, cfg: FetchConfig): boolean {
  if (html.length < cfg.minRealPageBytes) return true;
  const lower = html.toLowerCase();
  return cfg.wafPatterns.some(pattern => lower.includes(pattern.toLowerCase()));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Page analysis ───────────────────────────────────────────────────────────

function analyzeProductPage(
  $: cheerio.CheerioAPI,
  html: string,
  baseUrl: string,
  domain?: string,
): VerifyProductResult {
  // 1. Soft-404 detection (page returns 200 but content says "not found").
  // Scan BOTH <h1> and <title>, but SPLIT patterns by safety profile:
  //   h1OnlyPatterns  — bare substrings ("not found", "404"…) that legitimately
  //                     appear in many UI titles (search-results pages, etc.).
  //                     Safe only against the deletion banner <h1>, not <title>.
  //   h1OrTitlePatterns — specific soft-404 UX prose tightly bound to deletion
  //                       pages ("has been deleted", "ad not found"). Safe in
  //                       either <h1> or <title>. Catches the Townpost variant
  //                       where the title carries the signal: <title>Ad Not
  //                       Found · TownPost</title> + <h1>This ad has been
  //                       deleted...</h1>.
  // Body-regex (below) stays strictly on the original `removed` verb to avoid
  // false-positiving on legitimate product descriptions that say "this product
  // was sold exclusively..." or similar historical prose.
  const h1Text = $('h1').first().text().toLowerCase();
  const titleText = $('title').first().text().toLowerCase();

  // 1a. Per-site deletion markers (Gap 4) — checked FIRST, before global
  // patterns. Captured by backend/scripts/_detect-deletion-markers-2026-05-30.js
  // via live-vs-invalid URL diff. Patterns are pre-lowercased at capture time
  // so plain .includes() works. Falls through to global patterns if absent or
  // if none of this site's markers match.
  const perSiteMarkers = domain ? _getSiteCacheEntry(domain)?.siteProfile?.deletionMarkers : undefined;
  if (perSiteMarkers && typeof perSiteMarkers === 'object') {
    const h1Patterns: string[] = Array.isArray(perSiteMarkers.h1Patterns) ? perSiteMarkers.h1Patterns : [];
    const titlePatterns: string[] = Array.isArray(perSiteMarkers.titlePatterns) ? perSiteMarkers.titlePatterns : [];
    const bodyPatterns: string[] = Array.isArray(perSiteMarkers.bodyPatterns) ? perSiteMarkers.bodyPatterns : [];
    if (h1Patterns.length > 0 && h1Patterns.some(p => p && h1Text.includes(p))) {
      return { status: 'deleted', responseTimeMs: 0 };
    }
    if (titlePatterns.length > 0 && titlePatterns.some(p => p && titleText.includes(p))) {
      return { status: 'deleted', responseTimeMs: 0 };
    }
    if (bodyPatterns.length > 0) {
      const psBody = $('body').text().substring(0, 3000).toLowerCase();
      for (const src of bodyPatterns) {
        if (!src) continue;
        try {
          if (new RegExp(src, 'i').test(psBody)) {
            return { status: 'deleted', responseTimeMs: 0 };
          }
        } catch { /* malformed regex source — skip silently */ }
      }
    }
  }

  const h1OnlyPatterns = [
    'not found', 'page introuvable', '404',
    'no longer available', 'has been removed',
    'does not exist', 'page not found',
  ];
  const h1OrTitlePatterns = [
    'has been deleted',                 // Townpost soft-404 h1 prefix
    'ad not found',                     // Townpost soft-404 title
  ];
  if (h1OnlyPatterns.some(p => h1Text.includes(p)) ||
      h1OrTitlePatterns.some(p => h1Text.includes(p) || titleText.includes(p))) {
    return { status: 'deleted', responseTimeMs: 0 };
  }

  // Also check broader page text for removal notices. Kept narrow to avoid
  // false positives on descriptions that mention "this product was sold..."
  // in historical/narrative prose. Townpost's deletion signal is already
  // caught by the h1OrTitlePatterns above ("has been deleted" / "ad not found").
  const bodyText = $('body').text().substring(0, 3000).toLowerCase();
  if (/the page you requested does not exist/i.test(bodyText) ||
      /this (page|product|listing) (has been|was) removed/i.test(bodyText)) {
    return { status: 'deleted', responseTimeMs: 0 };
  }

  // 2. Sold detection
  if (isSold($, html, domain)) {
    const data = extractProductData($, html, baseUrl);
    return {
      status: 'sold',
      stockStatus: 'out_of_stock',
      responseTimeMs: 0,
      ...data,
    };
  }

  // 3. Wanted detection (classifieds: title ends with wanted/wtb/wtt/iso)
  const title = extractTitle($, html);
  if (title) {
    const titleLower = title.toLowerCase().trim();
    const entry = domain ? _getSiteCacheEntry(domain) : undefined;
    const wantedPattern = entry?.siteProfile?.classifiedRules?.wantedDetection;
    const wantedRegex = buildWantedRegex(wantedPattern);
    if (wantedRegex.test(titleLower)) {
      const data = extractProductData($, html, baseUrl);
      return {
        status: 'wanted',
        responseTimeMs: 0,
        ...data,
        title: data.title || title,
      };
    }
  }

  // 4. Alive — extract full product data
  const data = extractProductData($, html, baseUrl);
  const stockStatus = detectStockStatus($, html);

  return {
    status: 'alive',
    stockStatus,
    responseTimeMs: 0,
    ...data,
  };
}

// ── Wanted detection ────────────────────────────────────────────────────────

/**
 * Build the regex used to detect "wanted/WTB/WTT/ISO" classifieds titles.
 *
 * Historical bug: `new RegExp(arrayOfPatterns, 'i')` silently coerced the
 * array via Array.prototype.toString() (comma-joined) — so `['^wanted','wtb$']`
 * became `/^wanted,wtb$/i` which matches nothing real. We now join arrays with
 * `|` so each entry becomes a proper alternation.
 */
export function buildWantedRegex(pattern: string | string[] | undefined): RegExp {
  if (Array.isArray(pattern)) {
    if (pattern.length === 0) return /\b(wanted|wtb|wtt|iso)\s*$/i;
    return new RegExp(pattern.join('|'), 'i');
  }
  if (typeof pattern === 'string' && pattern.length > 0) {
    return new RegExp(pattern, 'i');
  }
  return /\b(wanted|wtb|wtt|iso)\s*$/i;
}

// ── Sold detection ──────────────────────────────────────────────────────────

/**
 * Match a `class="..."` attribute against a sold-class pattern.
 *
 * The historical regex `class="[^"]*\bsold\b[^"]*"` matched the word `sold`
 * anywhere in the class attribute — including alive listings on gunpost.ca
 * where the class is `field-sold No`. We now require the FULL pattern
 * (e.g. `field-sold Yes`) as a contiguous token sequence inside the class
 * attribute, bounded by whitespace or the attribute delimiters, so
 * `field-sold No` no longer matches `field-sold Yes`.
 */
export function matchesSoldClassPattern(html: string, classPattern: string): boolean {
  // Escape regex meta-chars; allow flexible internal whitespace.
  const escaped = classPattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  // Pattern must be bounded by a class-list separator on both sides:
  // attribute-opening-quote or whitespace on the left, whitespace or
  // attribute-closing-quote on the right.
  const re = new RegExp(`class="(?:[^"]*\\s)?${escaped}(?:\\s[^"]*)?"`, 'i');
  return re.test(html);
}

function isSold($: cheerio.CheerioAPI, html: string, domain?: string): boolean {
  // Check site profile for custom sold detection patterns
  if (domain) {
    const entry = _getSiteCacheEntry(domain);
    const patterns: string[] | undefined = entry?.siteProfile?.classifiedRules?.soldDetection;
    if (patterns && patterns.length > 0) {
      for (const pattern of patterns) {
        if (pattern.startsWith('class=')) {
          const className = pattern.slice(6);
          if (matchesSoldClassPattern(html, className)) return true;
        } else {
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
          if (new RegExp(escaped, 'i').test(html)) return true;
        }
      }
      // Profile had patterns — don't fall through to generic class checks below,
      // but still check JSON-LD / schema.org / text-based detection
    }
  }

  // CSS class-based sold indicators (generic)
  if ($('.sold, .ad-sold, .field-sold').length > 0) return true;
  // Generic sold CSS classes
  if ($('.out-of-stock, .outofstock, .product-unavailable').length > 0) {
    // Only treat as "sold" if there's also explicit sold text — out-of-stock
    // alone doesn't mean sold (could be temporarily unavailable)
    const text = $('body').text().toLowerCase();
    if (/\bsold\s*out\b/.test(text) || /\bsold\b/.test($('.out-of-stock, .outofstock').text().toLowerCase())) {
      return true;
    }
  }

  // JSON-LD availability
  const jsonLdAvailability = extractJsonLdAvailability($);
  if (jsonLdAvailability) {
    const lower = jsonLdAvailability.toLowerCase();
    if (lower.includes('soldout') || lower.includes('discontinued')) return true;
  }

  // Explicit "SOLD OUT" or "SOLD" text in price/status areas
  const statusAreas = $('.price, .product-price, .product-status, .stock, .availability, [class*="price"], [class*="stock"]');
  const statusText = statusAreas.text().toLowerCase();
  if (/\bsold\s*out\b/.test(statusText) || /\bsold\b/.test(statusText)) return true;

  // Schema.org microdata availability
  const availabilityMeta = $('[itemprop="availability"]');
  if (availabilityMeta.length) {
    const content = (availabilityMeta.attr('content') || availabilityMeta.attr('href') || '').toLowerCase();
    if (content.includes('soldout') || content.includes('discontinued')) return true;
  }

  return false;
}

// ── Stock status detection ──────────────────────────────────────────────────

function detectStockStatus($: cheerio.CheerioAPI, html: string): 'in_stock' | 'out_of_stock' | undefined {
  // JSON-LD availability
  const jsonLdAvailability = extractJsonLdAvailability($);
  if (jsonLdAvailability) {
    const lower = jsonLdAvailability.toLowerCase();
    if (lower.includes('instock')) return 'in_stock';
    if (lower.includes('outofstock') || lower.includes('soldout') || lower.includes('discontinued')) return 'out_of_stock';
  }

  // Schema.org microdata
  const availabilityMeta = $('[itemprop="availability"]');
  if (availabilityMeta.length) {
    const content = (availabilityMeta.attr('content') || availabilityMeta.attr('href') || '').toLowerCase();
    if (content.includes('instock')) return 'in_stock';
    if (content.includes('outofstock') || content.includes('soldout')) return 'out_of_stock';
  }

  // CSS class signals
  if ($('.in-stock, .instock').length > 0) return 'in_stock';
  if ($('.out-of-stock, .outofstock').length > 0) return 'out_of_stock';

  // Text signals in stock/availability areas
  const stockText = $('.stock, .availability, [class*="stock"]').text().toLowerCase();
  if (/\bin\s*stock\b/.test(stockText)) return 'in_stock';
  if (/\bout\s*of\s*stock\b/.test(stockText) || /\bsold\s*out\b/.test(stockText)) return 'out_of_stock';

  // "Availability:" label scan (OpenCart / osCommerce / Zen Cart family).
  // These carts render stock in a bare <li>/<span> with no .stock class, e.g.
  // `<li>Availability: In Stock</li>` or `<li>Availability: Out Of Stock</li>`,
  // so the class-scoped check above misses it. Match only text anchored on the
  // explicit "availability:" label to avoid catching narrative prose, then read
  // the verdict from the value that follows the label. The label requirement
  // keeps this from firing on descriptions that merely contain "in stock".
  let availFromLabel: 'in_stock' | 'out_of_stock' | undefined;
  $('li, span, div, p, td').each((_, el) => {
    if (availFromLabel) return false; // break .each
    const t = $(el).text().trim().replace(/\s+/g, ' ');
    const m = /^availability\s*:?\s*(.+)$/i.exec(t);
    if (!m) return;
    const val = m[1].toLowerCase();
    if (/\bout\s*of\s*stock\b|\bsold\s*out\b|\bunavailable\b|\bbackorder/.test(val)) {
      availFromLabel = 'out_of_stock';
      return false;
    }
    if (/\bin\s*stock\b|\bavailable\b/.test(val)) {
      availFromLabel = 'in_stock';
      return false;
    }
  });
  if (availFromLabel) return availFromLabel;

  // Open Graph / product availability meta (generic; fills the gap when JSON-LD/
  // microdata are absent or use obfuscated markup, e.g. Wix). Placed AFTER explicit
  // on-page OOS evidence (CSS/text) because og:availability is a social-share hint
  // that can be served stale from SSR cache; current on-page signals must win to
  // avoid false restock alerts. Ambiguous enum values (preorder/backorder/presale/
  // limitedAvailability/onlineOnly) intentionally fall through to no-verdict.
  const ogAvailEl = $('meta[property="og:availability"], meta[name="og:availability"], meta[property="product:availability"], meta[name="product:availability"]').first();
  if (ogAvailEl.length) {
    const ogVal = (ogAvailEl.attr('content') || '').toLowerCase().trim();
    if (ogVal) {
      const compact = ogVal.replace(/[\s_-]+/g, '');
      if (compact.includes('instock')) return 'in_stock';
      if (
        compact.includes('outofstock') ||
        compact.includes('soldout') ||
        compact.includes('discontinued') ||
        compact.includes('oos')
      ) return 'out_of_stock';
    }
  }

  // Add-to-cart button present and enabled = likely in stock
  const cartBtn = $('button[class*="cart"], [id*="add-to-cart"], input[value*="Add to Cart" i], .add-to-cart');
  if (cartBtn.length && cartBtn.attr('disabled') === undefined && !cartBtn.hasClass('disabled')) {
    return 'in_stock';
  }

  return undefined;
}

// ── Data extraction (layered) ───────────────────────────────────────────────

export interface ExtractedData {
  title?: string;
  price?: number;
  regularPrice?: number;
  thumbnail?: string;
}

export function extractProductData(
  $: cheerio.CheerioAPI,
  html: string,
  baseUrl: string,
): ExtractedData {
  // Layer 1: JSON-LD (most reliable)
  const jsonLd = extractFromJsonLd($);

  // Layer 2: Open Graph meta tags
  const og = extractFromOpenGraph($);

  // Layer 3: HTML selectors
  const htmlData = extractFromHtml($, baseUrl);

  // Merge layers: JSON-LD > OG > HTML, per field
  const title = decodeEntities(jsonLd.title || og.title || htmlData.title);
  const price = jsonLd.price ?? og.price ?? htmlData.price;
  const regularPrice = jsonLd.regularPrice ?? htmlData.regularPrice;
  const thumbnail = resolveThumbUrl(jsonLd.thumbnail || og.thumbnail || htmlData.thumbnail, baseUrl);

  const result: ExtractedData = {};
  if (title) result.title = title;
  if (price) result.price = price;
  if (regularPrice && regularPrice > (price ?? 0)) result.regularPrice = regularPrice;
  if (thumbnail) result.thumbnail = thumbnail;

  return result;
}

// ── Layer 1: JSON-LD extraction ─────────────────────────────────────────────

interface JsonLdData {
  title?: string;
  price?: number;
  regularPrice?: number;
  thumbnail?: string;
}

function extractFromJsonLd($: cheerio.CheerioAPI): JsonLdData {
  const result: JsonLdData = {};

  $('script[type="application/ld+json"]').each((_, el) => {
    // Stop if we already found a product
    if (result.title) return;

    try {
      const raw = $(el).html();
      if (!raw) return;
      const data = JSON.parse(raw);

      // JSON-LD can be a single object or an array
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        const product = findProductInJsonLd(item);
        if (!product) continue;

        result.title = product.name || undefined;
        result.thumbnail = extractJsonLdImage(product);

        // Extract price from offers
        const offers = product.offers;
        if (offers) {
          const offerList = Array.isArray(offers) ? offers : [offers];
          for (const offer of offerList) {
            if (offer.price !== undefined) {
              const p = typeof offer.price === 'number'
                ? offer.price
                : parseFloat(String(offer.price).replace(/,/g, ''));
              if (!isNaN(p) && p > 0) {
                result.price = p;
              }
            }
            // Check priceSpecification (WooCommerce Yoast uses this instead of direct price)
            if (!result.price && offer.priceSpecification) {
              const specs = Array.isArray(offer.priceSpecification) ? offer.priceSpecification : [offer.priceSpecification];
              for (const spec of specs) {
                if (spec.price !== undefined) {
                  const p = typeof spec.price === 'number'
                    ? spec.price
                    : parseFloat(String(spec.price).replace(/,/g, ''));
                  if (!isNaN(p) && p > 0) {
                    result.price = p;
                    break;
                  }
                }
              }
            }
            // Check for highPrice/lowPrice (aggregate offers)
            if (!result.price && offer.lowPrice !== undefined) {
              const p = typeof offer.lowPrice === 'number'
                ? offer.lowPrice
                : parseFloat(String(offer.lowPrice).replace(/,/g, ''));
              if (!isNaN(p) && p > 0) result.price = p;
            }
            if (offer.highPrice !== undefined) {
              const rp = typeof offer.highPrice === 'number'
                ? offer.highPrice
                : parseFloat(String(offer.highPrice).replace(/,/g, ''));
              if (!isNaN(rp) && rp > 0 && rp > (result.price ?? 0)) {
                result.regularPrice = rp;
              }
            }
          }
        }

        if (result.title) break;
      }
    } catch {
      // Malformed JSON-LD — skip silently
    }
  });

  return result;
}

/** Recursively find a Product node in JSON-LD (may be nested under @graph) */
function findProductInJsonLd(data: any): any | null {
  if (!data || typeof data !== 'object') return null;

  if (data['@type'] === 'Product' || data['@type'] === 'IndividualProduct') {
    return data;
  }

  // Check @graph array (common in Yoast SEO, WooCommerce)
  if (Array.isArray(data['@graph'])) {
    for (const node of data['@graph']) {
      const found = findProductInJsonLd(node);
      if (found) return found;
    }
  }

  return null;
}

function extractJsonLdImage(product: any): string | undefined {
  if (!product.image) return undefined;
  if (typeof product.image === 'string') return product.image;
  if (Array.isArray(product.image)) {
    const first = product.image[0];
    return typeof first === 'string' ? first : first?.url;
  }
  if (typeof product.image === 'object' && product.image.url) {
    return product.image.url;
  }
  return undefined;
}

function extractJsonLdAvailability($: cheerio.CheerioAPI): string | null {
  let availability: string | null = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (availability) return;
    try {
      const raw = $(el).html();
      if (!raw) return;
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        const product = findProductInJsonLd(item);
        if (!product?.offers) continue;

        const offerList = Array.isArray(product.offers) ? product.offers : [product.offers];
        for (const offer of offerList) {
          // Case-insensitive availability key (Wix emits "Availability" with a capital A).
          const availKey = offer && typeof offer === 'object'
            ? Object.keys(offer).find(k => k.toLowerCase() === 'availability')
            : undefined;
          if (availKey && offer[availKey]) {
            availability = String(offer[availKey]);
            return;
          }
        }
      }
    } catch {
      // skip
    }
  });

  return availability;
}

// ── Layer 2: Open Graph extraction ──────────────────────────────────────────

interface OgData {
  title?: string;
  price?: number;
  thumbnail?: string;
}

function extractFromOpenGraph($: cheerio.CheerioAPI): OgData {
  const result: OgData = {};

  const ogTitle = $('meta[property="og:title"]').attr('content');
  if (ogTitle) result.title = ogTitle;

  const ogImage = $('meta[property="og:image"]').attr('content');
  // Reject generic "OG card generator" URLs. Some sites (e.g. TownPost's
  // `/api/og?title=...`) set og:image to a server-rendered TEXT card, not the
  // listing photo. Storing it overwrites the real CDN thumbnail the listing
  // extractor already captured with an unhelpful text image. The real photo is
  // URL-encoded inside the card URL's `fallbackUrl=` param — recover it when
  // present; otherwise drop the og:image so the existing thumbnail is kept.
  if (ogImage && /\/api\/og\b/i.test(ogImage)) {
    const fb = ogImage.match(/[?&]fallbackUrl=([^&]+)/i);
    const recovered = fb ? decodeURIComponent(fb[1]) : '';
    if (recovered && /^https?:\/\//i.test(recovered) && !/\/api\/og\b/i.test(recovered)) {
      result.thumbnail = recovered;
    } else {
      // No fallbackUrl to recover from. We drop the og card and rely on the
      // listing/HTML thumbnail. Log it so a future format change (card URL without
      // fallbackUrl AND no HTML thumbnail → silent thumbnail loss) is observable.
      console.debug(`[product-verifier] dropped /api/og og:image with no recoverable fallbackUrl: ${ogImage}`);
    }
    // leave result.thumbnail unset → caller keeps the listing/HTML thumbnail
  } else if (ogImage) {
    result.thumbnail = ogImage;
  }

  // product:price:amount is standard for e-commerce OG tags
  const ogPrice = $('meta[property="product:price:amount"]').attr('content');
  if (ogPrice) {
    const p = parseFloat(ogPrice.replace(/,/g, ''));
    if (!isNaN(p) && p > 0) result.price = p;
  }

  return result;
}

// ── Layer 3: HTML selector extraction ───────────────────────────────────────

interface HtmlData {
  title?: string;
  price?: number;
  regularPrice?: number;
  thumbnail?: string;
}

function extractFromHtml($: cheerio.CheerioAPI, baseUrl: string): HtmlData {
  const result: HtmlData = {};

  // Title: try specific selectors first, then generic h1
  const titleSelectors = [
    '[itemprop="name"]',
    '.product-title', '.product_title', '.product-name', '.product_name',
    'h1.entry-title', 'h1.page-title',
    'h1',
  ];
  for (const sel of titleSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const text = el.text().trim().replace(/\s+/g, ' ');
      if (text.length > 3 && text.length < 300) {
        result.title = text;
        break;
      }
    }
  }

  // Price: sale/current price
  // Scope to product summary area first to avoid picking up related/upsell product prices.
  // WooCommerce product pages have a .summary section for the main product, with
  // related products in section.related or .upsells further down the page.
  const PRODUCT_SCOPES = [
    '.summary',                          // WooCommerce
    '.product-single', '.product-info',  // Shopify / generic
    '.productView',                      // BigCommerce
    '#product-detail', '.product-detail',// Generic
  ];
  const EXCLUDE_SCOPES = '.related, .upsells, .cross-sells, [class*="related-product"], [class*="recently-viewed"]';

  const priceSelectors = [
    'ins .woocommerce-Price-amount',           // WooCommerce sale price
    '.special-price .price',                    // Magento sale
    '.sale-price', '.salePrice',               // Generic
    '[itemprop="price"]',                       // Schema.org
    '.price .amount', '.price-current',
    '.product-price', '.productView-price',
    '.price--withoutTax',                       // BigCommerce
    '.woocommerce-Price-amount',                // WooCommerce (non-sale)
  ];

  // Helper to extract price from a matched element
  const tryExtractPriceFromEl = (el: cheerio.Cheerio<any>): number | undefined => {
    if (!el.length) return undefined;
    // Skip elements inside related/upsell sections
    if (el.closest(EXCLUDE_SCOPES).length > 0) return undefined;
    // Skip cart totals ($0.00 in header)
    if (el.closest('.cart-contents, .mini-cart, .cart-sidebar, [class*="cart"]').length > 0) return undefined;
    const content = el.attr('content');
    if (content) {
      const p = parseFloat(content.replace(/,/g, ''));
      // `content` attr is a declared price value (microdata/[itemprop=price]), not display
      // text — accept any positive value. Cart/related/upsell are already excluded above.
      if (!isNaN(p) && p > 0) return p;
    }
    const p = extractPrice(el.text());
    return p || undefined;
  };

  // Pass 1: Try scoped selectors (product summary area only)
  for (const scope of PRODUCT_SCOPES) {
    if (!$(scope).length) continue;
    for (const sel of priceSelectors) {
      const el = $(`${scope} ${sel}`).first();
      const p = tryExtractPriceFromEl(el);
      if (p) { result.price = p; break; }
    }
    if (result.price) break;
  }

  // Pass 2: Unscoped but exclude related/upsell/cart areas
  if (!result.price) {
    for (const sel of priceSelectors) {
      // Find first matching element that isn't in an excluded section
      $(sel).each((_, rawEl) => {
        if (result.price) return false; // break .each
        const el = $(rawEl);
        const p = tryExtractPriceFromEl(el);
        if (p) { result.price = p; return false; }
      });
      if (result.price) break;
    }
  }

  // Regular price (struck-through or marked as original)
  // Same scoping logic: product summary first, then unscoped with exclusions
  const regularSelectors = [
    'del .woocommerce-Price-amount',            // WooCommerce original
    '.regular-price .price', '.was-price',
    '.old-price', '.original-price', '.listPrice',
    'del .amount', 's .amount',
  ];
  for (const scope of PRODUCT_SCOPES) {
    if (!$(scope).length) continue;
    for (const sel of regularSelectors) {
      const el = $(`${scope} ${sel}`).first();
      const p = tryExtractPriceFromEl(el);
      if (p) { result.regularPrice = p; break; }
    }
    if (result.regularPrice) break;
  }
  if (!result.regularPrice) {
    for (const sel of regularSelectors) {
      $(sel).each((_, rawEl) => {
        if (result.regularPrice) return false;
        const el = $(rawEl);
        const p = tryExtractPriceFromEl(el);
        if (p) { result.regularPrice = p; return false; }
      });
      if (result.regularPrice) break;
    }
  }

  // Thumbnail
  const imgSelectors = [
    '[itemprop="image"]',
    '.product-image img', '.product-featured-image img',
    '.woocommerce-product-gallery img',
    '.productView-image img',
    '.product-main-image img',
    '.product-photo img',
  ];
  for (const sel of imgSelectors) {
    const el = $(sel).first();
    if (el.length) {
      // For meta/link tags with content/href
      const metaUrl = el.attr('content') || el.attr('href');
      if (metaUrl) {
        result.thumbnail = metaUrl;
        break;
      }
      // For img tags — prefer data-src (lazy-loaded real image)
      const src = el.attr('data-src') || el.attr('data-lazy-src') || el.attr('src');
      if (src && !/placeholder|loading|blank\.(gif|png)/i.test(src)) {
        result.thumbnail = src;
        break;
      }
    }
  }

  return result;
}

// ── Title extraction (for wanted detection before full extraction) ───────────

function extractTitle($: cheerio.CheerioAPI, html: string): string | null {
  // JSON-LD first
  let title: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (title) return;
    try {
      const raw = $(el).html();
      if (!raw) return;
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const product = findProductInJsonLd(item);
        if (product?.name) {
          title = product.name;
          return;
        }
      }
    } catch { /* skip */ }
  });
  if (title) return title;

  // OG title
  const ogTitle = $('meta[property="og:title"]').attr('content');
  if (ogTitle) return ogTitle;

  // h1
  const h1 = $('h1').first().text().trim();
  if (h1.length > 3) return h1;

  return null;
}

// ── Utility helpers ─────────────────────────────────────────────────────────

/** Decode common HTML entities that appear in product titles */
function decodeEntities(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim();
}

/** Resolve a thumbnail URL to absolute, handling relative and protocol-relative URLs */
function resolveThumbUrl(url: string | undefined, baseUrl: string): string | undefined {
  if (!url) return undefined;
  try {
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    return new URL(url, baseUrl).toString();
  } catch {
    return undefined;
  }
}
