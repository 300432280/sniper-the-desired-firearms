/**
 * Site Profile Validator — pure function that checks a siteProfile JSON
 * for completeness before it enters the bootstrap phase.
 */
import { VALID_METHOD_NAMES } from './product-count-probe';

export const CURRENT_PROFILE_VERSION = 1;

const VALID_ADAPTER_TYPES = [
  'woocommerce', 'shopify', 'generic-retail',
  'classifieds-gunpost', 'forum-xenforo', 'forum-vbulletin',
  'auction-hibid', 'auction-icollector', 'auction-generic', 'generic',
] as const;

const VALID_PAGINATION_TYPES = [
  'query', 'path', 'offset-query', 'suffix-replace', 'api-offset', 'api-page', null,
] as const;

const VALID_WATERMARK_METHODS = [
  'navigate-from-watermark', 'api-date-since-watermark', 'full-catalog-sweep',
] as const;

export interface ValidationFailure {
  field: string;
  check: string;
  message: string;
  severity: 'required' | 'recommended';
}

export interface ValidationResult {
  valid: boolean;
  score: number;
  passed: string[];
  failed: ValidationFailure[];
  warnings: string[];
}

type Check = {
  name: string;
  severity: 'required' | 'recommended';
  run: (p: any) => string | null; // null = pass, string = failure message
};

const checks: Check[] = [
  // ── Required ──
  {
    name: 'platform',
    severity: 'required',
    run: (p) => (typeof p.platform === 'string' && p.platform.length > 0)
      ? null : 'platform must be a non-empty string identifying the site platform',
  },
  {
    name: 'hasWaf',
    severity: 'required',
    run: (p) => (typeof p.hasWaf === 'boolean')
      ? null : 'hasWaf must be explicitly set to true or false',
  },
  {
    name: 'expectedProductCount',
    severity: 'required',
    run: (p) => (typeof p.expectedProductCount === 'number' && p.expectedProductCount > 0)
      ? null : 'expectedProductCount must be a positive number',
  },
  {
    name: 'catalogUrls',
    severity: 'required',
    run: (p) => (Array.isArray(p.catalogUrls) && p.catalogUrls.length > 0)
      ? null : 'catalogUrls must be a non-empty array of category/listing URLs',
  },
  {
    name: 'paginationPattern',
    severity: 'required',
    run: (p) => {
      if (!p.paginationPattern) return 'paginationPattern must be present (use type: null for single-page sites)';
      const validTypes = VALID_PAGINATION_TYPES as readonly (string | null)[];
      if (!validTypes.includes(p.paginationPattern.type))
        return `paginationPattern.type must be one of: ${VALID_PAGINATION_TYPES.join(', ')}`;
      return null;
    },
  },
  {
    name: 'perPage',
    severity: 'required',
    run: (p) => {
      // null is acceptable for API-only sites
      if (p.perPage === null) return null;
      return (typeof p.perPage === 'number' && p.perPage > 0)
        ? null : 'perPage must be a positive number (or null for API-only sites)';
    },
  },
  {
    // Optional per-site flag (generic-retail HTML extraction). When true, a catalog
    // card with NO stock signal (isInStock()===undefined) maps to 'unknown' instead
    // of the default 'out_of_stock'. For sites whose listing cards never expose stock
    // (e.g. gobles.ca lightspeed-ecom, northprosports.com opencart). Absent = false =
    // historical no-buy-signal=OOS behavior. Consumed by generic-retail.ts
    // extractCatalogProducts via catalog-crawler.ts / watermark-crawler.ts.
    name: 'listingOmitsStock',
    severity: 'recommended',
    run: (p) => (p.listingOmitsStock === undefined || typeof p.listingOmitsStock === 'boolean')
      ? null : 'listingOmitsStock must be a boolean true/false — a string "true" or number 1 is silently treated as false at runtime (strict === true).',
  },
  {
    name: 'adapterType',
    severity: 'required',
    run: (p) => (VALID_ADAPTER_TYPES as readonly string[]).includes(p.adapterType || p.adapter)
      ? null : `adapterType (or adapter) must be one of: ${VALID_ADAPTER_TYPES.join(', ')}`,
  },
  {
    name: 'crawlers.watermark.method',
    severity: 'required',
    run: (p) => {
      const method = p.crawlers?.watermark?.method;
      return (VALID_WATERMARK_METHODS as readonly string[]).includes(method)
        ? null : `crawlers.watermark.method must be one of: ${VALID_WATERMARK_METHODS.join(', ')}`;
    },
  },
  {
    name: 'sortVerification',
    severity: 'required',
    run: (p) => {
      const method = p.crawlers?.watermark?.method;
      if (method === 'full-catalog-sweep') {
        return p.crawlers?.watermark?.reason
          ? null : 'full-catalog-sweep requires a reason explaining why sort-based crawling is not viable';
      }
      // api-date-since-watermark is date-driven (filters by modified_after); it never reads
      // sortParam, so requiring a verified sort is a false-negative (2026-06-02 audit: blocked
      // marstar/alflahertys-class WC sites in the promotion gate). Only navigate-from-watermark
      // genuinely needs a verified newest-first sort (it paginates page-1-newest-first).
      if (method === 'api-date-since-watermark') return null;
      if (p.sortVerified === true || p.sortParam) return null;
      return 'sortVerified must be true or sortParam must be set (unless using full-catalog-sweep with reason, or api-date-since-watermark which is date-driven)';
    },
  },
  // ── C5 (2026-05-21): productCountMethod.method must be in the canonical
  //   allowlist when productCountMethod is present. Absence is still tolerated
  //   here and surfaced by the existing recommended-severity `productCountMethod`
  //   check below. The intent is to catch drift cases like `category-walk-dedupe`
  //   (wolverine) that pass validateSiteProfile but throw silently at runtime
  //   inside `validateMethod` (product-count-probe.ts:132) and disable the
  //   coverage gate by returning a null expectedCount that
  //   `verifyBootstrapCoverage` treats as acceptable.
  {
    name: 'productCountMethod.method',
    severity: 'required',
    run: (p) => {
      if (!p.productCountMethod) return null; // absence handled by recommended check
      const name = p.productCountMethod.method;
      if (typeof name !== 'string' || name.length === 0) {
        return 'productCountMethod.method must be a non-empty string';
      }
      if (!(VALID_METHOD_NAMES as readonly string[]).includes(name)) {
        return `productCountMethod.method "${name}" is not one of the canonical names: ${VALID_METHOD_NAMES.join(', ')}`;
      }
      return null;
    },
  },
  // ── C7 (2026-05-25, batch-5 R3 frontierfirearms + adversarial-round-1
  //   2026-05-25): URL/endpoint fields that the runtime concatenates with
  //   `${origin}` MUST be path-only with a leading slash. Otherwise the fetch
  //   becomes `${origin}${absoluteUrl}` -> double-prefix -> silent null ->
  //   coverage gate disabled.
  //   Methods covered:
  //     - sitemap / generic-product-sitemap: `m.url`           (product-count-probe.ts:292, 317)
  //     - sitemap-index:                      `m.urls[]`       (product-count-probe.ts:302)
  //     - wp-rest-header:                     `m.endpoint`     (product-count-probe.ts:249)
  //     - json-api-count:                     `m.endpoint`     (product-count-probe.ts:256)
  //     - json-api-length:                    `m.endpoint`     (product-count-probe.ts:268)
  //     - html-pagination:                    `m.url` (opt)    (product-count-probe.ts:282)
  //     - shopify-products-walk:              `m.endpoint`(opt)(product-count-probe.ts:362,369)
  //   Methods INTENTIONALLY excluded (use full absolute URL by design):
  //     - ecwid-storefront-search:            `m.endpoint`     (product-count-probe.ts:345, posted directly)
  //     - klevu-api-count:                    `m.endpoint`     (per-platform absolute)
  //     - stream-page-count:                  no URL
  {
    name: 'productCountMethod.urlShape',
    severity: 'required',
    run: (p) => {
      const m = p.productCountMethod;
      if (!m || typeof m !== 'object') return null;
      const isPathOnly = (u: unknown): u is string =>
        typeof u === 'string' && u.length > 0 && u.startsWith('/') && !u.startsWith('//');
      const failUrl = (field: string, value: unknown) =>
        `productCountMethod.${field} must be path-only with a leading slash (got ${JSON.stringify(value)}); the runtime probe prepends \${origin} and absolute URLs produce a double-prefix fetch.`;
      switch (m.method) {
        case 'sitemap':
        case 'generic-product-sitemap':
          if (!isPathOnly(m.url)) return failUrl('url', m.url);
          return null;
        case 'sitemap-index':
          if (!Array.isArray(m.urls) || m.urls.length === 0) {
            return 'productCountMethod.urls must be a non-empty array for method=sitemap-index';
          }
          for (const u of m.urls) {
            if (!isPathOnly(u)) return failUrl('urls[]', u);
          }
          return null;
        case 'wp-rest-header':
        case 'json-api-count':
        case 'json-api-length':
          if (!isPathOnly(m.endpoint)) return failUrl('endpoint', m.endpoint);
          return null;
        case 'html-pagination':
          // m.url is optional for html-pagination (probe falls back to origin)
          if (m.url !== undefined && m.url !== null && !isPathOnly(m.url)) {
            return failUrl('url', m.url);
          }
          return null;
        case 'shopify-products-walk':
          // m.endpoint is optional; defaults to '/products.json'
          if (m.endpoint !== undefined && m.endpoint !== null && !isPathOnly(m.endpoint)) {
            return failUrl('endpoint', m.endpoint);
          }
          return null;
        // Mirror image: methods that POST/GET the endpoint AS-IS (no origin
        // concat) require an ABSOLUTE URL. A path-only endpoint would make
        // axios throw "URL is not valid", get caught by the outer try/catch
        // in product-count-probe.ts:454-462, and silently return null --
        // disabling the coverage gate. Verified against:
        //   - ecwid-storefront-search: product-count-probe.ts:345 axios.post(m.endpoint, ...)
        //   - klevu-api-count:         product-count-probe.ts:401 (per-platform absolute)
        case 'ecwid-storefront-search':
        case 'klevu-api-count': {
          const ep = m.endpoint;
          if (typeof ep !== 'string' || ep.length === 0 ||
              !(ep.startsWith('http://') || ep.startsWith('https://'))) {
            return `productCountMethod.endpoint must be an absolute URL (got ${JSON.stringify(ep)}); ${m.method} posts the endpoint directly without origin concatenation, so a path-only value throws at runtime and silently disables the coverage gate.`;
          }
          return null;
        }
        default:
          return null;
      }
    },
  },
  // ── C6 (2026-05-21): crawlers.maintain.verifyMethod is required. Missing or
  //   empty values cause `worker.ts:769-772` to log "MISSING verifyMethod" and
  //   early-return, making restock detection a no-op for the site (wolverine
  //   reproduced this live). Promote-time rejection is the right place — the
  //   verify worker has no recovery path.
  {
    name: 'crawlers.maintain.verifyMethod',
    severity: 'required',
    run: (p) => {
      const m = p.crawlers?.maintain?.verifyMethod;
      return (typeof m === 'string' && m.length > 0)
        ? null
        : 'crawlers.maintain.verifyMethod must be a non-empty string (e.g. "store-api", "detail-page")';
    },
  },
  // ── Batch-5 R4 C3 (2026-05-22): hasWaf:true + -passive wafType is invalid.
  //   "Passive" wafTypes (cloudflare-passive, sucuri-passive, sgcaptcha-passive)
  //   mean WAF tooling is present but does not interfere with crawls. Pairing
  //   hasWaf:true with a -passive wafType activates defensive runtime behavior
  //   (perPage 50→20 throttle + forced Playwright + WAF cookie path) for a site
  //   that does not actually challenge the crawler. Confirmed on 6+ batch-5
  //   sites (aagcanada, durhamoutdoors, frontierfirearms, jobrookoutdoors, rdsc,
  //   store.prophetriver). Reject at promote time so this drift cannot land.
  {
    name: 'wafTypePassiveCoherence',
    severity: 'required',
    run: (p) => {
      if (p.hasWaf !== true) return null;
      const t = p.wafType;
      if (typeof t === 'string' && /-passive$/.test(t)) {
        return `hasWaf:true paired with wafType ending in "-passive" ("${t}") is invalid — ` +
          `either flip hasWaf to false (site does not actively challenge crawls) ` +
          `or change wafType to a non-passive variant.`;
      }
      return null;
    },
  },

  // ── C8 (2026-05-25, adv-round-3 tommyenterprises.com catch): for path-style
  //   pagination, `paginationPattern.template` MUST NOT start with any
  //   catalogUrl's pathname. The runtime URL builder at
  //   catalog-crawler.ts:118-125 strips the catalogUrl's trailing slash and
  //   concatenates the template raw:
  //     `${baseUrl.replace(/\/$/, '')}${template.replace('{N}', N)}`
  //   So catalogUrl=/shop/ + template=/shop/page/{N}/ produces
  //   /shop/shop/page/2/ -- a 404 in practice. Other WC profiles correctly
  //   use template=/page/{N}/ regardless of catalogUrl. This check rejects
  //   the duplicate-segment shape at promote time.
  {
    name: 'paginationPattern.templateRedundantCatalogPrefix',
    severity: 'required',
    run: (p) => {
      const pat = p.paginationPattern;
      if (!pat || pat.type !== 'path') return null;
      const tpl: unknown = pat.template;
      if (typeof tpl !== 'string' || tpl.length === 0) return null;
      const urls: unknown = p.catalogUrls;
      if (!Array.isArray(urls)) return null;
      for (const cu of urls) {
        if (typeof cu !== 'string' || cu.length === 0) continue;
        let cuPath: string;
        try {
          cuPath = new URL(cu, 'https://example.com').pathname;
        } catch {
          continue;
        }
        // Skip root-only catalogUrls -- every path template starts with '/'
        // and the runtime concat correctly produces /page/{N}/ for them.
        if (cuPath === '/' || cuPath === '') continue;
        const stripped = cuPath.endsWith('/') ? cuPath.slice(0, -1) : cuPath;
        if (tpl === stripped || tpl.startsWith(stripped + '/')) {
          return `paginationPattern.template "${tpl}" starts with the catalogUrl path "${stripped}/" -- the runtime URL builder at catalog-crawler.ts:118-125 will produce duplicate-segment URLs like "${stripped}${tpl}". Drop the catalog prefix from the template (e.g. use "/page/{N}/" not "${stripped}/page/{N}/").`;
        }
      }
      return null;
    },
  },

  // ── Recommended ──
  {
    name: 'wafType',
    severity: 'recommended',
    run: (p) => (p.hasWaf === true && !p.wafType)
      ? 'wafType should be set when hasWaf is true (e.g. cloudflare, sucuri, malcare)' : null,
  },
  {
    name: 'wafLastProbedAt',
    severity: 'recommended',
    run: (p) => {
      if (!p.wafLastProbedAt) return 'wafLastProbedAt should be set to track when WAF was last tested';
      const age = Date.now() - new Date(p.wafLastProbedAt).getTime();
      if (age > 90 * 24 * 60 * 60 * 1000)
        return 'wafLastProbedAt is over 90 days old — re-probe recommended';
      return null;
    },
  },
  {
    name: 'productCountMethod',
    severity: 'recommended',
    run: (p) => (!p.productCountMethod)
      ? 'productCountMethod should describe how expectedProductCount was obtained' : null,
  },
  // ── Batch-5 R4 C4 (2026-05-22): productCountMethod endpoint surface should
  //   match crawlers.maintain.verifyMethod. SKILL.md B8 pair-rule: when
  //   verifyMethod is 'store-api', count probing should also hit the Store API
  //   surface (/wp-json/wc/store/v1/...) — NOT the WP REST surface
  //   (/wp-json/wp/v2/...). Mismatched surfaces mean restock detection and
  //   count verification read different sources and can diverge. Recommended,
  //   not required — operators may have a reason. Detect-only; do not block.
  {
    name: 'productCountMethod.endpointPairsVerifyMethod',
    severity: 'recommended',
    run: (p) => {
      const endpoint = p.productCountMethod?.endpoint;
      const verifyMethod = p.crawlers?.maintain?.verifyMethod;
      if (typeof endpoint !== 'string' || endpoint.length === 0) return null; // sitemap shapes have no endpoint
      if (verifyMethod !== 'store-api') return null; // only flag the store-api pairing today
      // verifyMethod=store-api expects /wp-json/wc/store/v1/... — flag /wp-json/wp/v2/...
      if (/\/wp-json\/wp\/v2\//.test(endpoint)) {
        return `productCountMethod.endpointPairsVerifyMethod: verifyMethod="store-api" but ` +
          `productCountMethod.endpoint="${endpoint}" is a WP REST surface (/wp-json/wp/v2/...). ` +
          `Expected a Store API surface (/wp-json/wc/store/v1/products) — see SKILL.md B8 pair-rule.`;
      }
      return null;
    },
  },
  {
    name: 'lastVerified',
    severity: 'recommended',
    run: (p) => {
      if (!p.lastVerified) return 'lastVerified should record when the profile was last manually checked';
      const age = Date.now() - new Date(p.lastVerified).getTime();
      if (age > 30 * 24 * 60 * 60 * 1000)
        return 'lastVerified is over 30 days old — re-verification recommended';
      return null;
    },
  },
  {
    name: 'profileVersion',
    severity: 'recommended',
    run: (p) => (p.profileVersion !== CURRENT_PROFILE_VERSION)
      ? `profileVersion should be ${CURRENT_PROFILE_VERSION} (current schema version)` : null,
  },
  {
    name: 'sortParam',
    severity: 'recommended',
    run: (p) => {
      const method = p.crawlers?.watermark?.method;
      if (method === 'navigate-from-watermark' && !p.sortParam)
        return 'sortParam should be set when watermark method is navigate-from-watermark';
      return null;
    },
  },
  {
    name: 'extractionTested',
    severity: 'recommended',
    run: (p) => {
      if (!Array.isArray(p.catalogUrls)) return null; // caught by required check
      const anyTested = p.catalogUrls.some((_: unknown, i: number) =>
        p.extractionTested?.[i] === true || p.extractionTested === true
      );
      if (!anyTested) return 'at least one catalogUrl should have been extraction-tested';
      return null;
    },
  },
];

export function validateSiteProfile(profile: any): ValidationResult {
  const passed: string[] = [];
  const failed: ValidationFailure[] = [];
  const warnings: string[] = [];

  for (const check of checks) {
    const message = check.run(profile);
    if (message === null) {
      passed.push(check.name);
    } else if (check.severity === 'required') {
      failed.push({ field: check.name, check: check.name, message, severity: 'required' });
    } else {
      warnings.push(`${check.name}: ${message}`);
      // Recommended checks that fail still count in the score denominator
      failed.push({ field: check.name, check: check.name, message, severity: 'recommended' });
    }
  }

  const total = checks.length;
  const score = Math.round((passed.length / total) * 100);
  const valid = failed.filter(f => f.severity === 'required').length === 0;

  return { valid, score, passed, failed, warnings };
}
