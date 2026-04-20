/**
 * probe-platform.ts — Module 4 of the decomposed pre-bootstrap probe.
 *
 * Single responsibility: given a canonical origin (plus optional category URL
 * and recommended UA from probe-access), emit a structured evidence envelope
 * listing every matched platform marker, JS-overlay, and API endpoint
 * accessibility. Does NOT pick a single "platform" verdict — that's the
 * skill's job. Does NOT pick an adapter — that's Module 5. Does NOT probe
 * pagination, sort, or product counts — those are Modules 6/7/8.
 *
 * The key design principle (Mistake 22 / 31 / 28):
 *   Platforms COEXIST. bullseyenorth.com is Celerant + ColdFusion markers.
 *   triggersandbows.com is WordPress + Ecwid markers. Many BC Stencil sites
 *   also match generic WordPress markers if the merchant used a WP subdomain.
 *   The skill decides the FINAL pick from the full evidence list — this
 *   module's job is to NOT hide any signal.
 *
 * Pipeline:
 *   1. Fetch homepage (and optional category URL) via fetchForProbe with the
 *      caller-supplied UA.
 *   2. Scan HTML + headers + set-cookie for ALL known platform markers.
 *   3. Scan HTML for JS overlays (Searchspring, Klevu, FastSimon, Algolia,
 *      Constructor.io).
 *   4. Probe well-known API endpoints (WP REST, WC Store, Shopify JSON,
 *      BigCommerce GraphQL, Ecwid storefront, Magento REST) — status +
 *      2KB body + relevant headers (x-wp-total, etc.).
 *   5. Emit markers with strength rating + a topCandidates ranking.
 *
 * Salvage: derived from pre-bootstrap-probe.ts probePlatform (lines 1042-1420),
 * but output schema is a clean redesign — the monolith emitted a single
 * `platform` verdict plus a flat markers array. This module emits structured
 * evidence objects with strength ratings, keeping all signals orthogonal.
 *
 * CLI:
 *   npx tsx scripts/probe-modules/probe-platform.ts <canonical-origin>
 *     [--category-url <url>]
 *     [--ua desktop|iphone|custom:<string>]
 *     [--waf-suspected]
 *
 * Output: JSON to stdout. Progress to stderr.
 * Exit: 0 on module success (even if no markers found); 2 on bad args;
 *       1 on module crash.
 */

import axios from 'axios';
import * as http from 'node:http';
import * as https from 'node:https';
import { fetchForProbe, closePlaywrightIfUsed, UaMode, ProbeFetchResult } from './probe-fetch';

// ── Agents for Ecwid storefront POST (raised maxHeaderSize) ──────────────────
const BIG_HEADER_HTTP_AGENT = new http.Agent({ keepAlive: true, maxHeaderSize: 131072 } as any);
const BIG_HEADER_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxHeaderSize: 131072 } as any);

// ── Types ────────────────────────────────────────────────────────────────────

export type MarkerEvidence =
  | 'header'
  | 'html-script'
  | 'html-meta'
  | 'html-class'
  | 'cookie'
  | 'generator-meta'
  | 'url-pattern';

export type MarkerStrength = 'strong' | 'medium' | 'weak';

export interface PlatformMarker {
  marker: string;
  evidence: MarkerEvidence;
  snippet: string;
  strength: MarkerStrength;
}

export interface ApiProbeResult {
  url: string;
  status: number | null;
  xWpTotal: number | null;
  bodySample: string;
  errorMessage?: string;
}

export interface ShopifyProbeResult extends ApiProbeResult {
  count: number | null;
}

export interface EcwidProbeResult extends ApiProbeResult {
  /** Parsed from the JSON response before body truncation. */
  totalProductsCount: number | null;
}

export interface ProbePlatformResult {
  url: string;
  categoryUrl: string | null;
  markers: PlatformMarker[];
  generatorMeta: string | null;
  headerServer: string | null;
  headerPoweredBy: string | null;
  jsOverlayDetected: string[];
  apiEndpointsReachable: {
    wpJsonWcStore: ApiProbeResult | null;
    wpJsonWpV2: ApiProbeResult | null;
    shopifyProducts: ShopifyProbeResult | null;
    bcGraphQL: ApiProbeResult | null;
    ecwidStorefront: EcwidProbeResult | null;
    magentoRest: ApiProbeResult | null;
  };
  topCandidates: Array<{ platform: string; score: number }>;
  warnings: string[];
}

// ── Marker definitions ───────────────────────────────────────────────────────

/**
 * A marker check runs against the full fetch envelope (html + headers + raw
 * set-cookie) and returns a snippet on match or null on no-match.
 *
 * Keep these as pure functions — skill cross-references them and we want
 * deterministic, testable behavior. NO site-specific branching.
 */
interface MarkerCheck {
  name: string;
  strength: MarkerStrength;
  evidence: MarkerEvidence;
  check: (ctx: MarkerCheckContext) => string | null;
}

interface MarkerCheckContext {
  html: string;
  headers: Record<string, string>;
  setCookieRaw: string; // concatenated raw set-cookie headers
}

function extractSnippet(source: string, re: RegExp, cap = 200): string {
  const m = source.match(re);
  if (!m) return '';
  const idx = m.index ?? 0;
  const start = Math.max(0, idx - 20);
  const end = Math.min(source.length, idx + (m[0]?.length ?? 0) + 20);
  const raw = source.slice(start, end).replace(/\s+/g, ' ').trim();
  return raw.length > cap ? raw.slice(0, cap) : raw;
}

/**
 * Authoritative platform markers. Ordered by specificity within each family —
 * the scanner emits ALL matches, but `topCandidates` uses strength + position
 * to rank. Order here does NOT affect which markers are emitted; it affects
 * deterministic iteration order only.
 */
const MARKER_CHECKS: MarkerCheck[] = [
  // ── WooCommerce (strong) ──────────────────────────────────────────────────
  {
    name: 'woocommerce',
    strength: 'strong',
    evidence: 'html-script',
    check: (ctx) => {
      const re = /wp-content\/plugins\/woocommerce|wc-ajax=|woocommerce-Loop|class="woocommerce/i;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  {
    name: 'woocommerce',
    strength: 'medium',
    evidence: 'cookie',
    check: (ctx) => {
      const re = /wc_cart_hash_|woocommerce_items_in_cart|wp_woocommerce_session_/i;
      return re.test(ctx.setCookieRaw) ? extractSnippet(ctx.setCookieRaw, re, 120) : null;
    },
  },
  // ── Shopify (strong) ──────────────────────────────────────────────────────
  {
    name: 'shopify',
    strength: 'strong',
    evidence: 'html-script',
    check: (ctx) => {
      const re = /cdn\.shopify\.com|window\.Shopify|Shopify\.shop|\/cdn\/shop\//;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  // ── BigCommerce Stencil (strong) — Stencil OR cdn11 + BCData ──────────────
  {
    name: 'bigcommerce-stencil',
    strength: 'strong',
    evidence: 'html-script',
    check: (ctx) => {
      const hasStencil = /Stencil\.storefrontAPIToken|data-stencil-stylesheet/i.test(ctx.html);
      const hasBcCdnAndBcData =
        /cdn11\.bigcommerce\.com/i.test(ctx.html) && /BCData/i.test(ctx.html);
      if (hasStencil) {
        return extractSnippet(
          ctx.html,
          /Stencil\.storefrontAPIToken|data-stencil-stylesheet/i,
        );
      }
      if (hasBcCdnAndBcData) {
        return extractSnippet(ctx.html, /cdn11\.bigcommerce\.com/i);
      }
      return null;
    },
  },
  // ── BigCommerce Blueprint (medium) — BCData without stencil ───────────────
  {
    name: 'bigcommerce-blueprint',
    strength: 'medium',
    evidence: 'html-script',
    check: (ctx) => {
      if (!/BCData/.test(ctx.html)) return null;
      if (/Stencil\.storefrontAPIToken/i.test(ctx.html)) return null; // stencil wins
      return extractSnippet(ctx.html, /BCData/);
    },
  },
  // ── Magento 2 (strong) ────────────────────────────────────────────────────
  {
    name: 'magento-2.x',
    strength: 'strong',
    evidence: 'html-script',
    check: (ctx) => {
      const re = /static\/version\d|requirejs-config|Magento_(Catalog|Theme|Customer|Checkout)/i;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  // ── Magento 1.x (strong) ──────────────────────────────────────────────────
  {
    name: 'magento-1.x',
    strength: 'strong',
    evidence: 'html-script',
    check: (ctx) => {
      const re = /\/js\/varien\/|Mage\.Cookies|\/catalog\/product\/view\/id\//i;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  // ── OpenCart (strong) ─────────────────────────────────────────────────────
  {
    name: 'opencart',
    strength: 'strong',
    evidence: 'url-pattern',
    check: (ctx) => {
      const re = /catalog\/view\/theme|route=product\/category|route=product\/product/i;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  // ── LightSpeed eCom (strong) ──────────────────────────────────────────────
  {
    name: 'lightspeed-ecom',
    strength: 'strong',
    evidence: 'html-script',
    check: (ctx) => {
      if (/cdn\.shoplightspeed\.com/i.test(ctx.html)) {
        return extractSnippet(ctx.html, /cdn\.shoplightspeed\.com/i);
      }
      const gen = ctx.headers['server'] || ctx.headers['x-powered-by'] || '';
      if (/shoplightspeed/i.test(gen)) {
        return `server/x-powered-by: ${gen}`.slice(0, 200);
      }
      return null;
    },
  },
  // ── Ecwid (strong) ────────────────────────────────────────────────────────
  {
    name: 'ecwid',
    strength: 'strong',
    evidence: 'html-script',
    check: (ctx) => {
      const re = /app\.ecwid\.com\/script\.js|wp-content\/plugins\/ecwid-shopping-cart/i;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  {
    name: 'ecwid',
    strength: 'medium',
    evidence: 'html-class',
    check: (ctx) => {
      const re = /class="ec-store|ec-products-sort|data-ec-store/i;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  // ── Odoo (strong) ─────────────────────────────────────────────────────────
  {
    name: 'odoo',
    strength: 'strong',
    evidence: 'html-meta',
    check: (ctx) => {
      const re = /<meta\s+name="generator"\s+content="Odoo"|oe_website_sale|oe_currency_value/i;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  // ── Volusion (strong) — x-powered-by header ───────────────────────────────
  {
    name: 'volusion',
    strength: 'strong',
    evidence: 'header',
    check: (ctx) => {
      const poweredBy = ctx.headers['x-powered-by'] || '';
      if (/Volusion/i.test(poweredBy)) return `x-powered-by: ${poweredBy}`.slice(0, 200);
      if (/\/v\/vspfiles\//i.test(ctx.html)) return extractSnippet(ctx.html, /\/v\/vspfiles\//i);
      return null;
    },
  },
  // ── Wix (strong) — Pepyaka server OR wixBiSession ─────────────────────────
  {
    name: 'wix-stores',
    strength: 'strong',
    evidence: 'header',
    check: (ctx) => {
      const server = ctx.headers['server'] || '';
      if (/Pepyaka/i.test(server)) return `server: ${server}`.slice(0, 200);
      const re = /wixBiSession|thunderbolt|generatedBy="WIX"/i;
      if (re.test(ctx.html)) return extractSnippet(ctx.html, re);
      return null;
    },
  },
  // ── GoDaddy OLS / mysimplestore (strong) ──────────────────────────────────
  {
    name: 'godaddy-ols',
    strength: 'strong',
    evidence: 'html-script',
    check: (ctx) => {
      const re = /mysimplestore|data-aid="PRODUCT_LIST_RENDERED"/i;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  // ── ColdFusion (strong) — CFID / CFTOKEN cookies are unambiguous ──────────
  // ColdFusion CFID/CFTOKEN cookies are load-bearing Celerant markers; see
  // Mistake 36 (bullseyenorth.com — "server: Null" hides the vendor, cookies
  // are the only reliable signal).
  {
    name: 'coldfusion',
    strength: 'strong',
    evidence: 'cookie',
    check: (ctx) => {
      const hasCfid = /(?:^|;|\s)CFID=/im.test(ctx.setCookieRaw);
      const hasCftoken = /(?:^|;|\s)CFTOKEN=/im.test(ctx.setCookieRaw);
      if (hasCfid && hasCftoken) return 'set-cookie: CFID=...; CFTOKEN=...';
      if (hasCfid) return 'set-cookie: CFID=...';
      if (hasCftoken) return 'set-cookie: CFTOKEN=...';
      return null;
    },
  },
  {
    name: 'coldfusion',
    strength: 'medium',
    evidence: 'url-pattern',
    check: (ctx) => {
      if (/\.cfm\b/i.test(ctx.html)) return extractSnippet(ctx.html, /\.cfm\b/i);
      return null;
    },
  },
  // ── Celerant — vendor-specific ColdFusion ─────────────────────────────────
  // Celerant is THE dominant ColdFusion eCommerce vendor in the Canadian
  // firearms fleet. When we see Celerant markers we emit BOTH `coldfusion` AND
  // `celerant-coldfusion` — the skill decides which tag to store.
  {
    name: 'celerant-coldfusion',
    strength: 'strong',
    evidence: 'html-script',
    check: (ctx) => {
      const re = /celerantwebservices\.com|celerant\//i;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  // ── Drupal Commerce (strong) — x-commerce-core header ─────────────────────
  {
    name: 'drupal-commerce',
    strength: 'strong',
    evidence: 'header',
    check: (ctx) => {
      if (!ctx.headers['x-commerce-core']) return null;
      const gen = ctx.headers['x-generator'] || '';
      const hasDrupal =
        /^Drupal\b/i.test(gen) ||
        ctx.headers['x-drupal-cache-tags'] !== undefined ||
        ctx.headers['x-drupal-cache'] !== undefined;
      if (!hasDrupal) return null;
      return `x-commerce-core: ${ctx.headers['x-commerce-core']}, x-generator: ${gen}`.slice(0, 200);
    },
  },
  // ── Drupal (strong) — x-generator header OR drupal markers ────────────────
  {
    name: 'drupal',
    strength: 'strong',
    evidence: 'header',
    check: (ctx) => {
      const gen = ctx.headers['x-generator'] || '';
      if (/^Drupal\b/i.test(gen)) return `x-generator: ${gen}`.slice(0, 200);
      if (
        ctx.headers['x-drupal-cache'] !== undefined ||
        ctx.headers['x-drupal-dynamic-cache'] !== undefined ||
        ctx.headers['x-drupal-cache-tags'] !== undefined
      ) {
        const header = ctx.headers['x-drupal-cache']
          ? 'x-drupal-cache'
          : ctx.headers['x-drupal-dynamic-cache']
            ? 'x-drupal-dynamic-cache'
            : 'x-drupal-cache-tags';
        return `header: ${header}`.slice(0, 200);
      }
      return null;
    },
  },
  {
    name: 'drupal',
    strength: 'medium',
    evidence: 'html-script',
    check: (ctx) => {
      const re = /Drupal\.settings|drupalSettings|data-drupal-selector|\/sites\/default\/files\//;
      return re.test(ctx.html) ? extractSnippet(ctx.html, re) : null;
    },
  },
  // ── ASP.NET / IIS (medium) ────────────────────────────────────────────────
  {
    name: 'aspnet',
    strength: 'medium',
    evidence: 'html-script',
    check: (ctx) => {
      if (/__VIEWSTATE|__EVENTVALIDATION/i.test(ctx.html))
        return extractSnippet(ctx.html, /__VIEWSTATE|__EVENTVALIDATION/i);
      if (/asp\.net/i.test(ctx.headers['x-powered-by'] || ''))
        return `x-powered-by: ${ctx.headers['x-powered-by']}`.slice(0, 200);
      if (/ASP\.NET_SessionId=/i.test(ctx.setCookieRaw))
        return 'set-cookie: ASP.NET_SessionId=...';
      return null;
    },
  },
  // ── nopCommerce (medium) ──────────────────────────────────────────────────
  {
    name: 'nopcommerce',
    strength: 'medium',
    evidence: 'cookie',
    check: (ctx) => {
      if (/Nop\.customer/i.test(ctx.setCookieRaw)) return 'set-cookie: Nop.customer=...';
      if (/class="nop-/i.test(ctx.html)) return extractSnippet(ctx.html, /class="nop-/i);
      return null;
    },
  },
  // ── WordPress (weak — last because coexists with WooCommerce/Ecwid) ───────
  {
    name: 'wordpress',
    strength: 'weak',
    evidence: 'url-pattern',
    check: (ctx) => {
      const re = /wp-content\/(?!plugins\/woocommerce|plugins\/ecwid)/i;
      if (re.test(ctx.html)) return extractSnippet(ctx.html, re);
      if (/wp-content/i.test(ctx.html)) return extractSnippet(ctx.html, /wp-content/i);
      return null;
    },
  },
];

// ── JS overlay detectors ──────────────────────────────────────────────────────

interface OverlayCheck {
  name: string;
  re: RegExp;
}

const OVERLAY_CHECKS: OverlayCheck[] = [
  {
    name: 'searchspring',
    re: /cdn\.searchspring\.net\/search\/v3\/js\/searchspring\.catalog\.js|searchspring-/i,
  },
  { name: 'klevu', re: /klevu-\d{10,}|cdn\.klevu\.com/i },
  { name: 'fastsimon', re: /fastsimonsearch|fast-simon|fastsimon-widget/i },
  { name: 'algolia', re: /algoliasearch|cdn\.algolia\.com/i },
  { name: 'constructor-io', re: /constructor\.io|cnstrc/i },
];

// ── HTTP / API helpers ────────────────────────────────────────────────────────

const log = (msg: string) => process.stderr.write(msg + '\n');

function reassembleSetCookieHeaders(headers: Record<string, string>): string {
  // probe-fetch's normalizeHeaders joins multi-valued headers with ", ". For
  // set-cookie, this loses per-cookie boundaries. We still get most substrings
  // we care about (cookie names are unambiguous — CFID=, sucuri_cloudproxy_*,
  // etc.), so we return the concatenated string directly. Callers match on
  // cookie-name boundaries (e.g. /(?:^|;|\s)CFID=/) not on well-formed cookie
  // parsing.
  return headers['set-cookie'] || '';
}

async function probeWpRestApi(origin: string, ua: UaMode): Promise<ApiProbeResult> {
  const url = `${origin}/wp-json/wp/v2/product?per_page=1`;
  const r = await fetchForProbe(url, { ua, mode: 'static', accept: 'json', timeoutMs: 15_000 });
  const xWpTotal = r.headers?.['x-wp-total'];
  return {
    url,
    status: r.status,
    xWpTotal: xWpTotal && /^\d+$/.test(xWpTotal) ? parseInt(xWpTotal, 10) : null,
    bodySample: (r.bodySample || '').slice(0, 2048),
    errorMessage: r.errors.length ? r.errors[r.errors.length - 1].message : undefined,
  };
}

async function probeWcStoreApi(origin: string, ua: UaMode): Promise<ApiProbeResult> {
  const url = `${origin}/wp-json/wc/store/v1/products?per_page=1`;
  const r = await fetchForProbe(url, { ua, mode: 'static', accept: 'json', timeoutMs: 15_000 });
  const xWpTotal = r.headers?.['x-wp-total'];
  return {
    url,
    status: r.status,
    xWpTotal: xWpTotal && /^\d+$/.test(xWpTotal) ? parseInt(xWpTotal, 10) : null,
    bodySample: (r.bodySample || '').slice(0, 2048),
    errorMessage: r.errors.length ? r.errors[r.errors.length - 1].message : undefined,
  };
}

async function probeShopifyProducts(origin: string, ua: UaMode): Promise<ShopifyProbeResult> {
  const url = `${origin}/products.json?limit=1`;
  // fullBody: true — /products.json can return a minified response whose root
  // object brackets land beyond 8KB on sites with heavy per-product metadata.
  // We need a parseable JSON document, then we downsize for the output sample.
  const r = await fetchForProbe(url, {
    ua,
    mode: 'static',
    accept: 'json',
    timeoutMs: 15_000,
    fullBody: true,
  });
  let count: number | null = null;
  const rawBody = r.bodySample || '';
  if (r.status === 200 && rawBody) {
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && Array.isArray(parsed.products)) count = parsed.products.length;
    } catch {
      // Non-JSON body on 200 — WP sites sometimes redirect /products.json to a
      // 200 HTML catch-all. Keep count=null.
    }
  }
  return {
    url,
    status: r.status,
    xWpTotal: null,
    count,
    bodySample: rawBody.slice(0, 2048),
    errorMessage: r.errors.length ? r.errors[r.errors.length - 1].message : undefined,
  };
}

async function probeBcGraphQl(origin: string, ua: string): Promise<ApiProbeResult> {
  const url = `${origin}/graphql`;
  // BigCommerce /graphql is POST-only with a token; we just want to learn if
  // the endpoint EXISTS (i.e. returns 401/400 rather than 404). fetchForProbe
  // is GET-only, so use axios directly.
  try {
    const resp = await axios.post(
      url,
      { query: '' },
      {
        timeout: 10_000,
        maxRedirects: 0,
        validateStatus: () => true,
        headers: { 'User-Agent': ua, 'Content-Type': 'application/json' },
        httpAgent: BIG_HEADER_HTTP_AGENT,
        httpsAgent: BIG_HEADER_HTTPS_AGENT,
      },
    );
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    return {
      url,
      status: resp.status,
      xWpTotal: null,
      bodySample: body.slice(0, 2048),
    };
  } catch (e: any) {
    return {
      url,
      status: null,
      xWpTotal: null,
      bodySample: '',
      errorMessage: e?.message || String(e),
    };
  }
}

async function probeEcwidStorefront(
  origin: string,
  html: string,
  ua: string,
): Promise<EcwidProbeResult | null> {
  // Extract storeId from html — required to build the API URL. If missing,
  // we skip the probe entirely (return null, not an errored ApiProbeResult).
  const m = html.match(/app\.ecwid\.com\/script\.js\?(\d+)/);
  if (!m) return null;
  const storeId = m[1];
  const url = `https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/${storeId}/catalog/search`;
  try {
    const resp = await axios.post(
      url,
      { lang: 'en', pagination: { offset: 0, limit: 1 } },
      {
        timeout: 15_000,
        validateStatus: () => true,
        headers: {
          'User-Agent': ua,
          'Content-Type': 'application/json',
          Origin: origin,
          Referer: `${origin}/`,
        },
        httpAgent: BIG_HEADER_HTTP_AGENT,
        httpsAgent: BIG_HEADER_HTTPS_AGENT,
      },
    );
    // Parse totalProductsCount BEFORE truncating the body sample — this field
    // can live beyond 2KB in responses where the products array contains
    // verbose per-product metadata (triggersandbows.com truncates the field
    // at byte ~2000).
    const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    let totalProductsCount: number | null = null;
    try {
      const parsed = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
      if (parsed && typeof parsed.totalProductsCount === 'number') {
        totalProductsCount = parsed.totalProductsCount;
      }
    } catch {
      // ignore — response may not be JSON (e.g. 403/challenge body)
    }
    return {
      url: `${url} (storeId=${storeId})`,
      status: resp.status,
      xWpTotal: null,
      bodySample: raw.slice(0, 2048),
      totalProductsCount,
    };
  } catch (e: any) {
    return {
      url: `${url} (storeId=${storeId})`,
      status: null,
      xWpTotal: null,
      bodySample: '',
      totalProductsCount: null,
      errorMessage: e?.message || String(e),
    };
  }
}

async function probeMagentoRest(origin: string, ua: UaMode): Promise<ApiProbeResult> {
  const url = `${origin}/rest/V1/store/storeConfigs`;
  const r = await fetchForProbe(url, { ua, mode: 'static', accept: 'json', timeoutMs: 15_000 });
  return {
    url,
    status: r.status,
    xWpTotal: null,
    bodySample: (r.bodySample || '').slice(0, 2048),
    errorMessage: r.errors.length ? r.errors[r.errors.length - 1].message : undefined,
  };
}

// ── Main public API ──────────────────────────────────────────────────────────

export interface RunProbePlatformOpts {
  categoryUrl?: string;
  ua?: UaMode;
  wafSuspected?: boolean;
}

export async function runProbePlatform(
  canonicalOrigin: string,
  opts: RunProbePlatformOpts = {},
): Promise<ProbePlatformResult> {
  const ua: UaMode = opts.ua ?? 'desktop';
  const warnings: string[] = [];

  // ── Step 1: fetch homepage ─────────────────────────────────────────────────
  // fullBody: true — platform markers routinely live past the 8KB sample cap
  // (e.g. canadafirstammo.ca 465KB body has `wp-content/plugins/woocommerce`
  // beyond byte 8192). The marker scan is THIS module's responsibility, so we
  // need the whole document.
  log(`[probe-platform] fetching homepage: ${canonicalOrigin} (ua=${ua})`);
  const homepageR = await fetchForProbe(canonicalOrigin + '/', {
    ua,
    mode: 'auto',
    accept: 'html',
    timeoutMs: 20_000,
    wafSuspected: opts.wafSuspected,
    fullBody: true,
  });

  if (homepageR.status === null) {
    warnings.push(
      `homepage fetch failed: ${homepageR.errors.map((e) => e.message).join('; ').slice(0, 200)}`,
    );
  }

  // ── Step 2: optional category URL fetch (merge HTML into scan) ─────────────
  let categoryR: ProbeFetchResult | null = null;
  if (opts.categoryUrl) {
    log(`[probe-platform] fetching category URL: ${opts.categoryUrl}`);
    categoryR = await fetchForProbe(opts.categoryUrl, {
      ua,
      mode: 'auto',
      accept: 'html',
      timeoutMs: 20_000,
      wafSuspected: opts.wafSuspected,
      fullBody: true,
    });
    if (categoryR.status === null) {
      warnings.push(
        `category fetch failed: ${categoryR.errors.map((e) => e.message).join('; ').slice(0, 200)}`,
      );
    }
  }

  // Combined HTML for marker scanning. Headers use homepage only (category
  // headers can differ for cached/platform reasons but platform markers come
  // from the edge/origin stack which homepage reveals authoritatively).
  const homepageHtml = homepageR.bodySample || '';
  const categoryHtml = categoryR?.bodySample || '';
  const combinedHtml = categoryHtml ? `${homepageHtml}\n${categoryHtml}` : homepageHtml;
  const headers = homepageR.headers || {};
  const setCookieRaw = reassembleSetCookieHeaders(headers);

  // ── Step 3: marker scan ─────────────────────────────────────────────────────
  const markers: PlatformMarker[] = [];
  const emitted = new Set<string>(); // dedupe by (name:evidence:strength)
  const ctx: MarkerCheckContext = { html: combinedHtml, headers, setCookieRaw };
  for (const mc of MARKER_CHECKS) {
    const snippet = mc.check(ctx);
    if (snippet === null) continue;
    const key = `${mc.name}:${mc.evidence}:${mc.strength}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    markers.push({
      marker: mc.name,
      evidence: mc.evidence,
      snippet: snippet.length > 200 ? snippet.slice(0, 200) : snippet,
      strength: mc.strength,
    });
  }

  // Generator meta tag (stand-alone field — also emitted as a marker when useful)
  const genMatch = combinedHtml.match(
    /<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i,
  );
  const generatorMeta = genMatch ? genMatch[1].trim() : null;
  if (generatorMeta) {
    // Emit platform-diagnostic markers derived from generator meta when they
    // add info the main scan didn't capture.
    const low = generatorMeta.toLowerCase();
    if (/^wordpress\b/.test(low) && !emitted.has('wordpress:generator-meta:medium')) {
      markers.push({
        marker: 'wordpress',
        evidence: 'generator-meta',
        snippet: generatorMeta.slice(0, 200),
        strength: 'medium',
      });
      emitted.add('wordpress:generator-meta:medium');
    } else if (/^drupal\b/i.test(generatorMeta) && !emitted.has('drupal:generator-meta:strong')) {
      markers.push({
        marker: 'drupal',
        evidence: 'generator-meta',
        snippet: generatorMeta.slice(0, 200),
        strength: 'strong',
      });
      emitted.add('drupal:generator-meta:strong');
    } else if (/^shopify\b/i.test(generatorMeta) && !emitted.has('shopify:generator-meta:strong')) {
      markers.push({
        marker: 'shopify',
        evidence: 'generator-meta',
        snippet: generatorMeta.slice(0, 200),
        strength: 'strong',
      });
      emitted.add('shopify:generator-meta:strong');
    } else if (/^odoo\b/i.test(generatorMeta) && !emitted.has('odoo:generator-meta:strong')) {
      markers.push({
        marker: 'odoo',
        evidence: 'generator-meta',
        snippet: generatorMeta.slice(0, 200),
        strength: 'strong',
      });
      emitted.add('odoo:generator-meta:strong');
    }
  }

  // ── Step 4: JS overlay detection ────────────────────────────────────────────
  const jsOverlayDetected: string[] = [];
  for (const oc of OVERLAY_CHECKS) {
    if (oc.re.test(combinedHtml)) jsOverlayDetected.push(oc.name);
  }

  // ── Step 5: API endpoint probes ─────────────────────────────────────────────
  // Probe in parallel — they target different paths / different vendors, so no
  // coupling. Each produces its own error state if unreachable.
  // BC GraphQL + Ecwid storefront use raw axios.post (not GET), so they need
  // a resolved UA STRING rather than a UaMode — take it from the homepage
  // fetch's authoritative `ua` field.
  const uaString = homepageR.ua;

  log(`[probe-platform] probing API endpoints in parallel`);
  const [wpRestR, wcStoreR, shopifyR, bcGqlR, ecwidR, magentoR] = await Promise.all([
    probeWpRestApi(canonicalOrigin, ua),
    probeWcStoreApi(canonicalOrigin, ua),
    probeShopifyProducts(canonicalOrigin, ua),
    probeBcGraphQl(canonicalOrigin, uaString),
    probeEcwidStorefront(canonicalOrigin, combinedHtml, uaString),
    probeMagentoRest(canonicalOrigin, ua),
  ]);

  log(
    `  wp-rest=${wpRestR.status ?? 'err'} wc-store=${wcStoreR.status ?? 'err'} shopify=${shopifyR.status ?? 'err'} bc-gql=${bcGqlR.status ?? 'err'} ecwid=${ecwidR?.status ?? 'n/a'} magento=${magentoR.status ?? 'err'}`,
  );

  // ── Step 6: topCandidates ranking ──────────────────────────────────────────
  // Score = sum of (strength weight) per marker-name. Strong=3, medium=2, weak=1.
  // API probe hits add bonus points (wp-rest 200 +3, shopify 200 +3, etc.).
  // This is a GENERIC ranking — the skill still decides the final pick.
  const strengthWeight: Record<MarkerStrength, number> = { strong: 3, medium: 2, weak: 1 };
  const scores = new Map<string, number>();
  for (const m of markers) {
    scores.set(m.marker, (scores.get(m.marker) || 0) + strengthWeight[m.strength]);
  }
  // API bonus — only when API returned real content. x-wp-total populated is
  // authoritative for WooCommerce (the /wp-json/wc/store path specifically).
  if (wcStoreR.status === 200 && wcStoreR.xWpTotal !== null) {
    scores.set('woocommerce', (scores.get('woocommerce') || 0) + 3);
  }
  if (wpRestR.status === 200 && wpRestR.xWpTotal !== null && wpRestR.xWpTotal > 0) {
    // /wp-json/wp/v2/product returning WP v2 products → WordPress site.
    scores.set('wordpress', (scores.get('wordpress') || 0) + 2);
  }
  if (shopifyR.status === 200 && shopifyR.count !== null) {
    // /products.json returning real products → Shopify.
    scores.set('shopify', (scores.get('shopify') || 0) + 3);
  }
  if (ecwidR && ecwidR.status === 200 && ecwidR.totalProductsCount !== null) {
    scores.set('ecwid', (scores.get('ecwid') || 0) + 3);
  }
  if (magentoR.status === 200 && /store_config|storeConfigs/i.test(magentoR.bodySample)) {
    // Magento 2 REST reachable — boost magento-2.x if seen as a marker, else
    // add a generic 'magento' candidate so the skill still sees the signal.
    scores.set('magento-2.x', (scores.get('magento-2.x') || 0) + 3);
  }
  const topCandidates = Array.from(scores.entries())
    .map(([platform, score]) => ({ platform, score }))
    .sort((a, b) => b.score - a.score || a.platform.localeCompare(b.platform));

  return {
    url: canonicalOrigin,
    categoryUrl: opts.categoryUrl ?? null,
    markers,
    generatorMeta,
    headerServer: headers['server'] || null,
    headerPoweredBy: headers['x-powered-by'] || null,
    jsOverlayDetected,
    apiEndpointsReachable: {
      wpJsonWcStore: wcStoreR,
      wpJsonWpV2: wpRestR,
      shopifyProducts: shopifyR,
      bcGraphQL: bcGqlR,
      ecwidStorefront: ecwidR,
      magentoRest: magentoR,
    },
    topCandidates,
    warnings,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(
  argv: string[],
): { url: string; opts: RunProbePlatformOpts } | null {
  const positional: string[] = [];
  const opts: RunProbePlatformOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--category-url') {
      const v = argv[++i];
      if (!v) return null;
      opts.categoryUrl = v;
    } else if (a === '--ua') {
      const v = argv[++i];
      if (v === 'desktop' || v === 'iphone') opts.ua = v;
      else if (v?.startsWith('custom:')) opts.ua = v as UaMode;
      else return null;
    } else if (a === '--waf-suspected') {
      opts.wafSuspected = true;
    } else if (a.startsWith('--')) {
      return null;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) return null;
  return { url: positional[0], opts };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write(
      'usage: probe-platform.ts <canonical-origin> [--category-url <url>] [--ua desktop|iphone|custom:<string>] [--waf-suspected]\n',
    );
    return 2;
  }
  const result = await runProbePlatform(parsed.url, parsed.opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  await closePlaywrightIfUsed();
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`probe-platform crashed: ${e?.stack || e?.message || e}\n`);
      process.exit(1);
    });
}
