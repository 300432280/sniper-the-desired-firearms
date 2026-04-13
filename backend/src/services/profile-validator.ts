/**
 * Site Profile Validator — pure function that checks a siteProfile JSON
 * for completeness before it enters the bootstrap phase.
 */

export const CURRENT_PROFILE_VERSION = 1;

const VALID_ADAPTER_TYPES = [
  'woocommerce', 'shopify', 'generic-retail',
  'classifieds-gunpost', 'forum-xenforo', 'forum-vbulletin',
  'auction-hibid', 'auction-icollector', 'auction-generic', 'generic',
] as const;

const VALID_PAGINATION_TYPES = [
  'query', 'path', 'offset-query', 'suffix-replace', 'api-offset', null,
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
    name: 'adapterType',
    severity: 'required',
    run: (p) => (VALID_ADAPTER_TYPES as readonly string[]).includes(p.adapterType)
      ? null : `adapterType must be one of: ${VALID_ADAPTER_TYPES.join(', ')}`,
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
      // For navigate-from-watermark and api-date-since-watermark, sort must be verified
      if (p.sortVerified === true || p.sortParam) return null;
      return 'sortVerified must be true or sortParam must be set (unless using full-catalog-sweep with reason)';
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
