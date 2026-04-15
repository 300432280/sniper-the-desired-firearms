/**
 * pre-bootstrap-probe.ts — Mechanical 7-phase site probing script.
 *
 * Takes a URL, runs automated probes across 7 phases, outputs a structured
 * JSON report. No AI/judgment needed — pure automation, CI-runnable.
 *
 * Usage:
 *   cd backend && npx tsx scripts/pre-bootstrap-probe.ts https://example.com
 *
 * Output: JSON to stdout, progress to stderr.
 */

import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { execSync } from 'child_process';
import path from 'path';
import * as https from 'https';
import * as http from 'http';
import { Agent as UndiciAgent } from 'undici';

// Custom HTTP(S) agents with generous maxHeaderSize so sites like Drupal that
// emit enormous `x-drupal-cache-tags` (16KB+) headers don't trip Node's
// default 16KB parser limit. Without this, axios throws HPE_HEADER_OVERFLOW
// and the native-fetch fallback ALSO throws UND_ERR_HEADERS_OVERFLOW —
// producing false "site unreachable" signals in Phase 3.
const BIG_HEADER_HTTP_AGENT = new http.Agent({ keepAlive: true, maxHeaderSize: 131072 } as any);
const BIG_HEADER_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxHeaderSize: 131072 } as any);

// Undici dispatcher with raised header size for the native-fetch fallback.
const BIG_HEADER_UNDICI = new UndiciAgent({ maxResponseSize: -1, headersTimeout: 20000, bodyTimeout: 20000, connect: { timeout: 20000 }, maxHeaderSize: 131072 } as any);

// ── Types ──────────────────────────────────────────────────────────────────────

interface Confidence { value: string | number | boolean | null; confidence: 'high' | 'medium' | 'low' | 'none' }
interface ProbeError { phase: string; message: string; stack?: string }

interface AccessPhase {
  canonicalUrl: Confidence;
  hasWaf: Confidence;
  wafType: Confidence;
  wafProbeEvidence: Record<string, any>;
  userAgentResults: { ua: string; label: string; status: number | null; error?: string; method?: string }[];
  crawlDelay: Confidence;
  robotsDisallowed: string[];
  malformedHeaders: Confidence; // NEW — Celerant/ColdFusion HPE indicator
  serverHeader: Confidence;     // NEW — captured server header from real response
}

interface PlatformPhase {
  platform: Confidence;
  platformMarkers: string[];
  jsOverlay: Confidence;
  renderingMode: Confidence;
  availableApis: { name: string; accessible: boolean; productCount?: number; evidence?: string }[];
  needsPlaywright: Confidence;
  multilingual: Confidence;
  sitemapUrls: string[];
  sitemapProductCount: Confidence;
}

interface AdapterPhase {
  suggestedAdapter: Confidence;
  apiAccessible: Confidence;
  extractionTestResult: {
    url: string;
    productsFound: number;
    sampleTitles: string[];
  } | null;
}

interface CatalogPhase {
  categoryTree: { name: string; url: string; count?: number; parentId?: number }[];
  navLinks: string[];
  sitemapProductCount: Confidence;
  apiProductCount: Confidence;
}

interface SortOption { value: string; text: string; selectName: string; selectId: string }

interface SortPhase {
  sortOptions: SortOption[];
  sortScheme: Confidence;     // 'query' | 'path' | 'hash' | 'js-only' | null
  idJumpTest: {
    defaultFirstProduct: string | null;
    newestFirstProduct: string | null;
    counterControlFirstProduct: string | null;
    newestParam: string | null;
    counterControlParam: string | null;
    verdict: 'honored' | 'honored-default-is-newest' | 'noop' | 'not-tested' | 'no-sort-options';
  };
  // Disambiguation: when multiple options match the newest-style regex
  // (e.g. Celerant has both `new-arrivals` and `newest-rcvd`), run ID-jump
  // against EACH candidate and report which one produces the distinct newest slug.
  newestCandidates?: { value: string; text: string; firstProduct: string | null; score: number }[];
  openCartDateProbe?: { param: string; firstProduct: string | null; defaultFirstProduct: string | null; honored: boolean };
}

interface PaginationPhase {
  paginationPattern: Confidence;
  perPage: Confidence;
  page1Products: string[];
  page2Products: string[];
  zeroOverlap: Confidence;
  paginationLinks: string[];
  // Drupal Views and some custom paginators use 0-indexed page numbers —
  // `?page=0` = page 1, `?page=1` = page 2. Detected by scanning paginationLinks
  // for a `page=0` reference. This signal feeds into profile.paginationPattern.zeroIndexed.
  zeroIndexed: Confidence;
  // Some sites render the first page with NO pagination param at all
  // (`/catalog` is page 1, `/catalog?page=2` is page 2) while others
  // always include the param (`?page=1` is page 1). Detected by checking
  // whether the "current" pagination link has an explicit page value.
  firstPageHasParam: Confidence;
  // Total pages observed from last-page / highest-page pagination links.
  // Useful for productCount estimation: totalPages * perPage ≈ total items.
  totalPagesObserved: Confidence;
}

interface AssemblyPhase {
  overallConfidence: 'high' | 'medium' | 'low';
  completedPhases: string[];
  failedPhases: string[];
  warnings: string[];
  // Derived expected product count — NULL when ingredients aren't all present.
  // Combines Phase 6 totalPagesObserved + perPage. Falls back to sitemap count
  // when no pagination was observed. Always record the `source` so the skill
  // judgment layer knows whether to trust it or run a manual pagination walk.
  expectedProductCount: Confidence;
  expectedProductCountSource: string | null; // 'pagination-walk' | 'sitemap' | 'api' | null
  // Flag set when Phase 5/6 had to test against a facet-filtered URL because
  // the bare category URL failed (WAF challenge, robots.txt disallow, etc.).
  // When true, totalPagesObserved is a FACET count, NOT the global count —
  // the skill must re-verify the global count separately before writing the
  // profile's expectedProductCount.
  testUrlWasFacetFiltered: Confidence;
}

interface ProbeReport {
  url: string;
  canonicalUrl: string;
  probedAt: string;
  phases: {
    access: AccessPhase;
    platform: PlatformPhase;
    adapter: AdapterPhase;
    catalog: CatalogPhase;
    sort: SortPhase;
    pagination: PaginationPhase;
    assembly: AssemblyPhase;
  };
  errors: ProbeError[];
  duration: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const log = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

function conf(value: any, confidence: Confidence['confidence']): Confidence {
  return { value, confidence };
}

/**
 * Native-fetch fallback for servers that send malformed HTTP/1.1 headers
 * (e.g. Celerant/ColdFusion sends `X-Frame-Options : SAMEORIGIN` with trailing
 * whitespace before the colon, which trips Node's llhttp parser
 * HPE_INVALID_HEADER_TOKEN). Matches production http-client.ts:277-302.
 */
async function nativeFetchText(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, any>; data: string } | null> {
  try {
    const resp = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      // Custom undici dispatcher with raised maxHeaderSize so Drupal-style
      // cache-tags headers (16KB+) don't produce UND_ERR_HEADERS_OVERFLOW.
      // @ts-ignore — undici dispatcher is a valid fetch option at runtime.
      dispatcher: BIG_HEADER_UNDICI,
    });
    const text = await resp.text();
    return {
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      data: text,
    };
  } catch {
    return null;
  }
}

async function safeFetch(url: string, opts: Record<string, any> = {}): Promise<{ status: number; headers: Record<string, any>; data: string; method?: 'axios' | 'native-fetch' } | null> {
  const defaultHeaders = {
    'User-Agent': DESKTOP_UA,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-CA,en;q=0.9',
  };
  const mergedHeaders = { ...defaultHeaders, ...(opts.headers || {}) };
  try {
    const resp = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 10,
      validateStatus: () => true,
      responseType: 'text',
      httpAgent: BIG_HEADER_HTTP_AGENT,
      httpsAgent: BIG_HEADER_HTTPS_AGENT,
      ...opts,
      headers: mergedHeaders,
    });
    return {
      status: resp.status,
      headers: resp.headers,
      data: typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data),
      method: 'axios',
    };
  } catch (e: any) {
    // HPE_INVALID_HEADER_TOKEN / Parse Error — server sent malformed headers
    // (Celerant ColdFusion, some legacy IIS configs). Fall back to undici's
    // native fetch which is more lenient.
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('parse error') || msg.includes('hpe_invalid') || msg.includes('invalid header')) {
      const r = await nativeFetchText(url, mergedHeaders);
      if (r) return { ...r, method: 'native-fetch' };
    }
    return null;
  }
}

async function safeFetchJson(url: string, opts: Record<string, any> = {}): Promise<{ status: number; headers: Record<string, any>; data: any; method?: 'axios' | 'native-fetch' } | null> {
  const defaultHeaders = {
    'User-Agent': DESKTOP_UA,
    Accept: 'application/json,*/*;q=0.8',
  };
  const mergedHeaders = { ...defaultHeaders, ...(opts.headers || {}) };
  try {
    const resp = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 10,
      validateStatus: () => true,
      httpAgent: BIG_HEADER_HTTP_AGENT,
      httpsAgent: BIG_HEADER_HTTPS_AGENT,
      ...opts,
      headers: mergedHeaders,
    });
    return { status: resp.status, headers: resp.headers, data: resp.data, method: 'axios' };
  } catch (e: any) {
    const msg = (e?.message || '').toLowerCase();
    if (msg.includes('parse error') || msg.includes('hpe_invalid') || msg.includes('invalid header')) {
      const r = await nativeFetchText(url, mergedHeaders);
      if (r) {
        try { return { ...r, data: JSON.parse(r.data), method: 'native-fetch' }; }
        catch { return { ...r, data: null, method: 'native-fetch' }; }
      }
    }
    return null;
  }
}

function extractFirstProducts($: cheerio.CheerioAPI, baseUrl: string, limit = 5): string[] {
  const products: string[] = [];
  const seen = new Set<string>();

  // Selector priority order — same as GenericRetailAdapter.extractCatalogProducts
  // PLUS Drupal-based listing selectors (node--type-classified / data-history-node-id)
  // so classifieds-style Drupal sites (gunpost.ca, other Drupal Views listings) are
  // extractable even though they don't use the word "product" anywhere.
  const SELECTORS = [
    '[data-product-id]', 'li.product', 'li[class*="product"]',
    '[class*="product-card"]', '[class*="product-item"]', '[class*="product-tile"]',
    '[data-product]', 'article[class*="product"]', '.card',
    '.products-list .item', '.products-grid .item', 'li.product-item',
    '.product-items > .product-item', '.productborder',
    '.product-grid[class*="col-"]', '.product-element',
    '.product-thumb', '.product-layout', 'div.product', 'a.product',
    '[class*="klevuProduct"]', '.kuResultsListing li',
    '[class*="hikashop_product"]', '.category_products .product',
    '[class*="product-index"]', '.listing-item', '[class*="ols-product"]',
    '.store_product_list_wrapper', '.grid-product',
    '[data-aid="PRODUCT_LIST_RENDERED"] [data-ux="GridCell"]',
    // Drupal listings — classifieds, auction, commerce. Matches gunpost.ca's
    // `<article data-history-node-id="N" class="node--type-classified gunpost-teaser">`.
    'article[data-history-node-id]',
    '[class*="node--type-classified"]',
    '[class*="node--type-product"]',
    '[class*="node--view-mode-teaser"]',
  ];

  for (const selector of SELECTORS) {
    $(selector).each((_, el) => {
      if (products.length >= limit) return;
      const element = $(el);
      // Skip sidebar/related
      if (element.closest('.sidebar, aside, .block-related, .block-viewed-products, .block-upsell').length > 0) return;

      // Extract product URL
      let href = element.find('a[href]').first().attr('href') || element.attr('href') || '';
      if (!href) return;
      try {
        href = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
      } catch { return; }
      if (seen.has(href)) return;
      seen.add(href);
      products.push(href);
    });
    if (products.length >= limit) break;
  }
  return products;
}

function extractProductTitles($: cheerio.CheerioAPI, limit = 3): string[] {
  const titles: string[] = [];
  // Extend selectors to match Celerant-style `a.product` + `article[class*=product]`
  // and also accept <span class="name"> which is the Celerant title container.
  // Also handle Drupal classifieds articles where title is inside `.field--name-title`
  // or a wrapping <h2>/<h3> anchor.
  const SELECTORS = [
    '[data-product-id]', 'li.product', '[class*="product-card"]',
    '[class*="product-item"]', '.card', '.products-list .item',
    '.product-thumb', 'div.product',
    'a.product', 'article[class*="product"]',
    'article[data-history-node-id]',
    '[class*="node--type-classified"]',
    '[class*="node--type-product"]',
  ];
  for (const sel of SELECTORS) {
    $(sel).each((_, el) => {
      if (titles.length >= limit) return;
      const element = $(el);
      if (element.closest('.sidebar, aside').length > 0) return;
      const title = element.find('h2, h3, h4, .product-title, .card-title, [class*="product-name"], [class*="ProductName"], span.name, .name').first().text().trim()
        || element.find('a').first().text().trim()
        || element.text().trim();
      if (title && title.length > 3 && title.length < 200 && !/^\$?\d[\d,.]*$/.test(title)) {
        titles.push(title.replace(/\s+/g, ' ').slice(0, 120));
      }
    });
    if (titles.length >= limit) break;
  }
  return titles;
}

// ── Phase 1: Access & Security ─────────────────────────────────────────────────

async function probeAccess(inputUrl: string): Promise<{ result: AccessPhase; canonical: string }> {
  log('[Phase 1] Access & Security...');

  // Follow redirects to find canonical host
  let canonicalUrl = inputUrl;
  let canonicalConf: Confidence['confidence'] = 'low';
  try {
    const resp = await axios.head(inputUrl, {
      timeout: 15000, maxRedirects: 10, validateStatus: () => true,
      headers: { 'User-Agent': DESKTOP_UA },
      httpAgent: BIG_HEADER_HTTP_AGENT, httpsAgent: BIG_HEADER_HTTPS_AGENT,
    });
    if (resp.request?.res?.responseUrl) {
      canonicalUrl = resp.request.res.responseUrl;
      canonicalConf = 'high';
    }
  } catch {
    // Try GET fallback
    const r = await safeFetch(inputUrl);
    if (r) canonicalConf = 'medium';
  }
  // Normalize: strip trailing slash for consistency
  canonicalUrl = canonicalUrl.replace(/\/$/, '');
  const origin = new URL(canonicalUrl).origin;

  // Run heavy WAF probe
  let wafEvidence: Record<string, any> = {};
  let hasWaf = false;
  let wafType: string | null = null;
  try {
    const probeScript = path.resolve(__dirname, 'heavy-waf-probe.sh');
    log('  Running heavy-waf-probe.sh...');
    const probeOutput = execSync(`bash "${probeScript}" "${origin}"`, {
      timeout: 120000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse WAF indicators ONLY from actual header lines (BATCH 1).
    // Naive substring match against the whole probe output matches the
    // INTERPRETATION GUIDE trailer ("no cf-ray/x-sucuri" etc.) and the
    // "WAF INDICATORS IN HEADERS" legend, producing false positives.
    const headerBatchMatch = probeOutput.match(/=== BATCH 1:[^=]*===([\s\S]*?)(?=\n=== BATCH)/);
    const headerLines = (headerBatchMatch ? headerBatchMatch[1] : '').split('\n');
    // Each header line from BATCH 1 starts with a lowercase header name followed by ':'
    // e.g. "server: Null", "cf-ray: 123", "x-sucuri-id: abc"
    const headerOnly = headerLines.filter(l => /^[a-z][a-z0-9-]+:/i.test(l.trim())).join('\n');

    const hasCfRay = /^cf-ray:/im.test(headerOnly);
    const hasSucuri = /^x-sucuri-(id|cache|block):/im.test(headerOnly);
    const hasIncapsulaHeader = /^(x-iinfo|x-cdn:\s*incapsula):/im.test(headerOnly);
    const hasSgCaptcha = /^sg-captcha:/im.test(headerOnly);
    const hasCloudflareServer = /^server:\s*cloudflare/im.test(headerOnly);
    // Cookie-based WAF markers (check set-cookie lines specifically)
    const hasIncapsulaCookie = /^set-cookie:\s*(visid_incap|incap_ses|nlbi_)/im.test(headerOnly);

    // Status-code signals from all batches (these are safe — STATUS= is probe-specific prefix)
    const has403 = /\bSTATUS=403\b/.test(probeOutput);
    const has429 = /\bSTATUS=429\b/.test(probeOutput);
    const has503 = /\bSTATUS=503\b/.test(probeOutput);

    if (hasCfRay || hasCloudflareServer) {
      hasWaf = true;
      wafType = has403 || has503 ? 'cloudflare-active' : 'cloudflare-passive';
    } else if (hasSucuri) {
      hasWaf = true;
      wafType = 'sucuri';
    } else if (hasIncapsulaHeader || hasIncapsulaCookie) {
      hasWaf = true;
      wafType = 'incapsula';
    } else if (hasSgCaptcha) {
      hasWaf = true;
      wafType = 'siteground-sgcaptcha';
    } else if (has403 || has429 || has503) {
      hasWaf = true;
      wafType = has429 ? 'rate-limit' : 'unknown';
    }

    wafEvidence.cfRay = hasCfRay;
    wafEvidence.sucuri = hasSucuri;
    wafEvidence.incapsulaHeader = hasIncapsulaHeader;
    wafEvidence.incapsulaCookie = hasIncapsulaCookie;
    wafEvidence.sgCaptcha = hasSgCaptcha;
    wafEvidence.cloudflareServer = hasCloudflareServer;
    wafEvidence.saw403 = has403;
    wafEvidence.saw429 = has429;
    wafEvidence.saw503 = has503;
    // Capture the actual server header(s) seen — useful for platform detection
    const serverMatch = headerOnly.match(/^server:\s*(.+)$/im);
    wafEvidence.serverHeader = serverMatch ? serverMatch[1].trim() : null;
    // Capture set-cookie signatures (CFID/CFTOKEN = ColdFusion, ASP.NET_SessionId = IIS)
    wafEvidence.setCookieMarkers = {
      cfid: /^set-cookie:\s*CFID=/im.test(headerOnly),
      cftoken: /^set-cookie:\s*CFTOKEN=/im.test(headerOnly),
      aspNetSession: /^set-cookie:\s*ASP\.NET_SessionId=/im.test(headerOnly),
      jSessionId: /^set-cookie:\s*JSESSIONID=/im.test(headerOnly),
      phpSession: /^set-cookie:\s*PHPSESSID=/im.test(headerOnly),
    };
    wafEvidence.probeBatchesRun = (probeOutput.match(/=== BATCH/g) || []).length;
  } catch (e: any) {
    wafEvidence.error = e.message?.slice(0, 500);
    log('  WAF probe failed:', e.message?.slice(0, 200));
  }

  // Test multiple UAs — with native-fetch fallback for malformed-header sites.
  // We track whether axios saw HPE errors so the platform phase can flag
  // Celerant/ColdFusion / legacy-IIS malformed-response-header quirks.
  const uaTests = [
    { label: 'desktop-chrome', ua: DESKTOP_UA },
    { label: 'iphone-safari', ua: IPHONE_UA },
    { label: 'python-bot', ua: 'python-requests/2.31.0' },
    { label: 'curl', ua: 'curl/8.1.2' },
    { label: 'no-ua', ua: '' },
  ];
  const uaResults: AccessPhase['userAgentResults'] = [];
  let anyHpeError = false;
  for (const t of uaTests) {
    const headers: Record<string, string> = { Accept: 'text/html' };
    if (t.ua) headers['User-Agent'] = t.ua;
    try {
      const r = await axios.get(origin, {
        timeout: 15000, maxRedirects: 10, validateStatus: () => true, headers,
        httpAgent: BIG_HEADER_HTTP_AGENT, httpsAgent: BIG_HEADER_HTTPS_AGENT,
      });
      uaResults.push({ ua: t.ua, label: t.label, status: r.status, method: 'axios' });
    } catch (e: any) {
      const msg = e?.message || '';
      const isHpe = /parse error|hpe_invalid|invalid header/i.test(msg);
      if (isHpe) anyHpeError = true;
      if (isHpe) {
        const r = await nativeFetchText(origin, headers);
        if (r) uaResults.push({ ua: t.ua, label: t.label, status: r.status, method: 'native-fetch', error: 'HPE_INVALID_HEADER_TOKEN (axios fallback ok)' });
        else uaResults.push({ ua: t.ua, label: t.label, status: null, error: `${msg.slice(0, 200)} (native-fetch also failed)`, method: 'native-fetch' });
      } else {
        uaResults.push({ ua: t.ua, label: t.label, status: null, error: msg.slice(0, 200) });
      }
    }
  }

  // robots.txt
  let crawlDelay: number | null = null;
  const robotsDisallowed: string[] = [];
  const robotsResp = await safeFetch(`${origin}/robots.txt`);
  if (robotsResp && robotsResp.status === 200 && robotsResp.data.includes('User-agent')) {
    const lines = robotsResp.data.split('\n');
    for (const line of lines) {
      const cdMatch = line.match(/^Crawl-delay:\s*(\d+)/i);
      if (cdMatch) crawlDelay = parseInt(cdMatch[1]);
      const disMatch = line.match(/^Disallow:\s*(.+)/i);
      if (disMatch) robotsDisallowed.push(disMatch[1].trim());
    }
  }

  return {
    canonical: origin,
    result: {
      canonicalUrl: conf(canonicalUrl, canonicalConf),
      hasWaf: conf(hasWaf, hasWaf ? 'high' : 'medium'),
      wafType: conf(wafType, wafType ? 'high' : 'none'),
      wafProbeEvidence: wafEvidence,
      userAgentResults: uaResults,
      crawlDelay: conf(crawlDelay, crawlDelay !== null ? 'high' : 'none'),
      robotsDisallowed,
      malformedHeaders: conf(anyHpeError, anyHpeError ? 'high' : 'low'),
      serverHeader: conf(wafEvidence.serverHeader, wafEvidence.serverHeader ? 'high' : 'none'),
    },
  };
}

// ── Phase 2: Platform & Rendering ──────────────────────────────────────────────

async function probePlatform(origin: string, accessPhase?: AccessPhase): Promise<PlatformPhase> {
  log('[Phase 2] Platform & Rendering...');

  const resp = await safeFetch(origin);
  if (!resp) {
    return {
      platform: conf(null, 'none'), platformMarkers: [], jsOverlay: conf(null, 'none'),
      renderingMode: conf(null, 'none'), availableApis: [], needsPlaywright: conf(null, 'none'),
      multilingual: conf(false, 'none'), sitemapUrls: [], sitemapProductCount: conf(null, 'none'),
    };
  }

  const html = resp.data;
  const headers = resp.headers;
  const markers: string[] = [];
  let platform: string | null = null;
  let platformConf: Confidence['confidence'] = 'low';

  // Phase 1 signals (may be undefined if accessPhase not passed)
  const wafEvidence = accessPhase?.wafProbeEvidence || {};
  const sawCfCookies = !!wafEvidence.setCookieMarkers?.cfid || !!wafEvidence.setCookieMarkers?.cftoken;
  const sawAspNetSession = !!wafEvidence.setCookieMarkers?.aspNetSession;
  const sawMalformedHeaders = accessPhase?.malformedHeaders?.value === true;
  const accessServerHeader = accessPhase?.serverHeader?.value as string | null;

  // Platform detection — ordered by specificity.
  // Signature set also consults Phase 1 signals (set-cookie, server header,
  // malformed-header presence) so vendors like Celerant/ColdFusion that
  // otherwise look like plain HTML are correctly identified.
  const checks: [string, RegExp | ((h: string, hd: Record<string, any>) => boolean)][] = [
    ['woocommerce', (h) => /wp-content\/plugins\/woocommerce|wc-ajax|class="woocommerce/i.test(h)],
    ['shopify', (h) => /cdn\.shopify\.com|window\.Shopify|\/cdn\/shop\//i.test(h)],
    ['bigcommerce-stencil', (h) => /Stencil\.storefrontAPIToken|cdn11\.bigcommerce\.com/i.test(h) && /BCData/i.test(h)],
    ['bigcommerce-blueprint', (h) => /BCData/i.test(h) && !/Stencil/i.test(h)],
    ['magento2', (h) => /static\/version\d|requirejs-config|Magento_/i.test(h)],
    ['magento1', (h) => /\/js\/varien\/|catalog\/product\/view\/id\//i.test(h)],
    ['opencart', (h) => /catalog\/view\/theme|route=product\/category/i.test(h)],
    ['lightspeed', (h) => /cdn\.shoplightspeed\.com|shoplightspeed/i.test(h)],
    ['ecwid-on-wordpress', (h) => /app\.ecwid\.com\/script\.js/i.test(h)],
    ['odoo', (h) => /content="Odoo"|oe_website_sale|oe_currency_value/i.test(h)],
    ['volusion', (_h, hd) => /Volusion/i.test(hd['x-powered-by'] || '')],
    ['wix-stores', (h) => /wixBiSession|thunderbolt/i.test(h)],
    ['godaddy-ols', (h) => /mysimplestore|data-aid="PRODUCT_LIST_RENDERED"/i.test(h)],
    // ColdFusion signatures (Mistake: Celerant/ColdFusion sites silently HPE
    // axios due to trailing-space headers like `X-Frame-Options : SAMEORIGIN`).
    // Celerant is the dominant ColdFusion eCommerce vendor in the Canadian
    // firearms fleet — their storefront JS is served from celerantwebservices.com.
    ['celerant-coldfusion', (h) =>
      /celerantwebservices\.com/i.test(h) ||
      (sawCfCookies && /all-products\/browse|\/orderby\/|\/perpage\//i.test(h)) ||
      (sawCfCookies && sawMalformedHeaders && /\.cfm\b/i.test(h))],
    ['coldfusion', (h) =>
      /\.cfm\b/i.test(h) || sawCfCookies ||
      /(?:jakarta|kotlin|webcharts|cfclient|cfform|cfinput|cfmodule)/i.test(h)],
    // ASP.NET / IIS signatures
    ['aspnet', (h, hd) =>
      /__VIEWSTATE|__EVENTVALIDATION|\.aspx\b/i.test(h) ||
      /asp\.net/i.test(hd['x-powered-by'] || '') ||
      sawAspNetSession],
    // Drupal signatures — header-first (most authoritative), then HTML markers.
    // More specific (Drupal Commerce) checked BEFORE plain Drupal so
    // first-match-wins lands on the more informative tag.
    // `x-generator: Drupal 10` + `x-commerce-core: 2` → Drupal Commerce.
    // Plain Drupal without Commerce is still Drupal (classifieds, news, etc.).
    ['drupal-commerce', (_h, hd) =>
      hd['x-commerce-core'] !== undefined &&
      (/^Drupal\b/i.test(hd['x-generator'] || '') || hd['x-drupal-cache-tags'] !== undefined)],
    ['drupal', (h, hd) =>
      /^Drupal\b/i.test(hd['x-generator'] || '') ||
      /data-drupal-selector|drupalSettings|data-history-node-id|\/sites\/default\/files\//i.test(h) ||
      hd['x-drupal-cache'] !== undefined ||
      hd['x-drupal-dynamic-cache'] !== undefined ||
      hd['x-drupal-cache-tags'] !== undefined],
    ['wordpress', (h) => /wp-content/i.test(h)],
  ];

  for (const [name, check] of checks) {
    const matched = typeof check === 'function' ? check(html, headers) : check.test(html);
    if (matched) {
      markers.push(name);
      if (!platform) {
        platform = name;
        platformConf = 'high';
      }
    }
  }

  // Volusion from response headers specifically
  if (/Volusion/i.test(headers['x-powered-by'] || '')) {
    if (!markers.includes('volusion')) markers.push('volusion');
    if (!platform) { platform = 'volusion'; platformConf = 'high'; }
  }
  // Wix from server header
  if (/Pepyaka/i.test(headers['server'] || '')) {
    if (!markers.includes('wix-stores')) markers.push('wix-stores');
    if (!platform) { platform = 'wix-stores'; platformConf = 'high'; }
  }

  // Generator meta tag
  const $ = cheerio.load(html);
  const generator = $('meta[name="generator"]').attr('content') || '';
  if (generator) markers.push(`generator:${generator}`);

  // Platform-diagnostic markers from Phase 1 signals
  if (sawCfCookies) markers.push('cookie:CFID-CFTOKEN');
  if (sawAspNetSession) markers.push('cookie:ASP.NET_SessionId');
  if (sawMalformedHeaders) markers.push('malformed-headers:HPE_INVALID_HEADER_TOKEN');
  if (accessServerHeader && /^null$/i.test(accessServerHeader.trim())) markers.push('server:Null');
  if (accessServerHeader && /adobe|coldfusion|lucee|openbd/i.test(accessServerHeader)) {
    markers.push(`server:${accessServerHeader}`);
  }

  // Response-header markers — useful for downstream judgment even when the
  // platform regex didn't promote them. These headers are the authoritative
  // signal for Drupal / Drupal Commerce / WP and cannot be forged by theme
  // customization the way HTML can.
  const xGen = headers['x-generator'];
  if (xGen) markers.push(`x-generator:${String(xGen).slice(0, 80)}`);
  const xCommerce = headers['x-commerce-core'];
  if (xCommerce) markers.push(`x-commerce-core:${xCommerce}`);
  if (headers['x-drupal-cache'] || headers['x-drupal-dynamic-cache']) markers.push('header:x-drupal-cache');
  if (headers['x-drupal-cache-tags']) markers.push('header:x-drupal-cache-tags');

  // JS overlay detection
  let jsOverlay: string | null = null;
  if (/cdn\.searchspring\.net/i.test(html)) jsOverlay = 'searchspring';
  else if (/klevu-/i.test(html)) jsOverlay = 'klevu';
  else if (/algolia/i.test(html)) jsOverlay = 'algolia';
  else if (/fastsimonsearch|fast-simon/i.test(html)) jsOverlay = 'fastsimmon';
  else if (/constructor\.io/i.test(html)) jsOverlay = 'constructor-io';

  // Rendering mode — check if products are in initial HTML
  const testProducts = extractFirstProducts($, origin, 3);
  const productTitles = extractProductTitles($, 3);
  let renderingMode: string;
  if (testProducts.length > 0 || productTitles.length > 0) {
    renderingMode = 'static-html';
  } else if (html.length > 5000) {
    renderingMode = 'spa-likely';
  } else {
    renderingMode = 'unknown';
  }

  // API probes
  const apis: PlatformPhase['availableApis'] = [];

  // WP REST API
  const wpRest = await safeFetchJson(`${origin}/wp-json/wp/v2/product?per_page=1`);
  if (wpRest && wpRest.status === 200 && Array.isArray(wpRest.data)) {
    const total = parseInt(wpRest.headers['x-wp-total'] || '0');
    apis.push({ name: 'wp-rest', accessible: true, productCount: total, evidence: `x-wp-total: ${total}` });
  } else {
    apis.push({ name: 'wp-rest', accessible: false, evidence: wpRest ? `status ${wpRest.status}` : 'timeout/error' });
  }

  // WC Store API
  const storeApi = await safeFetchJson(`${origin}/wp-json/wc/store/v1/products?per_page=1`);
  if (storeApi && storeApi.status === 200 && Array.isArray(storeApi.data)) {
    const total = parseInt(storeApi.headers['x-wp-total'] || '0');
    apis.push({ name: 'wc-store-api', accessible: true, productCount: total, evidence: `x-wp-total: ${total}` });
  } else {
    apis.push({ name: 'wc-store-api', accessible: false, evidence: storeApi ? `status ${storeApi.status}` : 'timeout/error' });
  }

  // Shopify
  const shopifyApi = await safeFetchJson(`${origin}/products.json?limit=1`);
  if (shopifyApi && shopifyApi.status === 200 && shopifyApi.data?.products) {
    apis.push({ name: 'shopify-json', accessible: true, evidence: `products array present` });
  } else {
    apis.push({ name: 'shopify-json', accessible: false, evidence: shopifyApi ? `status ${shopifyApi.status}` : 'timeout/error' });
  }

  // Ecwid store ID extraction
  if (platform === 'ecwid-on-wordpress') {
    const ecwidMatch = html.match(/app\.ecwid\.com\/script\.js\?(\d+)/);
    if (ecwidMatch) {
      const storeId = ecwidMatch[1];
      try {
        const ecwidResp = await axios.post(
          `https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/${storeId}/catalog/search`,
          { lang: 'en', pagination: { offset: 0, limit: 1 } },
          {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json', Origin: origin, Referer: `${origin}/` },
            httpAgent: BIG_HEADER_HTTP_AGENT, httpsAgent: BIG_HEADER_HTTPS_AGENT,
          },
        );
        if (ecwidResp.data?.totalProductsCount !== undefined) {
          apis.push({
            name: 'ecwid-storefront',
            accessible: true,
            productCount: ecwidResp.data.totalProductsCount,
            evidence: `storeId=${storeId}, totalProductsCount=${ecwidResp.data.totalProductsCount}`,
          });
        }
      } catch {
        apis.push({ name: 'ecwid-storefront', accessible: false, evidence: `storeId=${storeId}, request failed` });
      }
    }
  }

  // Sitemaps — try canonical, index, product-specific, and several vendor-specific forms.
  // Platform-specific paths are checked first; fall back to generic.
  const sitemapCandidates = [
    '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml',
    '/product-sitemap.xml', '/sitemap_products.xml', '/products-sitemap.xml',
    '/store-products-sitemap.xml', // Wix
    '/sitemap/products.xml',
    '/sitemap_products_1.xml',     // Shopify
  ];
  const sitemapUrls: string[] = [];
  let sitemapProductCount: number | null = null;
  let sitemapIndexFollowed = 0;

  // Heuristics for classifying a <loc> as a product vs category
  function classifyLocs(locs: string[]): { product: number; likelyProduct: string[] } {
    // Product URL positive patterns — broaden to common vendor schemes.
    // Celerant uses /shop/<slug>-<id>; Shopify /products/<handle>; BC /<slug>/;
    // Magento uses .html suffix on product pages; OpenCart uses product_id=N in queries.
    const productPatterns = [
      /\/products?\/[^\/]+\/?$/i,          // /products/foo or /product/foo
      /\/shop\/[^\/]+(?:\-\d{2,})?\/?$/i,   // /shop/foo-123 (Celerant) or /shop/foo
      /\/product-page\/[^\/]+\/?$/i,       // Wix
      /\/item\/[^\/]+\/?$/i,               // eBay-style
      /\/p\/[^\/]+\/?$/i,                  // shortened
      /[-_]p\d{3,}\.html/i,                 // legacy .html with id suffix
      /\/[^\/]+-\d{4,}\/?$/i,              // /<slug>-NNNN (Celerant without /shop prefix)
      /\/productdetails\.asp/i,            // Volusion
      /\/catalog\/product\/view\/id\/\d+/i, // Magento
      /route=product\/product/i,            // OpenCart
      // Drupal classifieds 3-segment nested path — /<cat>/<subcat>/<location>/<slug>
      // e.g. gunpost.ca /firearms/rifles/edmonton/mauser-sporter-243-win-24
      // Match 4 or more slash-separated path segments after the domain, each
      // non-empty. This is intentionally loose; categoryPatterns filter out
      // obvious nav paths upstream.
      /\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]+\/[a-z][a-z0-9-]{3,}\/?$/i,
    ];
    // Obvious category / navigation negative patterns
    const categoryPatterns = [
      /\/product-category\//i,
      /\/collections?\//i,
      /\/category\//i,
      /\/brand\//i,
      /\/tag\//i,
      /\/page\/\d+/i,
      /\/browse\/?$/i,
      /\/(cart|checkout|account|login|contact|about|faq|blog|news|privacy|terms|search)\b/i,
    ];
    const likelyProduct: string[] = [];
    let product = 0;
    for (const raw of locs) {
      const loc = raw.replace(/^<loc>/, '').replace(/<\/loc>$/, '').trim();
      if (categoryPatterns.some(p => p.test(loc))) continue;
      if (productPatterns.some(p => p.test(loc))) {
        product++;
        if (likelyProduct.length < 5) likelyProduct.push(loc);
      }
    }
    return { product, likelyProduct };
  }

  for (const smPath of sitemapCandidates) {
    const smResp = await safeFetch(`${origin}${smPath}`);
    if (smResp && smResp.status === 200 && smResp.data.includes('<')) {
      sitemapUrls.push(smPath);
      const rawLocs = smResp.data.match(/<loc>[^<]+<\/loc>/g) || [];
      // Detect sitemap index — count <sitemap> entries (not <url>)
      const isIndex = /<sitemap>/.test(smResp.data) && !/<url>/.test(smResp.data.slice(0, 2000));
      if (isIndex) {
        // Follow ALL sub-sitemaps — previous logic (product|item|shop filter,
        // then pick [0]) missed sites whose index uses generic child URLs
        // like `/sitemap.xml?page=1` (gunpost.ca's Drupal simple_sitemap).
        // Cap total follows at 5 to avoid runaway work on pathological sites.
        const MAX_FOLLOWS = 5;
        // Prefer product-looking children first, then fall back to others
        const prioritized = [
          ...rawLocs.filter(l => /product|item|shop/i.test(l)),
          ...rawLocs.filter(l => !/product|item|shop/i.test(l)),
        ];
        for (const child of prioritized) {
          if (sitemapIndexFollowed >= MAX_FOLLOWS) break;
          sitemapIndexFollowed++;
          const subUrl = child.replace(/^<loc>/, '').replace(/<\/loc>$/, '').trim();
          const sub = await safeFetch(subUrl);
          if (sub && sub.status === 200) {
            const subLocs = sub.data.match(/<loc>[^<]+<\/loc>/g) || [];
            const { product } = classifyLocs(subLocs);
            if (product > 0) sitemapProductCount = (sitemapProductCount || 0) + product;
          }
        }
        continue;
      }
      // Non-index sitemap: classify every <loc> regardless of path keyword.
      // Previously we only counted if the path/contents had "product" — that
      // missed legitimate product sitemaps like Celerant /sitemap.xml which
      // doesn't use the "product" word anywhere.
      const { product } = classifyLocs(rawLocs);
      if (product > 0) sitemapProductCount = (sitemapProductCount || 0) + product;
    }
  }

  // Multilingual detection
  const hasHreflang = $('link[hreflang]').length > 0;
  const hasWpml = /wpml/i.test(html);
  const hasLangPrefix = /\/(en|fr|es|de)\//i.test(html);
  const multilingual = hasHreflang || hasWpml || hasLangPrefix;

  const needsPlaywright = renderingMode === 'spa-likely' || jsOverlay !== null;

  return {
    platform: conf(platform, platformConf),
    platformMarkers: markers,
    jsOverlay: conf(jsOverlay, jsOverlay ? 'high' : 'none'),
    renderingMode: conf(renderingMode, renderingMode !== 'unknown' ? 'medium' : 'low'),
    availableApis: apis,
    needsPlaywright: conf(needsPlaywright, needsPlaywright ? 'medium' : 'low'),
    multilingual: conf(multilingual, multilingual ? 'medium' : 'low'),
    sitemapUrls,
    sitemapProductCount: conf(sitemapProductCount, sitemapProductCount ? 'medium' : 'none'),
  };
}

// ── Phase 3: Adapter Selection & Testing ───────────────────────────────────────

async function probeAdapter(origin: string, platformPhase: PlatformPhase): Promise<AdapterPhase> {
  log('[Phase 3] Adapter Selection & Testing...');

  const platform = platformPhase.platform.value as string | null;
  const apis = platformPhase.availableApis;
  const wpRestApi = apis.find(a => a.name === 'wp-rest' && a.accessible);
  const shopifyApi = apis.find(a => a.name === 'shopify-json' && a.accessible);
  const ecwidApi = apis.find(a => a.name === 'ecwid-storefront' && a.accessible);

  let suggestedAdapter: string;
  let adapterConf: Confidence['confidence'] = 'medium';

  // Drupal classifieds detection — look for node--type-classified / gunpost-teaser
  // markers in the homepage/catalog HTML. If present alongside platform=drupal*,
  // suggest the purpose-built `classifieds-gunpost` adapter (domain-generic
  // for any Drupal-classified-node-type site using the same view mode and
  // `data-history-node-id` convention). Callers can still override.
  const isDrupalPlatform = platform === 'drupal' || platform === 'drupal-commerce';
  let isDrupalClassifieds = false;
  if (isDrupalPlatform) {
    const homeResp = await safeFetch(origin);
    if (homeResp && /node--type-classified|gunpost-teaser|classified-teaser/i.test(homeResp.data)) {
      isDrupalClassifieds = true;
    }
  }

  if (platform === 'woocommerce' && wpRestApi) {
    suggestedAdapter = 'woocommerce';
    adapterConf = 'high';
  } else if (platform === 'shopify' && shopifyApi) {
    suggestedAdapter = 'shopify';
    adapterConf = 'high';
  } else if (platform === 'ecwid-on-wordpress' && ecwidApi) {
    suggestedAdapter = 'generic-retail'; // Ecwid handled as apiAlternative in GenericRetail
    adapterConf = 'high';
  } else if (isDrupalClassifieds) {
    // The classifieds-gunpost adapter's selectors (node--type-classified,
    // gunpost-teaser, data-history-node-id) match any Drupal site using
    // the standard classifieds content type + default teaser view mode.
    suggestedAdapter = 'classifieds-gunpost';
    adapterConf = 'high';
  } else if (platform) {
    suggestedAdapter = 'generic-retail';
    adapterConf = 'medium';
  } else {
    suggestedAdapter = 'generic-retail';
    adapterConf = 'low';
  }

  // API accessibility test
  let apiAccessible = false;
  if (wpRestApi) {
    // Test date-sorted query
    const r = await safeFetchJson(`${origin}/wp-json/wp/v2/product?per_page=1&orderby=date&order=desc`);
    apiAccessible = !!(r && r.status === 200 && Array.isArray(r.data) && r.data.length > 0);
  } else if (shopifyApi) {
    apiAccessible = true;
  } else if (ecwidApi) {
    apiAccessible = true;
  }

  // Extraction test — fetch a category page and try to extract products
  let extractionResult: AdapterPhase['extractionTestResult'] = null;
  // Try to find a category page from nav links
  const homeResp = await safeFetch(origin);
  if (homeResp) {
    const $ = cheerio.load(homeResp.data);
    // Find first plausible category link
    let categoryUrl: string | null = null;

    $('nav a[href], header a[href], .menu a[href], [class*="nav"] a[href]').each((_, el) => {
      if (categoryUrl) return;
      const href = $(el).attr('href') || '';
      // Skip non-category links
      if (/\/(cart|login|account|contact|about|faq|blog|news|privacy|terms|checkout|search|my-)\b/i.test(href)) return;
      if (href === '/' || href === '#' || href === origin) return;
      // Must look like a category/collection — generic platform-native paths
      // + some common domain-agnostic markers. Domain-specific category names
      // (firearms/rifles/etc.) are NOT in this list to keep the probe generic.
      // Added: classifieds-style listing paths (/ads, /listings, /classifieds)
      // so Drupal / custom classifieds sites are detected (gunpost.ca uses /ads).
      if (/\/(product-category|collections?|departments?|category|categories|shop|store|browse|all-products|all|products|catalog|ads|listings|classifieds)\b/i.test(href)) {
        try {
          const abs = href.startsWith('http') ? href : new URL(href, origin).toString();
          // Same-host only — never drift to a subdomain. gunpost.ca's nav
          // links to `shop.gunpost.ca/` (a separate WooCommerce merch site);
          // auditing that subdomain produces wrong platform/adapter output
          // for the origin site being probed.
          const abdOrigin = new URL(abs).origin;
          if (abdOrigin !== origin) return;
          categoryUrl = abs;
        } catch {}
      }
    });

    if (categoryUrl) {
      log(`  Testing extraction on: ${categoryUrl}`);
      const catResp = await safeFetch(categoryUrl);
      if (catResp && catResp.status === 200) {
        const cat$ = cheerio.load(catResp.data);
        const products = extractFirstProducts(cat$, categoryUrl, 10);
        const titles = extractProductTitles(cat$, 5);
        extractionResult = {
          url: categoryUrl,
          productsFound: products.length,
          sampleTitles: titles,
        };
      }
    }
  }

  return {
    suggestedAdapter: conf(suggestedAdapter, adapterConf),
    apiAccessible: conf(apiAccessible, apiAccessible ? 'high' : 'low'),
    extractionTestResult: extractionResult,
  };
}

// ── Phase 4: Catalog Discovery ─────────────────────────────────────────────────

async function probeCatalog(origin: string, platformPhase: PlatformPhase): Promise<CatalogPhase> {
  log('[Phase 4] Catalog Discovery...');

  const platform = platformPhase.platform.value as string | null;
  const categoryTree: CatalogPhase['categoryTree'] = [];
  let apiProductCount: number | null = null;

  // WooCommerce: category taxonomy API
  if (platform === 'woocommerce') {
    const catResp = await safeFetchJson(`${origin}/wp-json/wp/v2/product_cat?per_page=100&hide_empty=true`);
    if (catResp && catResp.status === 200 && Array.isArray(catResp.data)) {
      for (const cat of catResp.data) {
        categoryTree.push({
          name: cat.name,
          url: cat.link || '',
          count: cat.count,
          parentId: cat.parent,
        });
      }
    }
    // Total product count from WP REST
    const wpTotal = platformPhase.availableApis.find(a => a.name === 'wp-rest')?.productCount;
    if (wpTotal) apiProductCount = wpTotal;
  }

  // Shopify: collections API
  if (platform === 'shopify') {
    const colResp = await safeFetchJson(`${origin}/collections.json?limit=250`);
    if (colResp && colResp.status === 200 && colResp.data?.collections) {
      for (const col of colResp.data.collections) {
        categoryTree.push({
          name: col.title,
          url: `/collections/${col.handle}`,
          count: col.products_count,
        });
      }
    }
  }

  // Nav link extraction from homepage
  const navLinks: string[] = [];
  const homeResp = await safeFetch(origin);
  if (homeResp) {
    const $ = cheerio.load(homeResp.data);
    const seen = new Set<string>();
    $('nav a[href], header a[href], .menu a[href], [class*="nav"] a[href], .mega-menu a[href]').each((_, el) => {
      let href = $(el).attr('href') || '';
      if (!href || href === '/' || href === '#') return;
      try {
        href = href.startsWith('http') ? href : new URL(href, origin).toString();
      } catch { return; }
      // Only same-origin
      if (!href.startsWith(origin)) return;
      // Skip obvious non-category
      if (/\/(cart|login|account|contact|about|faq|blog|news|privacy|terms|search|my-|checkout)\b/i.test(href)) return;
      const path = new URL(href).pathname;
      if (!seen.has(path)) {
        seen.add(path);
        navLinks.push(path);
      }
    });
  }

  // Sitemap product count from Phase 2
  const smCount = platformPhase.sitemapProductCount.value as number | null;

  return {
    categoryTree,
    navLinks,
    sitemapProductCount: conf(smCount, smCount ? 'medium' : 'none'),
    apiProductCount: conf(apiProductCount, apiProductCount ? 'high' : 'none'),
  };
}

// ── Phase 5: Sort Verification ─────────────────────────────────────────────────

async function probeSort(origin: string, platformPhase: PlatformPhase, catalogPhase: CatalogPhase, adapterPhase?: AdapterPhase): Promise<SortPhase> {
  log('[Phase 5] Sort Verification...');

  const platform = platformPhase.platform.value as string | null;

  // Find a category page to test sort on.
  // For a clean ID-jump test, the "default" URL must have NO sort applied —
  // any testUrl with `/orderby/<value>/`, `?sort=`, etc. biases the baseline
  // toward whatever sort was baked into the URL.
  function stripSortFromUrl(u: string): string {
    try {
      const url = new URL(u);
      // Strip path-based sort segments
      url.pathname = url.pathname.replace(/\/(orderby|sort_by|sort-by|sort|order)\/[A-Za-z][A-Za-z0-9_-]+/g, '');
      // Strip query-based sort params — includes Drupal Views `sort_by` + `sort_order`
      for (const key of ['sort', 'order', 'sortby', 'sortBy', 'product_list_order', 'product_list_dir', 'orderby', 'sort_by', 'sort_order']) {
        url.searchParams.delete(key);
      }
      return url.toString().replace(/\/+$/, '');
    } catch { return u; }
  }

  let testUrl: string | null = null;
  // Prefer the URL Phase 3 already verified extracts products. This avoids
  // false "sort not tested" verdicts on sites where the bare category URL
  // returns a WAF challenge but a sub-category URL (CF rule-selective) works.
  // Gunpost.ca is the canonical case: `/ads` returns 403 with cf-mitigated:challenge,
  // but `/ads?f[0]=c:1` (facet-filtered) returns 200.
  if (adapterPhase?.extractionTestResult?.url && adapterPhase.extractionTestResult.productsFound > 0) {
    testUrl = adapterPhase.extractionTestResult.url;
  }
  // Prefer a category from the tree
  if (!testUrl && catalogPhase.categoryTree.length > 0) {
    const cat = catalogPhase.categoryTree.find(c => (c.count || 0) > 5) || catalogPhase.categoryTree[0];
    testUrl = cat.url.startsWith('http') ? cat.url : `${origin}${cat.url}`;
  }
  // Fallback: pick from nav links (generic platform-native paths only).
  // Prefer paths WITHOUT a pre-baked /orderby/... segment so the default-sort
  // baseline is unbiased.
  // Classifieds-style /ads|/listings|/classifieds are included so Drupal-based
  // classifieds (gunpost.ca) and custom classifieds sites get sort/pagination
  // verified too.
  if (!testUrl && catalogPhase.navLinks.length > 0) {
    const candidates = catalogPhase.navLinks.filter(p =>
      /\/(product-category|collections?|departments?|category|categories|shop|store|browse|all-products|catalog|products|ads|listings|classifieds)\b/i.test(p)
    );
    // Bare URL (no /orderby|/sort path segment) is preferred
    const bare = candidates.find(p => !/\/(orderby|sort_by|sort-by|sort|order)\//i.test(p));
    const chosen = bare || candidates[0];
    if (chosen) testUrl = `${origin}${chosen}`;
  }
  // Strip any lingering sort segment from the chosen testUrl
  if (testUrl) testUrl = stripSortFromUrl(testUrl);

  if (!testUrl) {
    return {
      sortOptions: [],
      sortScheme: conf(null, 'none'),
      idJumpTest: {
        defaultFirstProduct: null, newestFirstProduct: null, counterControlFirstProduct: null,
        newestParam: null, counterControlParam: null, verdict: 'not-tested',
      },
    };
  }

  log(`  Sort test URL: ${testUrl}`);
  const catResp = await safeFetch(testUrl);
  if (!catResp || catResp.status !== 200) {
    return {
      sortOptions: [],
      sortScheme: conf(null, 'none'),
      idJumpTest: {
        defaultFirstProduct: null, newestFirstProduct: null, counterControlFirstProduct: null,
        newestParam: null, counterControlParam: null, verdict: 'not-tested',
      },
    };
  }

  const $ = cheerio.load(catResp.data);

  // Extract sort options from <select> elements. Dedupe by (name+value) —
  // some sites render the <select> twice (top and bottom of the page).
  const sortOptionsSeen = new Set<string>();
  const sortOptions: SortOption[] = [];
  $('select').each((_, sel) => {
    const selEl = $(sel);
    const name = selEl.attr('name') || '';
    const id = selEl.attr('id') || '';
    // Heuristic: sort-related select elements
    if (/sort|order/i.test(name + id) || selEl.closest('[class*="sort"]').length > 0) {
      selEl.find('option').each((_, opt) => {
        const value = $(opt).attr('value') || '';
        const text = $(opt).text().trim();
        const key = `${name}|${id}|${value}`;
        if ((value || text) && !sortOptionsSeen.has(key)) {
          sortOptionsSeen.add(key);
          sortOptions.push({ value, text, selectName: name, selectId: id });
        }
      });
    }
  });

  // Also check <a> based sort (Odoo + Drupal Views style): href carries
  // query params. Drupal Views uses `sort_by=<column>&sort_order=ASC|DESC`;
  // Odoo uses `order=<column>+<dir>`; some Drupal themes use a plain
  // `sort=<column>&order=<dir>` pair on <a> tags instead of <select>.
  $('a[href*="order="], a[href*="sort="], a[href*="sortby="], a[href*="sort_by="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    const paramMatch = href.match(/[?&](order|sort|sortby|sort_by|product_list_order)=([^&#]+)/);
    if (paramMatch && text) {
      // Capture paired direction params (sort_order for Drupal Views,
      // order for bare Drupal-sort anchors) so the option value reflects
      // the full sort directive. Without this, ID-jump builds `?sort=created`
      // (ASC default) instead of `?sort=created&order=desc` and misses the
      // newest-first intent the link encodes.
      let fullValue = paramMatch[2];
      let paired: string | null = null;
      if (paramMatch[1] === 'sort_by') {
        const m = href.match(/[?&]sort_order=([^&#]+)/);
        if (m) paired = `sort_order=${m[1]}`;
      } else if (paramMatch[1] === 'sort') {
        const m = href.match(/[?&]order=([^&#]+)/);
        if (m) paired = `order=${m[1]}`;
      }
      if (paired) fullValue = `${paramMatch[2]}&${paired}`;
      const key = `${paramMatch[1]}||${fullValue}`;
      if (!sortOptionsSeen.has(key)) {
        sortOptionsSeen.add(key);
        sortOptions.push({ value: fullValue, text, selectName: paramMatch[1], selectId: '' });
      }
    }
  });

  // Detect path-based sort scheme. Some platforms (Celerant, some OpenCart
  // themes, certain LightSpeed configurations) encode sort in the URL path
  // as /orderby/<value>/ or /sort/<value>/ rather than as a query param.
  // We scan all nav/pagination links for /orderby/|/sort_by/|/sort/|/o/|/order/ path
  // segments followed by an identifier to detect this convention.
  let sortScheme: 'query' | 'path' | 'hash' | 'js-only' | null = null;
  const pathSortRegex = /\/(orderby|sort_by|sort-by|sort|order)\/([A-Za-z][A-Za-z0-9_-]+)\//;
  let pathSortSegmentFound: string | null = null;
  $('a[href]').each((_, el) => {
    if (pathSortSegmentFound) return;
    const href = $(el).attr('href') || '';
    const m = href.match(pathSortRegex);
    if (m) pathSortSegmentFound = m[1]; // the keyword, e.g. "orderby"
  });
  if (pathSortSegmentFound) sortScheme = 'path';
  else if (sortOptions.some(o => o.selectName || o.selectId)) sortScheme = 'query';
  // Hash sort scheme is Searchspring-detected in Phase 2 — not mechanical from DOM alone.
  // JS-only sort scheme (Ecwid SPA, GoDaddy OLS) needs Playwright — probe can't detect from static HTML.

  if (sortOptions.length === 0) {
    // No sort UI found — check if OpenCart (hidden date sort probe)
    const result: SortPhase = {
      sortOptions: [],
      sortScheme: conf(pathSortSegmentFound ? 'path' : null, pathSortSegmentFound ? 'medium' : 'none'),
      idJumpTest: {
        defaultFirstProduct: null, newestFirstProduct: null, counterControlFirstProduct: null,
        newestParam: null, counterControlParam: null, verdict: 'no-sort-options',
      },
    };

    if (platform === 'opencart') {
      // OpenCart hidden date sort probe (Mistake 21)
      const defaultProducts = extractFirstProducts($, testUrl, 1);
      const dateProbeUrl = testUrl + (testUrl.includes('?') ? '&' : '?') + 'sort=p.date_added&order=DESC';
      const dateResp = await safeFetch(dateProbeUrl);
      if (dateResp && dateResp.status === 200) {
        const date$ = cheerio.load(dateResp.data);
        const dateProducts = extractFirstProducts(date$, dateProbeUrl, 1);
        result.openCartDateProbe = {
          param: '?sort=p.date_added&order=DESC',
          firstProduct: dateProducts[0] || null,
          defaultFirstProduct: defaultProducts[0] || null,
          honored: dateProducts[0] !== defaultProducts[0] && dateProducts.length > 0,
        };
        if (result.openCartDateProbe.honored) {
          result.idJumpTest.verdict = 'honored';
          result.idJumpTest.newestParam = 'sort=p.date_added&order=DESC';
          result.idJumpTest.defaultFirstProduct = defaultProducts[0] || null;
          result.idJumpTest.newestFirstProduct = dateProducts[0] || null;
        }
      }
    }

    return result;
  }

  // Identify ALL newest-style candidates (not just the first). Different vendors
  // expose multiple newest-style sorts with different semantics (e.g. Celerant's
  // `new-arrivals` = "new to storefront" vs `newest-rcvd` = "newest received by
  // warehouse" — both match the newest regex but produce DIFFERENT orderings).
  // Probing all candidates and picking the one that produces the most distinct
  // ordering avoids silently choosing the wrong one.
  // NEWEST_REGEX matches both text labels ("Newest", "New Arrivals", "Posted Date")
  // and machine values (`created`, `date_pub`, `addedTimeDesc`, etc.). The
  // `created&order=desc` / `sort_by=date_pub&sort_order=DESC` full option
  // values produced by the anchor-pair capture above are covered by the
  // `created.*desc` and `date.*desc` fragments.
  // The bare `posted` / `date_pub` / `created` words match the "newest by date"
  // intent found on Drupal classifieds sites where the sort label is literally
  // "Posted Date" rather than "Newest".
  const NEWEST_REGEX = /newest|new.to.old|most.recent|new[- ]?arrival|date.*desc|added.*desc|created.*desc|published.*desc|addedtimedesc|created-descending|published-descending|recent|posted|\bcreated\b|\bdate_pub\b/i;
  const COUNTER_REGEX = /alpha.*asc|name.*asc|\ba.*z\b|title.*asc|nameasc|alphaasc/i;

  const newestCandidates = sortOptions.filter(o => NEWEST_REGEX.test(o.text + ' ' + o.value));
  let counterOption: SortOption | null =
    sortOptions.find(o => COUNTER_REGEX.test(o.text + ' ' + o.value)) ||
    sortOptions.find(o => /price.*asc|priceasc|price-low/i.test(o.text + ' ' + o.value)) ||
    null;

  // Helper: build a URL applying a given sort option. Supports BOTH query-param
  // schemes (`?order=<value>`) and path schemes (`/orderby/<value>/`).
  // Handles paired values like `created&order=desc` or `date_pub&sort_order=DESC`
  // emitted by the anchor-pair capture — split on `&` and apply each sub-param.
  const buildSortUrl = (opt: SortOption): string => {
    if (sortScheme === 'path' && pathSortSegmentFound) {
      // Path-based: insert `/<keyword>/<value>` before the trailing slash.
      // If the value has paired query params (unlikely for path-scheme sites),
      // strip them for the path insertion.
      const pathValue = opt.value.split('&')[0];
      const base = testUrl!.replace(/\/+$/, '');
      const re = new RegExp(`/${pathSortSegmentFound}/[A-Za-z][A-Za-z0-9_-]*`);
      if (re.test(base)) return base.replace(re, `/${pathSortSegmentFound}/${pathValue}`);
      return `${base}/${pathSortSegmentFound}/${pathValue}`;
    }
    // Query-param scheme
    const base = new URL(testUrl!);
    if (opt.selectName) {
      // Split paired values (e.g. `created&order=desc` → `sort=created` +
      // `order=desc`). The primary value is the first sub-token; any
      // `key=value` parts after `&` are applied as additional searchParams.
      const parts = opt.value.split('&');
      const primaryValue = parts[0];
      base.searchParams.set(opt.selectName, primaryValue);
      for (const extra of parts.slice(1)) {
        const eq = extra.indexOf('=');
        if (eq > 0) {
          base.searchParams.set(extra.slice(0, eq), extra.slice(eq + 1));
        }
      }
      return base.toString();
    }
    // <a>-based without selectName: assume the option value is a literal
    // query string fragment
    return testUrl + (testUrl!.includes('?') ? '&' : '?') + `${opt.selectName || 'sort'}=${opt.value}`;
  };

  // Default (unsorted) first product
  const defaultProducts = extractFirstProducts($, testUrl, 1);

  // Run ID-jump for every newest candidate — collect { value, text, firstProduct, score }
  const newestResults: { value: string; text: string; firstProduct: string | null; score: number }[] = [];
  for (const cand of newestCandidates) {
    const sortUrl = buildSortUrl(cand);
    const r = await safeFetch(sortUrl);
    if (r && r.status === 200) {
      const s$ = cheerio.load(r.data);
      const firstProduct = extractFirstProducts(s$, sortUrl, 1)[0] || null;
      // Score: distinct-from-default (+2) + distinct-from-other-candidates (+1 each)
      let score = 0;
      if (firstProduct && defaultProducts[0] && firstProduct !== defaultProducts[0]) score += 2;
      newestResults.push({ value: cand.value, text: cand.text, firstProduct, score });
    } else {
      newestResults.push({ value: cand.value, text: cand.text, firstProduct: null, score: -1 });
    }
  }
  // Award +1 for each other candidate with a different firstProduct
  for (const r of newestResults) {
    if (!r.firstProduct) continue;
    for (const other of newestResults) {
      if (other === r) continue;
      if (other.firstProduct && other.firstProduct !== r.firstProduct) r.score += 1;
    }
  }
  newestResults.sort((a, b) => b.score - a.score);

  // The primary newest option is the highest-scoring one
  const primaryNewest = newestResults.length > 0 && newestResults[0].score >= 0
    ? newestCandidates.find(c => c.value === newestResults[0].value) || null
    : null;

  let counterProducts: string[] = [];
  let counterParam: string | null = null;
  if (counterOption) {
    const sortUrl = buildSortUrl(counterOption);
    counterParam = sortScheme === 'path'
      ? `${pathSortSegmentFound}/${counterOption.value}`
      : `${counterOption.selectName}=${counterOption.value}`;
    const r = await safeFetch(sortUrl);
    if (r && r.status === 200) {
      const s$ = cheerio.load(r.data);
      counterProducts = extractFirstProducts(s$, sortUrl, 1);
    }
  }

  const newestProducts: string[] = primaryNewest
    ? [newestResults[0].firstProduct].filter(Boolean) as string[]
    : [];
  const newestParam = primaryNewest
    ? (sortScheme === 'path'
        ? `${pathSortSegmentFound}/${primaryNewest.value}`
        : `${primaryNewest.selectName}=${primaryNewest.value}`)
    : null;

  // Determine verdict — 3-outcome decision tree (Mistake 29):
  //   `honored`                  — newest != default
  //   `honored-default-is-newest` — newest == default BUT counter-control differs
  //   `noop`                     — everything identical
  let verdict: SortPhase['idJumpTest']['verdict'] = 'noop';
  if (newestProducts[0] && defaultProducts[0]) {
    if (newestProducts[0] !== defaultProducts[0]) {
      verdict = 'honored';
    } else if (counterProducts[0] && counterProducts[0] !== defaultProducts[0]) {
      verdict = 'honored-default-is-newest';
    } else {
      verdict = 'noop';
    }
  } else if (newestCandidates.length === 0) {
    verdict = 'no-sort-options';
  }

  return {
    sortOptions,
    sortScheme: conf(sortScheme, sortScheme ? 'high' : 'none'),
    newestCandidates: newestResults.length > 0 ? newestResults : undefined,
    idJumpTest: {
      defaultFirstProduct: defaultProducts[0] || null,
      newestFirstProduct: newestProducts[0] || null,
      counterControlFirstProduct: counterProducts[0] || null,
      newestParam,
      counterControlParam: counterParam,
      verdict,
    },
  };
}

// ── Phase 6: Pagination Verification ───────────────────────────────────────────

async function probePagination(origin: string, catalogPhase: CatalogPhase, platformPhase: PlatformPhase, adapterPhase?: AdapterPhase): Promise<PaginationPhase> {
  log('[Phase 6] Pagination Verification...');

  // Find a category page to test
  let testUrl: string | null = null;
  // Prefer Phase 3's verified URL (see Phase 5 rationale) so CF-selective
  // WAFs don't kill Phase 6 when the bare catalog URL is blocked.
  if (adapterPhase?.extractionTestResult?.url && adapterPhase.extractionTestResult.productsFound > 0) {
    testUrl = adapterPhase.extractionTestResult.url;
  }
  if (!testUrl && catalogPhase.categoryTree.length > 0) {
    const cat = catalogPhase.categoryTree.find(c => (c.count || 0) > 30) || catalogPhase.categoryTree[0];
    testUrl = cat.url.startsWith('http') ? cat.url : `${origin}${cat.url}`;
  }
  if (!testUrl && catalogPhase.navLinks.length > 0) {
    const candidate = catalogPhase.navLinks.find(p =>
      /\/(product-category|collections?|departments?|category|categories|shop|store|browse|all-products|catalog|products|ads|listings|classifieds)\b/i.test(p)
    );
    if (candidate) testUrl = `${origin}${candidate}`;
  }

  const empty: PaginationPhase = {
    paginationPattern: conf(null, 'none'), perPage: conf(null, 'none'),
    page1Products: [], page2Products: [], zeroOverlap: conf(null, 'none'), paginationLinks: [],
    zeroIndexed: conf(null, 'none'), firstPageHasParam: conf(null, 'none'),
    totalPagesObserved: conf(null, 'none'),
  };

  if (!testUrl) return empty;

  log(`  Pagination test URL: ${testUrl}`);
  const p1Resp = await safeFetch(testUrl);
  if (!p1Resp || p1Resp.status !== 200) return empty;

  const p1$ = cheerio.load(p1Resp.data);
  const page1Products = extractFirstProducts(p1$, testUrl, 20);

  // Extract pagination links from HTML
  const paginationLinks: string[] = [];
  const paginationSelectors = [
    'a[href*="page="]', 'a[href*="/page/"]', 'a[href*="paged="]',
    '.pagination a[href]', '.pager a[href]', 'nav.woocommerce-pagination a[href]',
    '[class*="pagination"] a[href]', 'a[class*="page-numbers"]',
    'a[href*="page"][href*=".html"]', // LightSpeed suffix
  ];
  const seenLinks = new Set<string>();
  for (const sel of paginationSelectors) {
    p1$(sel).each((_, el) => {
      const href = p1$(el).attr('href') || '';
      if (href && !seenLinks.has(href)) {
        seenLinks.add(href);
        paginationLinks.push(href);
      }
    });
  }

  // Detect pagination pattern from links
  let detectedPattern: string | null = null;
  let page2Url: string | null = null;

  for (const link of paginationLinks) {
    let fullLink: string;
    try {
      fullLink = link.startsWith('http') ? link : new URL(link, testUrl).toString();
    } catch { continue; }

    // Query param: ?page=2
    if (/[?&]page=2(&|$)/.test(fullLink)) {
      detectedPattern = 'query:page';
      page2Url = fullLink;
      break;
    }
    // Path: /page/2
    if (/\/page\/2\/?/.test(fullLink)) {
      detectedPattern = 'path:/page/{N}';
      page2Url = fullLink;
      break;
    }
    // Paged query: ?paged=2
    if (/[?&]paged=2(&|$)/.test(fullLink)) {
      detectedPattern = 'query:paged';
      page2Url = fullLink;
      break;
    }
    // Suffix: page2.html (LightSpeed)
    if (/page2\.html/.test(fullLink)) {
      detectedPattern = 'suffix-replace:page{N}.html';
      page2Url = fullLink;
      break;
    }
    // Offset query: ?offset=N
    if (/[?&]offset=\d+/.test(fullLink)) {
      detectedPattern = 'offset-query';
      page2Url = fullLink;
      break;
    }
  }

  // VERIFY detected pattern against counter-candidate. Some platforms (LightSpeed
  // eCom, certain Celerant configs) accept BOTH `?page=N` AND `/page/N` in URLs,
  // but only one is actually honored — the other silently returns page 1. Run
  // a cross-check: if we detected query:page, also try path:/page/{N} and take
  // whichever produces page-1-distinct products (non-overlap with page 1).
  async function verifyPattern(pattern: string, url: string): Promise<{ pattern: string; url: string; p2Products: string[]; overlap: number } | null> {
    const r = await safeFetch(url);
    if (!r || r.status !== 200) return null;
    const c$ = cheerio.load(r.data);
    const p2 = extractFirstProducts(c$, url, 20);
    const overlap = p2.filter(u => page1Products.includes(u)).length;
    return { pattern, url, p2Products: p2, overlap };
  }

  // If no page 2 link found from DOM, OR we want to cross-verify, try common
  // patterns. Critically: candidates must PRESERVE any sort-path segment
  // (e.g. /orderby/<value>/) that's already baked into testUrl.
  const candidates: { pattern: string; url: string }[] = [];
  const baseNoTrailing = testUrl.replace(/\/+$/, '');
  candidates.push({ pattern: 'query:page', url: testUrl + (testUrl.includes('?') ? '&page=2' : '?page=2') });
  candidates.push({ pattern: 'path:/page/{N}', url: `${baseNoTrailing}/page/2` });
  candidates.push({ pattern: 'query:paged', url: testUrl + (testUrl.includes('?') ? '&paged=2' : '?paged=2') });
  // Suffix-replace for LightSpeed eCom-style `page2.html`
  if (/\.html(\?|$)/.test(testUrl)) {
    candidates.push({ pattern: 'suffix-replace:page{N}.html', url: testUrl.replace(/\/([^/?#.]*?)(\.html)(\?.*)?$/, '/$1/page2.html$3') });
  }

  // If DOM already pointed to a specific pattern, test it FIRST but still
  // verify against page-1 non-overlap
  if (page2Url && detectedPattern) {
    candidates.unshift({ pattern: detectedPattern, url: page2Url });
  }

  // Probe every candidate and keep the first with zero-overlap-to-page-1
  let bestCandidate: { pattern: string; url: string; p2Products: string[]; overlap: number } | null = null;
  for (const c of candidates) {
    const result = await verifyPattern(c.pattern, c.url);
    if (!result) continue;
    // Keep the first pattern that produces fresh products
    if (result.p2Products.length > 0 && result.overlap === 0) {
      bestCandidate = result;
      break;
    }
    // Keep the "best" (lowest-overlap) as a fallback if none fully zero
    if (!bestCandidate || result.overlap < bestCandidate.overlap) bestCandidate = result;
  }
  if (bestCandidate) {
    detectedPattern = bestCandidate.pattern;
    page2Url = bestCandidate.url;
  }

  // Fetch page 2 and compare
  let page2Products: string[] = [];
  if (page2Url) {
    const p2Resp = await safeFetch(page2Url);
    if (p2Resp && p2Resp.status === 200) {
      const p2$ = cheerio.load(p2Resp.data);
      page2Products = extractFirstProducts(p2$, page2Url, 20);
    }
  }

  const overlap = page2Products.filter(u => page1Products.includes(u));
  const zeroOverlap = page2Products.length > 0 && overlap.length === 0;

  // Detect 0-indexed pagination (Drupal Views convention).
  // Signal: any pagination link with `?page=0` OR `&page=0` literal. Matches
  // gunpost.ca (`<a href="?sort_by=...&page=0" title="Current page">`). This
  // feeds profile.paginationPattern.zeroIndexed.
  const zeroIndexed = paginationLinks.some(l => /[?&]page=0(&|$|#)/.test(l));

  // Detect firstPageHasParam — if the page-0 or page-1 link is the
  // "Current page" anchor, the param is explicit; otherwise the default
  // URL (no page param) IS page 1.
  const firstPageHasParam = !!paginationLinks.find(l =>
    /title=("Current page"|'Current page')/i.test(l) ||
    /aria-current=("page"|'page')/i.test(l)
  );

  // Max page observed across the page-link DOM. Useful for product-count
  // estimation (totalPages * perPage ≈ total count). gunpost.ca advertises
  // `page=1693` on the Rifles facet (1694 pages × 18 = 30,492 ≈ 30,423).
  let totalPages: number | null = null;
  for (const l of paginationLinks) {
    const m = l.match(/[?&]page=(\d+)/);
    if (m) {
      const n = parseInt(m[1]);
      if (!isNaN(n) && (totalPages === null || n > totalPages)) totalPages = n;
    }
  }
  // If 0-indexed, totalPages is max-observed + 1 (since index 0 = page 1)
  const totalPagesAdjusted = totalPages !== null ? (zeroIndexed ? totalPages + 1 : totalPages) : null;

  return {
    paginationPattern: conf(detectedPattern, detectedPattern && zeroOverlap ? 'high' : detectedPattern ? 'medium' : 'none'),
    perPage: conf(page1Products.length > 0 ? page1Products.length : null, page1Products.length > 0 ? 'medium' : 'none'),
    page1Products: page1Products.slice(0, 5),
    page2Products: page2Products.slice(0, 5),
    zeroOverlap: conf(zeroOverlap, page2Products.length > 0 ? 'high' : 'none'),
    paginationLinks: paginationLinks.slice(0, 10),
    zeroIndexed: conf(zeroIndexed, zeroIndexed ? 'high' : paginationLinks.length > 0 ? 'medium' : 'none'),
    firstPageHasParam: conf(firstPageHasParam, firstPageHasParam ? 'high' : paginationLinks.length > 0 ? 'medium' : 'none'),
    totalPagesObserved: conf(totalPagesAdjusted, totalPagesAdjusted !== null ? 'medium' : 'none'),
  };
}

// ── Phase 7: Assembly ──────────────────────────────────────────────────────────

function assemble(
  errors: ProbeError[],
  access: AccessPhase,
  platform: PlatformPhase,
  adapter: AdapterPhase,
  catalog: CatalogPhase,
  sort: SortPhase,
  pagination: PaginationPhase,
): AssemblyPhase {
  const completed: string[] = [];
  const failed: string[] = [];
  const warnings: string[] = [];

  // Access
  if (access.canonicalUrl.confidence !== 'none') completed.push('access'); else failed.push('access');

  // Platform
  if (platform.platform.value) completed.push('platform'); else failed.push('platform');

  // Adapter
  if (adapter.extractionTestResult && adapter.extractionTestResult.productsFound > 0) {
    completed.push('adapter');
  } else {
    failed.push('adapter');
    warnings.push('Product extraction returned 0 products — may need Playwright or different selectors');
  }

  // Catalog
  if (catalog.categoryTree.length > 0 || catalog.navLinks.length > 0) completed.push('catalog'); else failed.push('catalog');

  // Sort
  if (sort.idJumpTest.verdict === 'honored' || sort.idJumpTest.verdict === 'honored-default-is-newest') {
    completed.push('sort');
  } else if (sort.idJumpTest.verdict === 'no-sort-options') {
    failed.push('sort');
    warnings.push('No sort UI found in HTML. If this is a SPA, drive Playwright to discover sort controls (Mistake 19).');
  } else {
    completed.push('sort'); // noop is still a completed probe
    warnings.push('Sort options found but none honored newest-first ordering. Verify manually.');
  }

  // Pagination
  if (pagination.zeroOverlap.value === true) {
    completed.push('pagination');
  } else {
    failed.push('pagination');
    warnings.push('Pagination not verified — page 2 overlap test failed or no page 2 found.');
  }

  // WAF warnings
  if (access.hasWaf.value && !access.wafProbeEvidence.error) {
    warnings.push(`WAF detected: ${access.wafType.value}. May need cookie management or Playwright.`);
  }

  // Malformed-header warning (Celerant / ColdFusion / legacy IIS). The production
  // http-client.ts catches this via native-fetch fallback; the probe now also
  // handles it, but any site that triggers this needs explicit `wafWorkaround`
  // profile metadata.
  if (access.malformedHeaders?.value === true) {
    warnings.push('Server sends malformed HTTP/1.1 headers (HPE_INVALID_HEADER_TOKEN). Axios fails; native-fetch fallback in http-client.ts handles this. Profile must record wafWorkaround.method=undici-fallback.');
  }

  // SPA warning
  if (platform.renderingMode.value === 'spa-likely') {
    warnings.push('Site appears to be a SPA. Static HTML extraction may return 0 products. Use Playwright.');
  }

  // JS overlay warning
  if (platform.jsOverlay.value) {
    warnings.push(`JS overlay detected: ${platform.jsOverlay.value}. Sort/pagination may be hijacked (see Searchspring/Klevu lessons).`);
  }

  // Multiple-newest-sort disambiguation warning
  if ((sort as any).newestCandidates && (sort as any).newestCandidates.length > 1) {
    const chosen = (sort as any).newestCandidates[0];
    warnings.push(`Multiple newest-style sort options found (${(sort as any).newestCandidates.length}). Selected "${chosen?.value}" via ID-jump score=${chosen?.score}. Verify manually — other candidates may be correct for different merchants (e.g. Celerant new-arrivals vs newest-rcvd).`);
  }

  // Path-based sort scheme warning — informs the skill to emit path-form sortParam
  if (sort.sortScheme?.value === 'path') {
    warnings.push('Sort uses URL PATH scheme (not query param). catalogUrls must bake sort segment into the URL (e.g. /orderby/<value>/). paginationPattern must preserve the sort segment in page URLs.');
  }

  const phaseErrors = errors.map(e => e.phase);
  const overallConfidence = failed.length === 0 ? 'high' : failed.length <= 2 ? 'medium' : 'low';

  // Detect whether the pagination/sort test URL was facet-filtered. Common
  // signals: URL contains `f[0]=` (Drupal Views facet), `category=` query
  // param, etc. When true, totalPagesObserved is a SUBSET count, not the
  // global count — the skill must warn the operator.
  const probeTestUrl = adapter.extractionTestResult?.url || '';
  const FACET_FILTERED_RE = /(?:[?&](?:f(?:\[|%5B)\d+(?:\]|%5D)=|category=|cat=|taxonomy=|filter=)|\/(?:category|department|brand)\/)/i;
  const wasFacetFiltered = FACET_FILTERED_RE.test(probeTestUrl);

  // Derive an expected product count from the probe ingredients. Priority:
  //   1. API product count (WP REST, WC Store API, Ecwid totalProductsCount)
  //   2. Pagination walk (totalPages * perPage) — only when NOT facet-filtered
  //   3. Sitemap count (always a fallback — may lag for classifieds)
  let expectedCount: number | null = null;
  let expectedSource: string | null = null;
  // 1. API count
  const apiCount = platform.availableApis.find(a => a.accessible && a.productCount)?.productCount;
  if (apiCount && apiCount > 0) {
    expectedCount = apiCount;
    expectedSource = 'api';
  }
  // 2. Pagination walk (only when we trust the scope)
  if (!expectedCount) {
    const totalPages = pagination.totalPagesObserved.value as number | null;
    const perPage = pagination.perPage.value as number | null;
    if (totalPages && perPage && !wasFacetFiltered) {
      expectedCount = totalPages * perPage;
      expectedSource = 'pagination-walk';
    }
  }
  // 3. Sitemap fallback
  if (!expectedCount) {
    const smCount = platform.sitemapProductCount.value as number | null;
    if (smCount && smCount > 0) {
      expectedCount = smCount;
      expectedSource = 'sitemap';
    }
  }

  // Warning when we had to facet-filter — skill must re-verify global count
  if (wasFacetFiltered) {
    warnings.push(
      `Probe test URL was facet-filtered (${probeTestUrl}). Phase 6 totalPagesObserved reflects the FACET subset, not the global catalog. Re-verify expectedProductCount by walking the global sorted URL before writing the profile.`,
    );
  }

  // Warning when the best-count source is sitemap for a classifieds-style
  // site (Drupal classifieds, etc.). Sitemap lags the live /ads listing
  // because expired/sold listings drop from sitemap faster than from the
  // live catalog.
  if (expectedSource === 'sitemap' && adapter.suggestedAdapter.value === 'classifieds-gunpost') {
    warnings.push(
      `Sitemap product count (${expectedCount}) used for classifieds site. Sitemap typically LAGS the live /ads listing by 1-3 days because expired/sold listings drop from sitemap faster. Prefer a pagination walk of the global sorted catalogUrl for canonical count.`,
    );
  }

  return {
    overallConfidence,
    completedPhases: completed,
    failedPhases: failed,
    warnings,
    expectedProductCount: conf(expectedCount, expectedCount ? (expectedSource === 'api' ? 'high' : 'medium') : 'none'),
    expectedProductCountSource: expectedSource,
    testUrlWasFacetFiltered: conf(wasFacetFiltered, wasFacetFiltered ? 'high' : 'low'),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const inputUrl = process.argv[2];
  if (!inputUrl) {
    console.error('Usage: npx tsx scripts/pre-bootstrap-probe.ts https://example.com');
    process.exit(1);
  }

  // Normalize URL
  let url = inputUrl;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const startTime = Date.now();
  const errors: ProbeError[] = [];

  log(`\nPre-bootstrap probe: ${url}`);
  log('=' .repeat(60));

  // Phase 1: Access
  let accessResult: AccessPhase;
  let canonical: string;
  try {
    const r = await probeAccess(url);
    accessResult = r.result;
    canonical = r.canonical;
  } catch (e: any) {
    errors.push({ phase: 'access', message: e.message, stack: e.stack?.slice(0, 500) });
    canonical = new URL(url).origin;
    accessResult = {
      canonicalUrl: conf(url, 'none'), hasWaf: conf(null, 'none'), wafType: conf(null, 'none'),
      wafProbeEvidence: { error: e.message }, userAgentResults: [],
      crawlDelay: conf(null, 'none'), robotsDisallowed: [],
      malformedHeaders: conf(null, 'none'), serverHeader: conf(null, 'none'),
    };
  }

  // Phase 2: Platform
  let platformResult: PlatformPhase;
  try {
    platformResult = await probePlatform(canonical, accessResult);
  } catch (e: any) {
    errors.push({ phase: 'platform', message: e.message, stack: e.stack?.slice(0, 500) });
    platformResult = {
      platform: conf(null, 'none'), platformMarkers: [], jsOverlay: conf(null, 'none'),
      renderingMode: conf(null, 'none'), availableApis: [], needsPlaywright: conf(null, 'none'),
      multilingual: conf(false, 'none'), sitemapUrls: [], sitemapProductCount: conf(null, 'none'),
    };
  }

  // Phase 3: Adapter
  let adapterResult: AdapterPhase;
  try {
    adapterResult = await probeAdapter(canonical, platformResult);
  } catch (e: any) {
    errors.push({ phase: 'adapter', message: e.message, stack: e.stack?.slice(0, 500) });
    adapterResult = {
      suggestedAdapter: conf(null, 'none'), apiAccessible: conf(false, 'none'), extractionTestResult: null,
    };
  }

  // Phase 4: Catalog
  let catalogResult: CatalogPhase;
  try {
    catalogResult = await probeCatalog(canonical, platformResult);
  } catch (e: any) {
    errors.push({ phase: 'catalog', message: e.message, stack: e.stack?.slice(0, 500) });
    catalogResult = { categoryTree: [], navLinks: [], sitemapProductCount: conf(null, 'none'), apiProductCount: conf(null, 'none') };
  }

  // Phase 5: Sort
  let sortResult: SortPhase;
  try {
    sortResult = await probeSort(canonical, platformResult, catalogResult, adapterResult);
  } catch (e: any) {
    errors.push({ phase: 'sort', message: e.message, stack: e.stack?.slice(0, 500) });
    sortResult = {
      sortOptions: [],
      sortScheme: conf(null, 'none'),
      idJumpTest: {
        defaultFirstProduct: null, newestFirstProduct: null, counterControlFirstProduct: null,
        newestParam: null, counterControlParam: null, verdict: 'not-tested',
      },
    };
  }

  // Phase 6: Pagination
  let paginationResult: PaginationPhase;
  try {
    paginationResult = await probePagination(canonical, catalogResult, platformResult, adapterResult);
  } catch (e: any) {
    errors.push({ phase: 'pagination', message: e.message, stack: e.stack?.slice(0, 500) });
    paginationResult = {
      paginationPattern: conf(null, 'none'), perPage: conf(null, 'none'),
      page1Products: [], page2Products: [], zeroOverlap: conf(null, 'none'), paginationLinks: [],
      zeroIndexed: conf(null, 'none'), firstPageHasParam: conf(null, 'none'),
      totalPagesObserved: conf(null, 'none'),
    };
  }

  // Phase 7: Assembly
  const assemblyResult = assemble(errors, accessResult, platformResult, adapterResult, catalogResult, sortResult, paginationResult);

  const report: ProbeReport = {
    url,
    canonicalUrl: (accessResult.canonicalUrl.value as string) || url,
    probedAt: new Date().toISOString(),
    phases: {
      access: accessResult,
      platform: platformResult,
      adapter: adapterResult,
      catalog: catalogResult,
      sort: sortResult,
      pagination: paginationResult,
      assembly: assemblyResult,
    },
    errors,
    duration: Date.now() - startTime,
  };

  log('\n' + '='.repeat(60));
  log(`Probe complete in ${report.duration}ms — ${assemblyResult.overallConfidence} confidence`);
  log(`  Completed: ${assemblyResult.completedPhases.join(', ') || 'none'}`);
  log(`  Failed: ${assemblyResult.failedPhases.join(', ') || 'none'}`);
  if (assemblyResult.warnings.length > 0) {
    log('  Warnings:');
    for (const w of assemblyResult.warnings) log(`    - ${w}`);
  }

  // Output JSON to stdout
  console.log(JSON.stringify(report, null, 2));
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
