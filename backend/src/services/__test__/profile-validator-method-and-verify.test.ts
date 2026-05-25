// backend/src/services/__test__/profile-validator-method-and-verify.test.ts
//
// C5 + C6: profile-validator must reject two more drift cases at promote time.
//
// C5 — productCountMethod.method ∈ VALID_METHOD_NAMES.
//   Current state: an unknown method (typo, renamed method, stale audit doc) gets
//   past the validator. At runtime `validateMethod` (product-count-probe.ts:132)
//   throws; both call sites catch silently and return null; `verifyBootstrapCoverage`
//   then treats null expectedCount as "acceptable" and disables the coverage gate.
//   Promote-time rejection short-circuits the silent-failure cascade.
//
// C6 — crawlers.maintain.verifyMethod is required and non-empty.
//   Current state: an empty/missing field reaches the verify worker; the worker's
//   else branch at `worker.ts:769-772` logs MISSING and early-returns. Restock
//   detection is then a no-op for the site (wolverine demonstrated this live).
//
// Both checks use the existing severity='required' channel so the existing
// audit-review-pipeline `validation.failed.filter(severity==='required')` block
// fires without any new error class.
import { describe, it, expect } from 'vitest';
import { validateSiteProfile } from '../profile-validator';
import { VALID_METHOD_NAMES } from '../product-count-probe';

// Minimum profile that passes ALL existing required checks. We mutate one field
// per test to isolate the new checks under test.
function baseProfile(): any {
  return {
    platform: 'woocommerce',
    hasWaf: false,
    expectedProductCount: 100,
    catalogUrls: ['/shop/'],
    paginationPattern: { type: 'query', template: '?page={N}' },
    perPage: 24,
    adapterType: 'woocommerce',
    sortParam: '?orderby=date',
    crawlers: {
      watermark: { method: 'api-date-since-watermark' },
      maintain: { verifyMethod: 'store-api' },
    },
    productCountMethod: { method: 'sitemap', url: '/sitemap_products.xml' },
  };
}

describe('validateSiteProfile — productCountMethod.method allowlist (C5)', () => {
  it('rejects a non-canonical productCountMethod.method name', () => {
    const p = baseProfile();
    p.productCountMethod = { method: 'category-walk-dedupe' };
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    const failure = r.failed.find(f => f.field === 'productCountMethod.method');
    expect(failure).toBeDefined();
    expect(failure?.severity).toBe('required');
    expect(failure?.message).toMatch(/category-walk-dedupe/);
  });

  it('accepts any of the 11 canonical method names', () => {
    for (const name of VALID_METHOD_NAMES) {
      const p = baseProfile();
      p.productCountMethod = { method: name };
      const r = validateSiteProfile(p);
      const failure = r.failed.find(f =>
        f.field === 'productCountMethod.method' && f.severity === 'required'
      );
      expect(failure, `method=${name} should not trigger productCountMethod.method failure`).toBeUndefined();
    }
  });

  it('does not fail this new check when productCountMethod is absent (it stays a recommended-only warning)', () => {
    const p = baseProfile();
    delete p.productCountMethod;
    const r = validateSiteProfile(p);
    // Absence is already covered by the existing recommended-severity check.
    // The new required-severity check should NOT add a second failure on absence.
    const requiredFailure = r.failed.find(f =>
      f.field === 'productCountMethod.method' && f.severity === 'required'
    );
    expect(requiredFailure).toBeUndefined();
  });
});

describe('validateSiteProfile — crawlers.maintain.verifyMethod required (C6)', () => {
  it('rejects a profile missing crawlers.maintain.verifyMethod', () => {
    const p = baseProfile();
    delete p.crawlers.maintain;
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    const failure = r.failed.find(f => f.field === 'crawlers.maintain.verifyMethod');
    expect(failure).toBeDefined();
    expect(failure?.severity).toBe('required');
  });

  it('rejects an empty-string verifyMethod', () => {
    const p = baseProfile();
    p.crawlers.maintain.verifyMethod = '';
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    const failure = r.failed.find(f => f.field === 'crawlers.maintain.verifyMethod');
    expect(failure).toBeDefined();
  });

  it('accepts a non-empty verifyMethod string', () => {
    const p = baseProfile();
    p.crawlers.maintain.verifyMethod = 'detail-page';
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f =>
      f.field === 'crawlers.maintain.verifyMethod' && f.severity === 'required'
    );
    expect(failure).toBeUndefined();
  });
});

// ── Batch-5 R4 C3: hasWaf:true + wafType ending in -passive is invalid ──────
//
// "Passive" suffixed wafTypes (cloudflare-passive, sucuri-passive, sgcaptcha-passive)
// mean the WAF tooling is present but does not interfere with crawls. Pairing
// hasWaf:true with a -passive wafType activates expensive defensive behavior at
// runtime (perPage 50→20 throttle + Playwright forced + WAF cookie path) for a
// site that does not actually challenge the crawler. This drift was confirmed
// on 6+ batch-5 sites. Reject the pairing at promote time so it cannot land.
describe('validateSiteProfile — hasWaf+wafType passive coherence (C3, batch-5 R4)', () => {
  it('rejects hasWaf:true + wafType:cloudflare-passive', () => {
    const p = baseProfile();
    p.hasWaf = true;
    p.wafType = 'cloudflare-passive';
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    const failure = r.failed.find(f => f.field === 'wafTypePassiveCoherence');
    expect(failure).toBeDefined();
    expect(failure?.severity).toBe('required');
    expect(failure?.message).toMatch(/passive/i);
  });

  it('rejects hasWaf:true + wafType:sucuri-passive', () => {
    const p = baseProfile();
    p.hasWaf = true;
    p.wafType = 'sucuri-passive';
    const r = validateSiteProfile(p);
    expect(r.valid).toBe(false);
    expect(r.failed.find(f => f.field === 'wafTypePassiveCoherence')).toBeDefined();
  });

  it('passes when hasWaf flipped to false (paired with passive wafType)', () => {
    const p = baseProfile();
    p.hasWaf = false;
    p.wafType = 'cloudflare-passive';
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'wafTypePassiveCoherence');
    expect(failure).toBeUndefined();
  });

  it('passes when wafType is non-passive (e.g. cloudflare) with hasWaf:true', () => {
    const p = baseProfile();
    p.hasWaf = true;
    p.wafType = 'cloudflare';
    const r = validateSiteProfile(p);
    const failure = r.failed.find(f => f.field === 'wafTypePassiveCoherence');
    expect(failure).toBeUndefined();
  });
});

// ── Batch-5 R4 C4: productCountMethod surface should match verifyMethod ─────
//
// B8 pair-rule (SKILL.md convention): when verifyMethod is 'store-api', the
// productCountMethod endpoint should be a Store API surface
// (/wp-json/wc/store/v1/...), NOT a WP REST surface (/wp-json/wp/v2/...).
// Mismatched surfaces means a worker reads one source for restock detection
// and a different source for count verification — the two can diverge. This
// is a soft check (recommended, not required) — operators may have a reason.
describe('validateSiteProfile — productCountMethod surface pair-rule (C4, batch-5 R4)', () => {
  it('warns when verifyMethod=store-api but productCountMethod endpoint is /wp-json/wp/v2/...', () => {
    const p = baseProfile();
    p.crawlers.maintain.verifyMethod = 'store-api';
    p.productCountMethod = {
      method: 'wp-rest-header',
      endpoint: '/wp-json/wp/v2/product',
      header: 'x-wp-total',
    };
    const r = validateSiteProfile(p);
    const warning = r.warnings.find(w => w.startsWith('productCountMethod.endpointPairsVerifyMethod'));
    expect(warning).toBeDefined();
    // Required checks still pass; this is recommended-only.
    expect(r.valid).toBe(true);
  });

  it('does not warn when surfaces agree (verifyMethod=store-api + Store API endpoint)', () => {
    const p = baseProfile();
    p.crawlers.maintain.verifyMethod = 'store-api';
    p.productCountMethod = {
      method: 'wp-rest-header',
      endpoint: '/wp-json/wc/store/v1/products',
      header: 'x-wp-total',
    };
    const r = validateSiteProfile(p);
    const warning = r.warnings.find(w => w.startsWith('productCountMethod.endpointPairsVerifyMethod'));
    expect(warning).toBeUndefined();
  });

  it('does not warn when productCountMethod has no endpoint (e.g. sitemap)', () => {
    const p = baseProfile();
    p.crawlers.maintain.verifyMethod = 'store-api';
    // sitemap method has `url`, no `endpoint` — pair-rule does not apply
    p.productCountMethod = { method: 'sitemap', url: '/sitemap_products.xml' };
    const r = validateSiteProfile(p);
    const warning = r.warnings.find(w => w.startsWith('productCountMethod.endpointPairsVerifyMethod'));
    expect(warning).toBeUndefined();
  });

  it('does not warn when verifyMethod is detail-page (surface-agnostic)', () => {
    const p = baseProfile();
    p.crawlers.maintain.verifyMethod = 'detail-page';
    p.productCountMethod = {
      method: 'wp-rest-header',
      endpoint: '/wp-json/wc/store/v1/products',
      header: 'x-wp-total',
    };
    const r = validateSiteProfile(p);
    const warning = r.warnings.find(w => w.startsWith('productCountMethod.endpointPairsVerifyMethod'));
    expect(warning).toBeUndefined();
  });
});
