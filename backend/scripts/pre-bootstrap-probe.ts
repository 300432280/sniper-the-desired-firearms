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

// ── Types ──────────────────────────────────────────────────────────────────────

interface Confidence { value: string | number | boolean | null; confidence: 'high' | 'medium' | 'low' | 'none' }
interface ProbeError { phase: string; message: string; stack?: string }

interface AccessPhase {
  canonicalUrl: Confidence;
  hasWaf: Confidence;
  wafType: Confidence;
  wafProbeEvidence: Record<string, any>;
  userAgentResults: { ua: string; label: string; status: number | null; error?: string }[];
  crawlDelay: Confidence;
  robotsDisallowed: string[];
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
  idJumpTest: {
    defaultFirstProduct: string | null;
    newestFirstProduct: string | null;
    counterControlFirstProduct: string | null;
    newestParam: string | null;
    counterControlParam: string | null;
    verdict: 'honored' | 'honored-default-is-newest' | 'noop' | 'not-tested' | 'no-sort-options';
  };
  openCartDateProbe?: { param: string; firstProduct: string | null; defaultFirstProduct: string | null; honored: boolean };
}

interface PaginationPhase {
  paginationPattern: Confidence;
  perPage: Confidence;
  page1Products: string[];
  page2Products: string[];
  zeroOverlap: Confidence;
  paginationLinks: string[];
}

interface AssemblyPhase {
  overallConfidence: 'high' | 'medium' | 'low';
  completedPhases: string[];
  failedPhases: string[];
  warnings: string[];
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

async function safeFetch(url: string, opts: Record<string, any> = {}): Promise<{ status: number; headers: Record<string, any>; data: string } | null> {
  try {
    const resp = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 10,
      validateStatus: () => true,
      responseType: 'text',
      headers: { 'User-Agent': DESKTOP_UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-CA,en;q=0.9' },
      ...opts,
    });
    return { status: resp.status, headers: resp.headers, data: typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data) };
  } catch (e: any) {
    return null;
  }
}

async function safeFetchJson(url: string, opts: Record<string, any> = {}): Promise<{ status: number; headers: Record<string, any>; data: any } | null> {
  try {
    const resp = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 10,
      validateStatus: () => true,
      headers: { 'User-Agent': DESKTOP_UA, 'Accept': 'application/json,*/*;q=0.8' },
      ...opts,
    });
    return { status: resp.status, headers: resp.headers, data: resp.data };
  } catch {
    return null;
  }
}

function extractFirstProducts($: cheerio.CheerioAPI, baseUrl: string, limit = 5): string[] {
  const products: string[] = [];
  const seen = new Set<string>();

  // Selector priority order — same as GenericRetailAdapter.extractCatalogProducts
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
  const SELECTORS = [
    '[data-product-id]', 'li.product', '[class*="product-card"]',
    '[class*="product-item"]', '.card', '.products-list .item',
    '.product-thumb', 'div.product',
  ];
  for (const sel of SELECTORS) {
    $(sel).each((_, el) => {
      if (titles.length >= limit) return;
      const element = $(el);
      if (element.closest('.sidebar, aside').length > 0) return;
      const title = element.find('h2, h3, h4, .product-title, .card-title, [class*="product-name"], [class*="ProductName"]').first().text().trim()
        || element.find('a').first().text().trim();
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
    wafEvidence.rawOutput = probeOutput;

    // Parse WAF indicators from output
    const hasCfRay = /cf-ray:/i.test(probeOutput);
    const hasSucuri = /x-sucuri/i.test(probeOutput);
    const hasIncapsula = /visid_incap|incap_ses/i.test(probeOutput);
    const hasSgCaptcha = /sg-captcha/i.test(probeOutput);
    const hasCloudflareServer = /server:\s*cloudflare/i.test(probeOutput);
    const has403 = /STATUS=403/.test(probeOutput);
    const has429 = /STATUS=429/.test(probeOutput);
    const has503 = /STATUS=503/.test(probeOutput);

    if (hasCfRay || hasCloudflareServer) {
      hasWaf = true;
      wafType = has403 || has503 ? 'cloudflare-active' : 'cloudflare-passive';
    } else if (hasSucuri) {
      hasWaf = true;
      wafType = 'sucuri';
    } else if (hasIncapsula) {
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
    wafEvidence.incapsula = hasIncapsula;
    wafEvidence.sgCaptcha = hasSgCaptcha;
    wafEvidence.cloudflareServer = hasCloudflareServer;
    wafEvidence.saw403 = has403;
    wafEvidence.saw429 = has429;
    wafEvidence.saw503 = has503;
    // Don't send the raw output in the JSON — it's huge
    delete wafEvidence.rawOutput;
  } catch (e: any) {
    wafEvidence.error = e.message?.slice(0, 500);
    log('  WAF probe failed:', e.message?.slice(0, 200));
  }

  // Test multiple UAs
  const uaTests = [
    { label: 'desktop-chrome', ua: DESKTOP_UA },
    { label: 'iphone-safari', ua: IPHONE_UA },
    { label: 'python-bot', ua: 'python-requests/2.31.0' },
    { label: 'curl', ua: 'curl/8.1.2' },
    { label: 'no-ua', ua: '' },
  ];
  const uaResults: AccessPhase['userAgentResults'] = [];
  for (const t of uaTests) {
    try {
      const r = await axios.get(origin, {
        timeout: 15000, maxRedirects: 10, validateStatus: () => true,
        headers: { 'User-Agent': t.ua, Accept: 'text/html' },
      });
      uaResults.push({ ua: t.ua, label: t.label, status: r.status });
    } catch (e: any) {
      uaResults.push({ ua: t.ua, label: t.label, status: null, error: e.message?.slice(0, 200) });
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
    },
  };
}

// ── Phase 2: Platform & Rendering ──────────────────────────────────────────────

async function probePlatform(origin: string): Promise<PlatformPhase> {
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

  // Platform detection — ordered by specificity
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
          { timeout: 15000, headers: { 'Content-Type': 'application/json', Origin: origin, Referer: `${origin}/` } },
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

  // Sitemaps
  const sitemapCandidates = ['/sitemap.xml', '/product-sitemap.xml', '/sitemap_products.xml', '/sitemap_index.xml', '/store-products-sitemap.xml'];
  const sitemapUrls: string[] = [];
  let sitemapProductCount: number | null = null;

  for (const path of sitemapCandidates) {
    const smResp = await safeFetch(`${origin}${path}`);
    if (smResp && smResp.status === 200 && smResp.data.includes('<')) {
      sitemapUrls.push(path);
      // Count product URLs if this looks like a product sitemap
      if (/product/i.test(path) || /product/i.test(smResp.data.slice(0, 2000))) {
        const locMatches = smResp.data.match(/<loc>[^<]+<\/loc>/g);
        if (locMatches) {
          const productLocs = locMatches.filter((l: string) =>
            /product|item|_p_|\/p\/|\/shop\//i.test(l) && !/category|collection|tag|brand/i.test(l)
          );
          if (productLocs.length > 0) {
            sitemapProductCount = (sitemapProductCount || 0) + productLocs.length;
          }
        }
      }
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

  if (platform === 'woocommerce' && wpRestApi) {
    suggestedAdapter = 'woocommerce';
    adapterConf = 'high';
  } else if (platform === 'shopify' && shopifyApi) {
    suggestedAdapter = 'shopify';
    adapterConf = 'high';
  } else if (platform === 'ecwid-on-wordpress' && ecwidApi) {
    suggestedAdapter = 'generic-retail'; // Ecwid handled as apiAlternative in GenericRetail
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
      if (/\/(cart|login|account|contact|about|faq|blog|news|privacy|terms)\b/i.test(href)) return;
      if (href === '/' || href === '#' || href === origin) return;
      // Must look like a category/collection
      if (/\/(product-category|collections?|departments?|category|shop|store|firearms|rifles|ammunition|hunting|shooting)\b/i.test(href)) {
        try {
          categoryUrl = href.startsWith('http') ? href : new URL(href, origin).toString();
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

async function probeSort(origin: string, platformPhase: PlatformPhase, catalogPhase: CatalogPhase): Promise<SortPhase> {
  log('[Phase 5] Sort Verification...');

  const platform = platformPhase.platform.value as string | null;

  // Find a category page to test sort on
  let testUrl: string | null = null;
  // Prefer a category from the tree
  if (catalogPhase.categoryTree.length > 0) {
    const cat = catalogPhase.categoryTree.find(c => (c.count || 0) > 5) || catalogPhase.categoryTree[0];
    testUrl = cat.url.startsWith('http') ? cat.url : `${origin}${cat.url}`;
  }
  // Fallback: pick from nav links
  if (!testUrl && catalogPhase.navLinks.length > 0) {
    const candidate = catalogPhase.navLinks.find(p =>
      /\/(product-category|collections?|departments?|category|shop|firearms|rifles)\b/i.test(p)
    );
    if (candidate) testUrl = `${origin}${candidate}`;
  }

  if (!testUrl) {
    return {
      sortOptions: [],
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
      idJumpTest: {
        defaultFirstProduct: null, newestFirstProduct: null, counterControlFirstProduct: null,
        newestParam: null, counterControlParam: null, verdict: 'not-tested',
      },
    };
  }

  const $ = cheerio.load(catResp.data);

  // Extract sort options from <select> elements
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
        if (value || text) {
          sortOptions.push({ value, text, selectName: name, selectId: id });
        }
      });
    }
  });

  // Also check <a> based sort (Odoo style)
  $('a[href*="order="], a[href*="sort="], a[href*="sortby="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    const paramMatch = href.match(/[?&](order|sort|sortby|product_list_order)=([^&#]+)/);
    if (paramMatch && text) {
      sortOptions.push({ value: paramMatch[2], text, selectName: paramMatch[1], selectId: '' });
    }
  });

  if (sortOptions.length === 0) {
    // No sort UI found — check if OpenCart (hidden date sort probe)
    const result: SortPhase = {
      sortOptions: [],
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

  // Identify newest-sort and counter-control candidates
  let newestOption: SortOption | null = null;
  let counterOption: SortOption | null = null;

  for (const opt of sortOptions) {
    const t = (opt.text + ' ' + opt.value).toLowerCase();
    if (!newestOption && /newest|new.to.old|most.recent|date.*desc|added.*desc|created.*desc|addedtimedesc|created-descending/i.test(t)) {
      newestOption = opt;
    }
    if (!counterOption && /alpha.*asc|name.*asc|a.*z|title|nameasc/i.test(t)) {
      counterOption = opt;
    }
  }
  // Fallback counter-control: price ascending
  if (!counterOption) {
    counterOption = sortOptions.find(o => /price.*asc|priceasc/i.test(o.text + ' ' + o.value)) || null;
  }

  // ID-jump test
  const defaultProducts = extractFirstProducts($, testUrl, 1);

  const buildSortUrl = (opt: SortOption) => {
    const base = new URL(testUrl!);
    // Use the select's name attribute as param name, value as param value
    if (opt.selectName) {
      base.searchParams.set(opt.selectName, opt.value);
    } else {
      // For <a>-based sorts, the value already has the param structure
      return testUrl + (testUrl!.includes('?') ? '&' : '?') + `${opt.selectName || 'sort'}=${opt.value}`;
    }
    return base.toString();
  };

  let newestProducts: string[] = [];
  let counterProducts: string[] = [];
  let newestParam: string | null = null;
  let counterParam: string | null = null;

  if (newestOption) {
    const sortUrl = buildSortUrl(newestOption);
    newestParam = `${newestOption.selectName}=${newestOption.value}`;
    const r = await safeFetch(sortUrl);
    if (r && r.status === 200) {
      const s$ = cheerio.load(r.data);
      newestProducts = extractFirstProducts(s$, sortUrl, 1);
    }
  }

  if (counterOption) {
    const sortUrl = buildSortUrl(counterOption);
    counterParam = `${counterOption.selectName}=${counterOption.value}`;
    const r = await safeFetch(sortUrl);
    if (r && r.status === 200) {
      const s$ = cheerio.load(r.data);
      counterProducts = extractFirstProducts(s$, sortUrl, 1);
    }
  }

  // Determine verdict
  let verdict: SortPhase['idJumpTest']['verdict'] = 'noop';
  if (newestProducts[0] && defaultProducts[0]) {
    if (newestProducts[0] !== defaultProducts[0]) {
      verdict = 'honored';
    } else if (counterProducts[0] && counterProducts[0] !== defaultProducts[0]) {
      // Default same as newest but counter-control differs — default IS newest
      verdict = 'honored-default-is-newest';
    } else {
      verdict = 'noop';
    }
  } else if (!newestOption) {
    verdict = 'no-sort-options';
  }

  return {
    sortOptions,
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

async function probePagination(origin: string, catalogPhase: CatalogPhase, platformPhase: PlatformPhase): Promise<PaginationPhase> {
  log('[Phase 6] Pagination Verification...');

  // Find a category page to test
  let testUrl: string | null = null;
  if (catalogPhase.categoryTree.length > 0) {
    const cat = catalogPhase.categoryTree.find(c => (c.count || 0) > 30) || catalogPhase.categoryTree[0];
    testUrl = cat.url.startsWith('http') ? cat.url : `${origin}${cat.url}`;
  }
  if (!testUrl && catalogPhase.navLinks.length > 0) {
    const candidate = catalogPhase.navLinks.find(p =>
      /\/(product-category|collections?|departments?|category|shop|firearms)\b/i.test(p)
    );
    if (candidate) testUrl = `${origin}${candidate}`;
  }

  const empty: PaginationPhase = {
    paginationPattern: conf(null, 'none'), perPage: conf(null, 'none'),
    page1Products: [], page2Products: [], zeroOverlap: conf(null, 'none'), paginationLinks: [],
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

  // If no page 2 link found, try common patterns
  if (!page2Url) {
    const candidates = [
      { pattern: 'query:page', url: testUrl + (testUrl.includes('?') ? '&page=2' : '?page=2') },
      { pattern: 'path:/page/{N}', url: testUrl.replace(/\/?$/, '/page/2/') },
    ];
    for (const c of candidates) {
      const r = await safeFetch(c.url);
      if (r && r.status === 200) {
        const c$ = cheerio.load(r.data);
        const p2 = extractFirstProducts(c$, c.url, 5);
        if (p2.length > 0 && page1Products.length > 0) {
          const overlap = p2.filter(u => page1Products.includes(u));
          if (overlap.length === 0) {
            detectedPattern = c.pattern;
            page2Url = c.url;
            break;
          }
        }
      }
    }
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

  return {
    paginationPattern: conf(detectedPattern, detectedPattern && zeroOverlap ? 'high' : detectedPattern ? 'medium' : 'none'),
    perPage: conf(page1Products.length > 0 ? page1Products.length : null, page1Products.length > 0 ? 'medium' : 'none'),
    page1Products: page1Products.slice(0, 5),
    page2Products: page2Products.slice(0, 5),
    zeroOverlap: conf(zeroOverlap, page2Products.length > 0 ? 'high' : 'none'),
    paginationLinks: paginationLinks.slice(0, 10),
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

  // SPA warning
  if (platform.renderingMode.value === 'spa-likely') {
    warnings.push('Site appears to be a SPA. Static HTML extraction may return 0 products. Use Playwright.');
  }

  // JS overlay warning
  if (platform.jsOverlay.value) {
    warnings.push(`JS overlay detected: ${platform.jsOverlay.value}. Sort/pagination may be hijacked (see Searchspring/Klevu lessons).`);
  }

  const phaseErrors = errors.map(e => e.phase);
  const overallConfidence = failed.length === 0 ? 'high' : failed.length <= 2 ? 'medium' : 'low';

  return { overallConfidence, completedPhases: completed, failedPhases: failed, warnings };
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
    };
  }

  // Phase 2: Platform
  let platformResult: PlatformPhase;
  try {
    platformResult = await probePlatform(canonical);
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
    sortResult = await probeSort(canonical, platformResult, catalogResult);
  } catch (e: any) {
    errors.push({ phase: 'sort', message: e.message, stack: e.stack?.slice(0, 500) });
    sortResult = {
      sortOptions: [],
      idJumpTest: {
        defaultFirstProduct: null, newestFirstProduct: null, counterControlFirstProduct: null,
        newestParam: null, counterControlParam: null, verdict: 'not-tested',
      },
    };
  }

  // Phase 6: Pagination
  let paginationResult: PaginationPhase;
  try {
    paginationResult = await probePagination(canonical, catalogResult, platformResult);
  } catch (e: any) {
    errors.push({ phase: 'pagination', message: e.message, stack: e.stack?.slice(0, 500) });
    paginationResult = {
      paginationPattern: conf(null, 'none'), perPage: conf(null, 'none'),
      page1Products: [], page2Products: [], zeroOverlap: conf(null, 'none'), paginationLinks: [],
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
