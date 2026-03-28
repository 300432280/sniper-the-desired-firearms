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

// ── Constants ───────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const MAX_RETRIES = 2;

/** Minimum response body size — anything smaller is likely a WAF challenge page */
const MIN_REAL_PAGE_BYTES = 2_000;

/** Patterns that indicate a WAF/bot-protection page rather than real content */
const WAF_PATTERNS = [
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

  try {
    const { html, statusCode, responseTimeMs } = await fetchProductPage(url, domain, !!hasWaf);

    // HTTP-level deletion signals
    if (statusCode === 404 || statusCode === 410) {
      return { status: 'deleted', responseTimeMs, statusCode };
    }

    const $ = cheerio.load(html);
    const result = analyzeProductPage($, html, url);
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
}

async function fetchProductPage(
  url: string,
  domain: string,
  hasWaf: boolean,
): Promise<FetchedPage> {
  // WAF sites go straight to Playwright — no point wasting a plain HTTP attempt
  if (hasWaf) {
    return fetchViaPlaywright(url);
  }

  // Try plain HTTP first
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { fetchPageWithMeta } = await import('./scraper/http-client');
      const result = await fetchPageWithMeta(url, undefined, { difficultyRating: 0 });

      // Transient Cloudflare errors — retry
      if ([520, 502, 503].includes(result.statusCode)) {
        if (attempt < MAX_RETRIES) {
          await delay(RETRY_DELAY_MS);
          continue;
        }
        // Last attempt still transient — fall back to Playwright
        console.warn(`[ProductVerifier] ${url}: transient ${result.statusCode} after ${attempt} attempts, trying Playwright`);
        return fetchViaPlaywright(url);
      }

      // 404/410 can be returned immediately — no WAF concern
      if (result.statusCode === 404 || result.statusCode === 410) {
        return {
          html: result.html,
          statusCode: result.statusCode,
          responseTimeMs: result.responseTimeMs,
        };
      }

      // Check if we got a real page or a WAF challenge
      if (isBlockedResponse(result.html)) {
        console.warn(`[ProductVerifier] ${url}: blocked response detected (${result.html.length}b), falling back to Playwright`);
        return fetchViaPlaywright(url);
      }

      return {
        html: result.html,
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
      };
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
        continue;
      }
      // All HTTP attempts failed — try Playwright as last resort
      console.warn(`[ProductVerifier] ${url}: HTTP failed after ${attempt} attempts, trying Playwright`);
      return fetchViaPlaywright(url);
    }
  }

  // TypeScript needs this — unreachable in practice
  throw new Error(`[ProductVerifier] fetchProductPage exhausted all paths for ${url}`);
}

async function fetchViaPlaywright(url: string): Promise<FetchedPage> {
  const { fetchWithPlaywright } = await import('./scraper/playwright-fetcher');
  const result = await fetchWithPlaywright(url, { timeout: 30_000 });

  // Playwright doesn't give us a status code directly — infer from content
  const statusCode = result.html.length < 500 ? 404 : 200;
  return {
    html: result.html,
    statusCode,
    responseTimeMs: result.responseTimeMs,
  };
}

function isBlockedResponse(html: string): boolean {
  if (html.length < MIN_REAL_PAGE_BYTES) return true;
  const lower = html.toLowerCase();
  return WAF_PATTERNS.some(pattern => lower.includes(pattern.toLowerCase()));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Page analysis ───────────────────────────────────────────────────────────

function analyzeProductPage(
  $: cheerio.CheerioAPI,
  html: string,
  baseUrl: string,
): VerifyProductResult {
  // 1. Soft-404 detection (page returns 200 but content says "not found")
  const h1Text = $('h1').first().text().toLowerCase();
  const softDeletePatterns = [
    'not found', 'page introuvable', '404',
    'no longer available', 'has been removed',
    'does not exist', 'page not found',
  ];
  if (softDeletePatterns.some(p => h1Text.includes(p))) {
    return { status: 'deleted', responseTimeMs: 0 };
  }

  // Also check broader page text for removal notices
  const bodyText = $('body').text().substring(0, 3000).toLowerCase();
  if (/the page you requested does not exist/i.test(bodyText) ||
      /this (page|product|listing) (has been|was) removed/i.test(bodyText)) {
    return { status: 'deleted', responseTimeMs: 0 };
  }

  // 2. Sold detection
  if (isSold($, html)) {
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
    if (/\b(wanted|wtb|wtt|iso)\s*$/.test(titleLower)) {
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

// ── Sold detection ──────────────────────────────────────────────────────────

function isSold($: cheerio.CheerioAPI, html: string): boolean {
  // CSS class-based sold indicators
  if ($('.sold, .ad-sold, .field-sold').length > 0) return true;
  // Gunpost-specific: class="field-sold Yes"
  if (/class="field-sold\s+Yes"/i.test(html)) return true;
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

  // Add-to-cart button present and enabled = likely in stock
  const cartBtn = $('button[class*="cart"], [id*="add-to-cart"], input[value*="Add to Cart" i], .add-to-cart');
  if (cartBtn.length && cartBtn.attr('disabled') === undefined && !cartBtn.hasClass('disabled')) {
    return 'in_stock';
  }

  return undefined;
}

// ── Data extraction (layered) ───────────────────────────────────────────────

interface ExtractedData {
  title?: string;
  price?: number;
  regularPrice?: number;
  thumbnail?: string;
}

function extractProductData(
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
              if (!isNaN(p) && p >= 10) {
                result.price = p;
              }
            }
            // Check for highPrice/lowPrice (aggregate offers)
            if (!result.price && offer.lowPrice !== undefined) {
              const p = typeof offer.lowPrice === 'number'
                ? offer.lowPrice
                : parseFloat(String(offer.lowPrice).replace(/,/g, ''));
              if (!isNaN(p) && p >= 10) result.price = p;
            }
            if (offer.highPrice !== undefined) {
              const rp = typeof offer.highPrice === 'number'
                ? offer.highPrice
                : parseFloat(String(offer.highPrice).replace(/,/g, ''));
              if (!isNaN(rp) && rp >= 10 && rp > (result.price ?? 0)) {
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
          if (offer.availability) {
            availability = String(offer.availability);
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
  if (ogImage) result.thumbnail = ogImage;

  // product:price:amount is standard for e-commerce OG tags
  const ogPrice = $('meta[property="product:price:amount"]').attr('content');
  if (ogPrice) {
    const p = parseFloat(ogPrice.replace(/,/g, ''));
    if (!isNaN(p) && p >= 10) result.price = p;
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
  for (const sel of priceSelectors) {
    const el = $(sel).first();
    if (el.length) {
      // itemprop="price" may store the value in content attribute
      const content = el.attr('content');
      if (content) {
        const p = parseFloat(content.replace(/,/g, ''));
        if (!isNaN(p) && p >= 10) {
          result.price = p;
          break;
        }
      }
      const p = extractPrice(el.text());
      if (p) {
        result.price = p;
        break;
      }
    }
  }

  // Regular price (struck-through or marked as original)
  const regularSelectors = [
    'del .woocommerce-Price-amount',            // WooCommerce original
    '.regular-price .price', '.was-price',
    '.old-price', '.original-price', '.listPrice',
    'del .amount', 's .amount',
  ];
  for (const sel of regularSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const p = extractPrice(el.text());
      if (p) {
        result.regularPrice = p;
        break;
      }
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
