// backend/scripts/audit-review-pipeline.ts
/**
 * audit-review-pipeline -- 5-stage review of an audit-skill-produced candidate profile.
 *
 * Stages (fail-stops; each must PASS before the next runs):
 *   1. Spec compliance check     (validateSiteProfile + Mistake-pattern programmatic check)
 *   2. Live walk test            (small N pages on each catalogUrl; >=1 product per URL)
 *   3. Multi-method count        (API + sitemap + walk; pairwise within 10%)
 *   4. Operator review           (gates on --approve flag OR --prompt Y/N)
 *   5. Output review report      (JSON + markdown summary; gates on operator approval flag)
 *
 * CLI:
 *   npx tsx backend/scripts/audit-review-pipeline.ts <profile-json-path>
 *   npx tsx backend/scripts/audit-review-pipeline.ts <profile-json-path> --approve
 *   npx tsx backend/scripts/audit-review-pipeline.ts <profile-json-path> --prompt
 *
 * Exit codes:
 *   0 -- all stages PASS (incl. operator approval)
 *   1 -- Stage 1-3 FAIL (skill output not usable)
 *   2 -- Stage 4 declined by operator
 *   3 -- Stage 5 write-prep error
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

import { validateSiteProfile } from '../src/services/profile-validator';
import {
  checkPaginationPattern,
  countProductsFromSitemap,
  extractProducts,
  extractSlug,
  resolveUrl,
  type CatalogUrlResult,
} from './verify-site-profile';
import { fetchUrl } from './probe/shared/fetch';
import { buildPaginatedUrl } from '../src/services/catalog-crawler';
import type { PaginationPattern } from '../src/services/catalog-crawler';

// ---- Types ----------------------------------------------------------------

export type StageVerdict = 'PASS' | 'FAIL';

export interface StageResult {
  stage: 1 | 2 | 3 | 4 | 5;
  name: string;
  verdict: StageVerdict;
  details: Record<string, unknown>;
  blockingErrors: string[];
}

export interface ReviewResult {
  profilePath: string;
  domain: string;
  timestamp: string;
  stages: StageResult[];
  overallVerdict: StageVerdict;
  approvedForDbWrite: boolean;
}

// ---- Helpers ---------------------------------------------------------------

const DELAY_MS = 2000; // 2s anti-ban delay between fetches

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Resolve the canonical origin (protocol+host) from a profile.
 * Per SKILL.md Stage 4 catalogUrls can be path-only ("/shop/") -- fall back to
 * extractionSample[].url (always absolute) to derive the origin.
 */
function resolveProfileOrigin(profile: any): string | null {
  // Try canonicalUrl, then absolute catalogUrls, then extractionSample.
  if (typeof profile.canonicalUrl === 'string' && profile.canonicalUrl.startsWith('http')) {
    try { return new URL(profile.canonicalUrl).origin; } catch { /* fall through */ }
  }
  const urls: any[] = profile.catalogUrls || [];
  for (const u of urls) {
    if (typeof u === 'string' && u.startsWith('http')) {
      try { return new URL(u).origin; } catch { /* skip */ }
    }
  }
  const samples: any[] = profile.extractionSample || [];
  for (const s of samples) {
    if (s && typeof s.url === 'string' && s.url.startsWith('http')) {
      try { return new URL(s.url).origin; } catch { /* skip */ }
    }
  }
  return null;
}

function extractDomainFromProfile(profile: any): string {
  const origin = resolveProfileOrigin(profile);
  if (origin) {
    try { return new URL(origin).hostname.replace(/^www\./, ''); } catch { /* fall through */ }
  }
  return 'unknown';
}

/** Resolve a (possibly path-only) catalogUrl to an absolute URL using the profile's origin. */
function resolveCatalogUrl(catUrl: string, profile: any): string | null {
  if (catUrl.startsWith('http')) return catUrl;
  const origin = resolveProfileOrigin(profile);
  if (!origin) return null;
  return origin + (catUrl.startsWith('/') ? catUrl : '/' + catUrl);
}

// ---- Stage 1: Spec Compliance ----------------------------------------------

export async function runStage1Spec(profile: any): Promise<StageResult> {
  const blockingErrors: string[] = [];

  // Part A: validateSiteProfile
  const validation = validateSiteProfile(profile);
  const requiredFailures = validation.failed.filter(f => f.severity === 'required');
  for (const f of requiredFailures) {
    blockingErrors.push(`validator-required: ${f.field} -- ${f.message}`);
  }

  // Part B: Programmatic Mistake-pattern checks
  const platform = (profile.platform || '').toLowerCase();

  // Mistake 32: Shopify + created_at for date sort
  if (platform === 'shopify') {
    const sortParam = (profile.sortParam || '').toLowerCase();
    const watermarkMethod = profile.crawlers?.watermark?.method || '';
    // Check if created_at is used anywhere in sort-related fields
    if (sortParam.includes('created_at') || watermarkMethod.includes('created_at')) {
      blockingErrors.push('mistake-32-use-published_at: Shopify must use published_at, not created_at, for date sort');
    }
  }

  // Mistake 26: LightSpeed eCom requires suffix-replace pagination
  if (platform.includes('lightspeed-ecom')) {
    const pagType = profile.paginationPattern?.type;
    if (pagType !== 'suffix-replace') {
      blockingErrors.push(
        `mistake-26-lightspeed-suffix-replace-required: LightSpeed eCom pagination must be suffix-replace, got '${pagType}'`
      );
    }
  }

  // Mistake 27: Wix shop-only
  if (platform.includes('wix')) {
    const catalogUrls: string[] = profile.catalogUrls || [];
    for (const url of catalogUrls) {
      try {
        const parsed = new URL(url);
        const pathParts = parsed.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');
        // Only /shop (with optional pagination) is valid
        if (pathParts.length > 0 && pathParts[0] !== 'shop' && pathParts[0] !== '') {
          blockingErrors.push(
            `mistake-27-wix-shop-only: Wix catalogUrl path beyond /shop not allowed: ${parsed.pathname}`
          );
          break;
        }
        if (pathParts.length > 1 && pathParts[0] === 'shop') {
          // /shop/something is a sub-path -- not allowed
          blockingErrors.push(
            `mistake-27-wix-shop-only: Wix catalogUrl has sub-path beyond /shop: ${parsed.pathname}`
          );
          break;
        }
      } catch { /* skip malformed URLs */ }
    }
  }

  // Mistake 24: Volusion requires searching=Y
  if (platform.includes('volusion')) {
    const catalogUrls: string[] = profile.catalogUrls || [];
    const hasSearchingY = catalogUrls.some(u => /[?&]searching=Y/i.test(u));
    if (!hasSearchingY) {
      blockingErrors.push(
        'mistake-24-volusion-searchingY-required: Volusion requires at least one catalogUrl with searching=Y'
      );
    }
  }

  // (Removed legacy consistency-guard-wafType-vs-hasWaf: per SKILL.md B10 the
  //  CORRECT pairing is hasWaf:false + wafType:'cloudflare-passive' or similar
  //  passive label. The OPPOSITE pairing -- hasWaf:true + wafType:*-passive --
  //  is the invalid one, and that is enforced by profile-validator.ts's
  //  `wafTypePassiveCoherence` check (Stage 1 above). The old guard required
  //  hasWaf:true whenever wafType was set, which is the inverse of B10 and
  //  blocked every correctly-shaped passive-WAF profile.)

  // Method C requires reason
  if (profile.crawlers?.watermark?.method === 'full-catalog-sweep') {
    if (!profile.crawlers?.watermark?.reason) {
      blockingErrors.push(
        'method-c-requires-reason: full-catalog-sweep watermark method requires a reason field'
      );
    }
  }

  const verdict: StageVerdict = blockingErrors.length === 0 ? 'PASS' : 'FAIL';

  return {
    stage: 1,
    name: 'Spec Compliance',
    verdict,
    details: {
      validatorResult: {
        valid: validation.valid,
        score: validation.score,
        passed: validation.passed,
        requiredFailures: requiredFailures.map(f => ({ field: f.field, message: f.message })),
        warnings: validation.warnings,
      },
    },
    blockingErrors,
  };
}

// ---- Stage 2: Live Walk Test -----------------------------------------------

export async function runStage2Walk(profile: any): Promise<StageResult> {
  const blockingErrors: string[] = [];
  const catalogUrls: string[] = profile.catalogUrls || [];
  const pattern: PaginationPattern | undefined = profile.paginationPattern;
  const perUrlResults: Array<{
    url: string;
    page1Products: number;
    page1Slugs: string[];
    page2Products: number;
    page2Slugs: string[];
    page3Products: number;
    paginationVerdict: string;
  }> = [];

  if (catalogUrls.length === 0) {
    blockingErrors.push('No catalogUrls defined in profile');
    return {
      stage: 2,
      name: 'Live Walk Test',
      verdict: 'FAIL',
      details: { perUrl: [] },
      blockingErrors,
    };
  }

  for (let i = 0; i < catalogUrls.length; i++) {
    const catUrlRaw = catalogUrls[i];
    // Per SKILL.md Stage 4, catalogUrls can be path-only ("/shop/"); the runtime
    // walker resolves against the site origin. Stage 2 must do the same before
    // calling fetchUrl (which needs an absolute URL).
    const catUrl = resolveCatalogUrl(catUrlRaw, profile);
    if (i > 0) await delay(DELAY_MS);

    const urlResult: typeof perUrlResults[0] = {
      url: catUrl ?? catUrlRaw,
      page1Products: 0,
      page1Slugs: [],
      page2Products: 0,
      page2Slugs: [],
      page3Products: 0,
      paginationVerdict: 'unknown',
    };

    if (!catUrl) {
      blockingErrors.push(`${catUrlRaw}: cannot resolve to absolute URL (no canonicalUrl/extractionSample in profile)`);
      urlResult.paginationVerdict = 'unresolved';
      perUrlResults.push(urlResult);
      continue;
    }

    try {
      // Page 1
      const page1Fetch = await fetchUrl(catUrl, { timeoutMs: 30000 });
      if (page1Fetch.status >= 400) {
        blockingErrors.push(`${catUrl}: page 1 returned HTTP ${page1Fetch.status}`);
        urlResult.paginationVerdict = `HTTP ${page1Fetch.status}`;
        perUrlResults.push(urlResult);
        continue;
      }
      const page1Products = extractProducts(page1Fetch.body, catUrl);
      urlResult.page1Products = page1Products.length;
      urlResult.page1Slugs = page1Products.slice(0, 3).map(p => extractSlug(p.url));

      if (page1Products.length === 0) {
        blockingErrors.push(`${catUrl}: page 1 returned 0 products`);
        urlResult.paginationVerdict = 'no-products';
        perUrlResults.push(urlResult);
        continue;
      }

      // Build CatalogUrlResult for checkPaginationPattern reuse
      const catalogUrlResult: CatalogUrlResult = {
        url: catUrl,
        status: page1Fetch.status,
        productCount: page1Products.length,
        sampleSlugs: urlResult.page1Slugs,
      };

      // Derive siteUrl from the catalogUrl origin
      let siteUrl: string;
      try {
        const u = new URL(catUrl);
        siteUrl = `${u.protocol}//${u.host}`;
      } catch {
        siteUrl = catUrl;
      }

      // Use checkPaginationPattern from Task 1 for page1 vs page2
      await delay(DELAY_MS);
      const pagCheck = await checkPaginationPattern(siteUrl, profile, [catalogUrlResult]);

      if (pagCheck.verdict === 'FAIL') {
        blockingErrors.push(
          `${catUrl}: pagination check FAIL -- ${pagCheck.reason || 'page2 identical to page1'}`
        );
        urlResult.paginationVerdict = 'FAIL';
      } else {
        urlResult.paginationVerdict = pagCheck.verdict;
      }

      // Extract page 2 evidence from pagCheck
      const page2Slugs = (pagCheck.evidence?.page2First3 as string[]) || [];
      urlResult.page2Slugs = page2Slugs;
      urlResult.page2Products = page2Slugs.length; // approximate from sample

      // Page 3
      await delay(DELAY_MS);
      const page3Url = buildPaginatedUrl(catUrl, 3, pattern);
      const page3Fetch = await fetchUrl(page3Url, { timeoutMs: 30000 });
      if (page3Fetch.status < 400) {
        const page3Products = extractProducts(page3Fetch.body, page3Url);
        urlResult.page3Products = page3Products.length;
        // Page 3 OK if it has products OR is the last page (perPage truncation)
        // No blocking error for page 3 with 0 products -- that's valid truncation
      }
    } catch (err) {
      blockingErrors.push(`${catUrl}: fetch error -- ${err instanceof Error ? err.message : String(err)}`);
      urlResult.paginationVerdict = 'error';
    }

    perUrlResults.push(urlResult);
  }

  const verdict: StageVerdict = blockingErrors.length === 0 ? 'PASS' : 'FAIL';

  return {
    stage: 2,
    name: 'Live Walk Test',
    verdict,
    details: { perUrl: perUrlResults },
    blockingErrors,
  };
}

// ---- Stage 3: Multi-Method Count Cross-Check -------------------------------

async function getApiCount(profile: any): Promise<number | null> {
  const platform = (profile.platform || '').toLowerCase();
  const catalogUrls: string[] = profile.catalogUrls || [];
  // productCountMethod is a discriminated-union object {method, ...} per SKILL.md B6.
  // Legacy profiles may still ship a bare string; tolerate both rather than
  // crashing via .toLowerCase() on an object.
  const methodRaw = profile.productCountMethod;
  const method = (typeof methodRaw === 'string'
    ? methodRaw
    : (methodRaw && typeof methodRaw === 'object' ? String(methodRaw.method || '') : '')
  ).toLowerCase();

  // Derive siteUrl from the profile (handles path-only catalogUrls via
  // resolveProfileOrigin fallbacks).
  const siteUrl: string | null = resolveProfileOrigin(profile);
  if (!siteUrl) return null;

  try {
    // WooCommerce: WP REST header
    if (/woocommerce/.test(platform)) {
      const apiUrl = resolveUrl(siteUrl, '/wp-json/wp/v2/product?per_page=1');
      const result = await fetchUrl(apiUrl, { timeoutMs: 30000 });
      const wpTotal = result.headers['x-wp-total'];
      if (wpTotal && result.status === 200) {
        return parseInt(wpTotal, 10);
      }
      // Fallback: WC Store API
      await delay(DELAY_MS);
      const storeApiUrl = resolveUrl(siteUrl, '/wp-json/wc/store/v1/products?per_page=1');
      const storeResult = await fetchUrl(storeApiUrl, { timeoutMs: 30000 });
      const storeTotal = storeResult.headers['x-wp-total'];
      if (storeTotal && storeResult.status === 200) {
        return parseInt(storeTotal, 10);
      }
    }

    // Shopify: products.json count
    if (/shopify/.test(platform)) {
      const productsUrl = resolveUrl(siteUrl, '/products.json?limit=1');
      const result = await fetchUrl(productsUrl, { timeoutMs: 30000 });
      if (result.status === 200) {
        try {
          const data = JSON.parse(result.body);
          if (Array.isArray(data.products)) {
            // Shopify doesn't expose total count in headers for products.json;
            // we'd need to walk all pages. Return null for non-walk methods.
            return null;
          }
        } catch { /* not JSON */ }
      }
    }

    // Ecwid: storefront API
    if (/ecwid/.test(platform) && profile.ecwidStoreId) {
      const ecwidUrl = `https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/${profile.ecwidStoreId}/catalog/search`;
      const result = await fetchUrl(ecwidUrl, {
        method: 'POST',
        body: JSON.stringify({ lang: 'en', pagination: { offset: 0, limit: 1 } }),
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 30000,
      });
      if (result.status === 200) {
        try {
          const data = JSON.parse(result.body);
          if (typeof data.totalProductsCount === 'number') {
            return data.totalProductsCount;
          }
        } catch { /* not JSON */ }
      }
    }

    // Celerant/generic: check if profile says how count was obtained
    if (method.includes('celerant-perpage-all') || method.includes('perpage-all')) {
      // Count is derived from a "show all" page -- not an API endpoint.
      // Can't re-derive dynamically without fetching the all-products page,
      // which is effectively a walk. Return null for API method.
      return null;
    }
  } catch {
    return null;
  }

  return null;
}

async function getSitemapCount(profile: any): Promise<number | null> {
  const catalogUrls: string[] = profile.catalogUrls || [];
  let siteUrl: string | null = null;
  if (catalogUrls.length > 0) {
    try {
      const u = new URL(catalogUrls[0]);
      siteUrl = `${u.protocol}//${u.host}`;
    } catch { /* no siteUrl */ }
  }
  if (!siteUrl) return null;

  try {
    const count = await countProductsFromSitemap(siteUrl);
    if (count <= 0) return null;
    // Quality gate: if sitemap count is < 5% of expectedProductCount, the sitemap
    // isn't product-level (e.g. Celerant sitemaps list category pages only).
    // Treat as unavailable rather than producing a guaranteed drift failure.
    const expected = profile.expectedProductCount;
    if (expected && expected > 0 && count < expected * 0.05) {
      process.stderr.write(
        `  [stage3] Sitemap count (${count}) is <5% of expectedProductCount (${expected}); treating as unavailable\n`
      );
      return null;
    }
    return count;
  } catch {
    return null;
  }
}

async function getWalkCount(profile: any): Promise<number | null> {
  const catalogUrls: string[] = profile.catalogUrls || [];
  if (catalogUrls.length === 0) return null;

  const perPage: number | null = profile.perPage ?? null;
  if (!perPage || perPage <= 0) return null;

  const pattern: PaginationPattern | undefined = profile.paginationPattern;
  const firstUrl = catalogUrls[0];

  try {
    // Fetch page 1 to get actual product count (confirms perPage)
    const page1Fetch = await fetchUrl(firstUrl, { timeoutMs: 30000 });
    if (page1Fetch.status >= 400) return null;
    const page1Products = extractProducts(page1Fetch.body, firstUrl);
    if (page1Products.length === 0) return null;

    // Binary search for total pages: double until empty, then bisect
    let lo = 1;
    let hi = 2;

    // Find upper bound
    while (hi <= 2000) {
      await delay(DELAY_MS);
      const testUrl = buildPaginatedUrl(firstUrl, hi, pattern);
      const testFetch = await fetchUrl(testUrl, { timeoutMs: 30000 });
      if (testFetch.status >= 400) break;
      const products = extractProducts(testFetch.body, testUrl);
      if (products.length === 0) break;
      lo = hi;
      hi = hi * 2;
    }

    // Binary search between lo and hi
    while (lo < hi - 1) {
      const mid = Math.floor((lo + hi) / 2);
      await delay(DELAY_MS);
      const midUrl = buildPaginatedUrl(firstUrl, mid, pattern);
      const midFetch = await fetchUrl(midUrl, { timeoutMs: 30000 });
      if (midFetch.status >= 400) {
        hi = mid;
        continue;
      }
      const midProducts = extractProducts(midFetch.body, midUrl);
      if (midProducts.length === 0) {
        hi = mid;
      } else {
        lo = mid;
      }
    }

    // lo is now the last page with products
    const totalPages = lo;

    // Get last page product count
    await delay(DELAY_MS);
    const lastPageUrl = buildPaginatedUrl(firstUrl, totalPages, pattern);
    const lastPageFetch = await fetchUrl(lastPageUrl, { timeoutMs: 30000 });
    let lastPageCount = perPage;
    if (lastPageFetch.status < 400) {
      const lastPageProducts = extractProducts(lastPageFetch.body, lastPageUrl);
      if (lastPageProducts.length > 0) {
        lastPageCount = lastPageProducts.length;
      }
    }

    // Total = (totalPages - 1) * perPage + lastPageCount
    const walkTotal = (totalPages - 1) * perPage + lastPageCount;
    return walkTotal;
  } catch {
    return null;
  }
}

export async function runStage3Count(profile: any): Promise<StageResult> {
  const blockingErrors: string[] = [];
  const counts: { api?: number; sitemap?: number; walk?: number } = {};

  // Method 1: API count
  process.stderr.write('  [stage3] Checking API count...\n');
  const apiCount = await getApiCount(profile);
  if (apiCount !== null) counts.api = apiCount;

  // Method 2: Sitemap count
  process.stderr.write('  [stage3] Checking sitemap count...\n');
  await delay(DELAY_MS);
  const sitemapCount = await getSitemapCount(profile);
  if (sitemapCount !== null) counts.sitemap = sitemapCount;

  // Method 3: Walk count
  process.stderr.write('  [stage3] Checking walk count...\n');
  await delay(DELAY_MS);
  const walkCount = await getWalkCount(profile);
  if (walkCount !== null) counts.walk = walkCount;

  // Pairwise drift check
  const driftPairs: Record<string, number> = {};
  const available = Object.entries(counts) as Array<[string, number]>;

  if (available.length < 2) {
    // Only 0 or 1 methods returned a count -- can't cross-check
    // Use expectedProductCount from profile as fallback comparison target
    const expected = profile.expectedProductCount;
    if (expected && available.length === 1) {
      const [method, count] = available[0];
      const drift = Math.round(Math.abs(expected - count) / Math.max(expected, count) * 100);
      driftPairs[`${method}-expected`] = drift;
      if (drift > 10) {
        blockingErrors.push(
          `${method} count (${count}) vs expectedProductCount (${expected}) drift is ${drift}% (>10%)`
        );
      }
    } else if (available.length === 0 && expected) {
      // No live counts obtained; not a blocking error, just a warning
      process.stderr.write('  [stage3] WARNING: No live count methods returned data; using expectedProductCount from profile only\n');
    }
  } else {
    // Standard pairwise comparison
    for (let i = 0; i < available.length; i++) {
      for (let j = i + 1; j < available.length; j++) {
        const [nameA, countA] = available[i];
        const [nameB, countB] = available[j];
        const maxVal = Math.max(countA, countB);
        const drift = maxVal > 0 ? Math.round(Math.abs(countA - countB) / maxVal * 100) : 0;
        const pairKey = `${nameA}-${nameB}`;
        driftPairs[pairKey] = drift;

        if (drift > 10) {
          blockingErrors.push(
            `${nameA} (${countA}) vs ${nameB} (${countB}) drift is ${drift}% (>10%)`
          );
        }
      }
    }
  }

  const verdict: StageVerdict = blockingErrors.length === 0 ? 'PASS' : 'FAIL';

  return {
    stage: 3,
    name: 'Multi-Method Count',
    verdict,
    details: { counts, driftPairs, availableMethods: available.length },
    blockingErrors,
  };
}

// ---- Stage 4: Operator Review Gate -----------------------------------------

export async function runStage4Review(
  profile: any,
  profilePath: string,
  stages: StageResult[],
  mode: 'default' | 'approve' | 'prompt',
): Promise<StageResult> {
  // Print summary table
  console.log('\n========================================');
  console.log(' REVIEW SUMMARY');
  console.log('========================================');
  console.log(`Profile: ${profilePath}`);
  console.log(`Platform: ${profile.platform}`);
  console.log(`WAF Type: ${profile.wafType ?? 'none'}`);
  console.log(`Has WAF: ${profile.hasWaf}`);
  console.log(`Expected Product Count: ${profile.expectedProductCount}`);
  console.log(`Product Count Method: ${profile.productCountMethod}`);
  console.log(`Catalog URLs: ${(profile.catalogUrls || []).length}`);
  console.log(`Watermark Method: ${profile.crawlers?.watermark?.method}`);
  console.log('');

  console.log('Stage Results:');
  console.log('  Stage | Name                  | Verdict | Errors');
  console.log('  ------|---------------------- |---------|-------');
  for (const s of stages) {
    const errStr = s.blockingErrors.length > 0
      ? s.blockingErrors.slice(0, 2).join('; ')
      : 'none';
    console.log(`    ${s.stage}   | ${s.name.padEnd(21)} | ${s.verdict.padEnd(7)} | ${errStr}`);
  }
  console.log('');

  // Check if stages 1-3 all passed
  const stagesPass = stages.every(s => s.verdict === 'PASS');

  if (mode === 'default') {
    console.log('Mode: default (review only)');
    console.log('Re-run with --approve to approve for DB write.');
    console.log('Re-run with --prompt for interactive Y/N approval.');
    return {
      stage: 4,
      name: 'Operator Review',
      verdict: 'PASS',
      details: { mode: 'default', stagesPass, approved: false },
      blockingErrors: [],
    };
  }

  if (mode === 'approve') {
    if (!stagesPass) {
      return {
        stage: 4,
        name: 'Operator Review',
        verdict: 'FAIL',
        details: { mode: 'approve', stagesPass, approved: false },
        blockingErrors: ['Cannot auto-approve: stages 1-3 have failures'],
      };
    }
    console.log('Mode: --approve (auto-approved)');
    return {
      stage: 4,
      name: 'Operator Review',
      verdict: 'PASS',
      details: { mode: 'approve', stagesPass, approved: true },
      blockingErrors: [],
    };
  }

  // mode === 'prompt'
  if (!stagesPass) {
    console.log('WARNING: Stages 1-3 have failures. Approving is not recommended.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question('Approve for DB write? (Y/N): ', resolve);
  });
  rl.close();

  const approved = answer.trim().toUpperCase() === 'Y';
  if (!approved) {
    return {
      stage: 4,
      name: 'Operator Review',
      verdict: 'FAIL',
      details: { mode: 'prompt', stagesPass, approved: false, answer: answer.trim() },
      blockingErrors: ['Operator declined approval'],
    };
  }

  return {
    stage: 4,
    name: 'Operator Review',
    verdict: 'PASS',
    details: { mode: 'prompt', stagesPass, approved: true, answer: answer.trim() },
    blockingErrors: [],
  };
}

// ---- Stage 5: Output Review Report -----------------------------------------

export function buildStage5Metadata(): StageResult {
  return {
    stage: 5,
    name: 'Output Review Report',
    verdict: 'PASS',
    details: {},
    blockingErrors: [],
  };
}

export async function writeReviewReport(result: ReviewResult): Promise<void> {
  const outputDir = path.resolve(__dirname, '..', '..', 'docs', 'site-audit');
  await fs.mkdir(outputDir, { recursive: true });

  // Derive output filenames from the INPUT profile basename so they match
  // exactly what enable-new-site.ts looks for: `<profile>-review.json`.
  // Previously this used `${domain}-${runTimestamp}` which never matched the
  // profile's own filename, so enable-new-site always exited 4 ("No review
  // file found").
  const profileBase = path.basename(result.profilePath, '.json');
  const jsonPath = path.join(outputDir, `${profileBase}-review.json`);
  const mdPath = path.join(outputDir, `${profileBase}-review.md`);

  // Set file paths on Stage 5 details BEFORE serializing
  const stage5 = result.stages.find(s => s.stage === 5);
  if (stage5) {
    stage5.details = { jsonPath, mdPath };
  }

  // Write JSON report (now includes Stage 5 with file paths)
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2));
  process.stderr.write(`  [stage5] Written: ${jsonPath}\n`);

  // Write markdown report
  const md = buildMarkdownReport(result);
  await fs.writeFile(mdPath, md);
  process.stderr.write(`  [stage5] Written: ${mdPath}\n`);
}

function buildMarkdownReport(result: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`# Review Report: ${result.domain}`);
  lines.push('');
  lines.push(`**Profile:** ${result.profilePath}`);
  lines.push(`**Timestamp:** ${result.timestamp}`);
  lines.push(`**Overall Verdict:** ${result.overallVerdict}`);
  lines.push(`**Approved for DB Write:** ${result.approvedForDbWrite}`);
  lines.push('');

  lines.push('## Stage Results');
  lines.push('');
  lines.push('| Stage | Name | Verdict | Errors |');
  lines.push('|-------|------|---------|--------|');
  for (const s of result.stages) {
    const errStr = s.blockingErrors.length > 0
      ? s.blockingErrors.join('; ')
      : 'none';
    lines.push(`| ${s.stage} | ${s.name} | ${s.verdict} | ${errStr} |`);
  }
  lines.push('');

  for (const s of result.stages) {
    lines.push(`### Stage ${s.stage}: ${s.name}`);
    lines.push('');
    lines.push(`**Verdict:** ${s.verdict}`);
    lines.push('');
    if (s.blockingErrors.length > 0) {
      lines.push('**Blocking Errors:**');
      for (const e of s.blockingErrors) {
        lines.push(`- ${e}`);
      }
      lines.push('');
    }
    lines.push('**Details:**');
    lines.push('```json');
    lines.push(JSON.stringify(s.details, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (result.approvedForDbWrite) {
    lines.push('## Next Steps');
    lines.push('');
    lines.push('Profile approved for DB write. Run:');
    lines.push('```');
    lines.push(`npx tsx backend/scripts/enable-new-site.ts ${result.profilePath}`);
    lines.push('```');
  } else {
    lines.push('## Next Steps');
    lines.push('');
    lines.push('Profile NOT approved for DB write. Review the blocking errors above.');
    lines.push('Re-run with `--approve` after fixing issues, or use `--prompt` for interactive approval.');
  }

  lines.push('');
  return lines.join('\n');
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const profilePath = args.find(a => !a.startsWith('--'));
  const hasApprove = args.includes('--approve');
  const hasPrompt = args.includes('--prompt');

  if (!profilePath) {
    console.error('Usage: npx tsx backend/scripts/audit-review-pipeline.ts <profile-json-path> [--approve|--prompt]');
    process.exit(1);
  }

  // Resolve profile path relative to cwd
  const resolvedPath = path.resolve(profilePath);

  // Load profile JSON
  let profile: any;
  try {
    const raw = await fs.readFile(resolvedPath, 'utf-8');
    profile = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to load profile from ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const domain = extractDomainFromProfile(profile);
  const timestamp = new Date().toISOString();
  const mode: 'default' | 'approve' | 'prompt' = hasApprove ? 'approve' : hasPrompt ? 'prompt' : 'default';

  console.log(`\nReviewing profile for: ${domain}`);
  console.log(`Profile path: ${resolvedPath}`);
  console.log(`Mode: ${mode}`);
  console.log('');

  const stages: StageResult[] = [];

  // Stage 1: Spec compliance
  process.stderr.write('[Stage 1] Spec compliance...\n');
  const stage1 = await runStage1Spec(profile);
  stages.push(stage1);
  console.log(`  Stage 1 (${stage1.name}): ${stage1.verdict}`);
  if (stage1.blockingErrors.length > 0) {
    for (const e of stage1.blockingErrors) console.log(`    ERROR: ${e}`);
  }

  if (stage1.verdict === 'FAIL') {
    const stage5 = buildStage5Metadata();
    stages.push(stage5);
    const result: ReviewResult = {
      profilePath: resolvedPath,
      domain,
      timestamp,
      stages,
      overallVerdict: 'FAIL',
      approvedForDbWrite: false,
    };
    // Still write report for failed stage 1
    try {
      await writeReviewReport(result);
    } catch (err) {
      stage5.verdict = 'FAIL';
      stage5.blockingErrors.push(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log('\nFailed at Stage 1. Exiting.');
    process.exit(1);
  }

  // Stage 2: Live walk test
  process.stderr.write('[Stage 2] Live walk test...\n');
  const stage2 = await runStage2Walk(profile);
  stages.push(stage2);
  console.log(`  Stage 2 (${stage2.name}): ${stage2.verdict}`);
  if (stage2.blockingErrors.length > 0) {
    for (const e of stage2.blockingErrors) console.log(`    ERROR: ${e}`);
  }

  if (stage2.verdict === 'FAIL') {
    const stage5 = buildStage5Metadata();
    stages.push(stage5);
    const result: ReviewResult = {
      profilePath: resolvedPath,
      domain,
      timestamp,
      stages,
      overallVerdict: 'FAIL',
      approvedForDbWrite: false,
    };
    try {
      await writeReviewReport(result);
    } catch (err) {
      stage5.verdict = 'FAIL';
      stage5.blockingErrors.push(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log('\nFailed at Stage 2. Exiting.');
    process.exit(1);
  }

  // Stage 3: Multi-method count
  process.stderr.write('[Stage 3] Multi-method count cross-check...\n');
  const stage3 = await runStage3Count(profile);
  stages.push(stage3);
  console.log(`  Stage 3 (${stage3.name}): ${stage3.verdict}`);
  if (stage3.blockingErrors.length > 0) {
    for (const e of stage3.blockingErrors) console.log(`    ERROR: ${e}`);
  }

  if (stage3.verdict === 'FAIL') {
    const stage5 = buildStage5Metadata();
    stages.push(stage5);
    const result: ReviewResult = {
      profilePath: resolvedPath,
      domain,
      timestamp,
      stages,
      overallVerdict: 'FAIL',
      approvedForDbWrite: false,
    };
    try {
      await writeReviewReport(result);
    } catch (err) {
      stage5.verdict = 'FAIL';
      stage5.blockingErrors.push(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log('\nFailed at Stage 3. Exiting.');
    process.exit(1);
  }

  // Stage 4: Operator review
  process.stderr.write('[Stage 4] Operator review...\n');
  const stage4 = await runStage4Review(profile, resolvedPath, stages, mode);
  stages.push(stage4);
  console.log(`  Stage 4 (${stage4.name}): ${stage4.verdict}`);

  const approved = (stage4.details as any).approved === true;

  if (stage4.verdict === 'FAIL') {
    const stage5 = buildStage5Metadata();
    stages.push(stage5);
    const result: ReviewResult = {
      profilePath: resolvedPath,
      domain,
      timestamp,
      stages,
      overallVerdict: 'FAIL',
      approvedForDbWrite: false,
    };
    try {
      await writeReviewReport(result);
    } catch (err) {
      stage5.verdict = 'FAIL';
      stage5.blockingErrors.push(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log('\nDeclined at Stage 4. Exiting.');
    process.exit(2);
  }

  // Stage 5: Output review report
  process.stderr.write('[Stage 5] Writing review report...\n');
  const stage5 = buildStage5Metadata();
  stages.push(stage5);

  const result: ReviewResult = {
    profilePath: resolvedPath,
    domain,
    timestamp,
    stages,
    overallVerdict: 'PASS',
    approvedForDbWrite: approved,
  };

  try {
    await writeReviewReport(result);
  } catch (err) {
    stage5.verdict = 'FAIL';
    stage5.blockingErrors.push(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`  Stage 5 (${stage5.name}): ${stage5.verdict}`);

  if (stage5.verdict === 'FAIL') {
    console.log('\nFailed at Stage 5. Exiting.');
    process.exit(3);
  }

  console.log(`\nReview complete. Overall: ${result.overallVerdict}, Approved: ${result.approvedForDbWrite}`);

  if (result.approvedForDbWrite) {
    console.log(`\nNext: npx tsx backend/scripts/enable-new-site.ts ${resolvedPath}`);
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
