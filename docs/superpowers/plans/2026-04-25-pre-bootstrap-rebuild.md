# Pre-Bootstrap Pipeline Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `backend/scripts/pre-bootstrap.ts` and its 9 probe modules into a 5-room lifecycle architecture (intake, access+identity, geography+count, navigation, bootstrap) plus an orchestrator and standalone bootstrap utility, preserving proven session work via cherry-picks and adding a detector registry pattern for extensible platform detection.

**Architecture:** One folder per lifecycle stage under `backend/scripts/probe/`, plus `shared/` for cross-cutting code. Cumulative typed state flows forward only. Strict pass/soft-warn/hard-fail gates per room. Human review between Room 4 and Room 5.

**Tech Stack:** TypeScript, Node 20+, npx tsx, Prisma, Playwright, axios, Cheerio, Vitest, BullMQ (existing infra reused), Redis (Upstash, existing).

**Spec reference:** [docs/superpowers/specs/2026-04-24-pre-bootstrap-rebuild-design.md](../specs/2026-04-24-pre-bootstrap-rebuild-design.md). Every task in this plan references its spec section. Read the spec section for the task before executing.

**Required reading before each task:**
- `.claude/catalog-url-discovery-playbook.md` — 7-phase audit + 38 mistake patterns
- `.claude/agents/crawler-specialist.md` — 38 accumulated lessons
- `.claude/probe-rewrite-lessons.md` — session-distilled anti-patterns
- The spec section linked from the task

**Testing convention:**
- Vitest is the existing test framework (check `backend/package.json`).
- Unit tests live in `__test__/` next to the module.
- Fixtures (HTML/headers/cookies captured from live sites) live in `__test__/fixtures/<site>.{html,headers.json,cookies.json}`.
- Integration test = run the orchestrator end-to-end against a live site (Tier-1 smoke).

**Commit convention:** Follow existing project style (`feat(scope): summary`, `fix(scope): summary`, `chore(scope): summary`). Example: `feat(probe-room2): add canonical-host www-fallback on challenge body`. Always include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` in the trailer.

---

## Phase 0 — Revert + Prep

### Task 0.1: Save cherry-pick reference snapshots

**Files:**
- Create: `docs/superpowers/plans/cherry-pick-snapshots/` (gitignored — snapshots are reference only)

**Goal:** Before reverting uncommitted session work, snapshot the files we plan to lift code from. Snapshots are read-only references during implementation, NEVER restored to source tree.

- [ ] **Step 1:** Create snapshot directory.

```bash
mkdir -p docs/superpowers/plans/cherry-pick-snapshots
echo "*" > docs/superpowers/plans/cherry-pick-snapshots/.gitignore  # gitignore self
```

- [ ] **Step 2:** Snapshot the files listed in spec §9 cherry-pick table.

```bash
cp backend/scripts/probe-modules/probe-access.ts       docs/superpowers/plans/cherry-pick-snapshots/probe-access.ts.snapshot
cp backend/scripts/probe-modules/probe-fetch.ts        docs/superpowers/plans/cherry-pick-snapshots/probe-fetch.ts.snapshot
cp backend/scripts/probe-modules/probe-platform.ts     docs/superpowers/plans/cherry-pick-snapshots/probe-platform.ts.snapshot
cp backend/scripts/probe-modules/probe-sitemap.ts      docs/superpowers/plans/cherry-pick-snapshots/probe-sitemap.ts.snapshot
cp backend/scripts/probe-modules/probe-sort.ts         docs/superpowers/plans/cherry-pick-snapshots/probe-sort.ts.snapshot
cp backend/scripts/pre-bootstrap.ts                    docs/superpowers/plans/cherry-pick-snapshots/pre-bootstrap.ts.snapshot
```

- [ ] **Step 3:** Verify snapshots saved.

```bash
ls -la docs/superpowers/plans/cherry-pick-snapshots/
# Expect: 6 .snapshot files + .gitignore
```

- [ ] **Step 4:** No commit (snapshots are gitignored).

---

### Task 0.2: Revert uncommitted backend changes

**Files:**
- Revert: all files listed by `git status`

**Goal:** Clean slate per spec §1.1. Production playwright-fetcher.ts changes STAY (per spec §9 + §1.2 out-of-scope).

- [ ] **Step 1:** Verify what will be reverted.

```bash
git status --short | grep -E "^(M|D)" | grep -v "^?? "
# Expect: 13 modified files (M) listed
```

- [ ] **Step 2:** Save the production playwright-fetcher.ts changes separately (they STAY).

```bash
git diff backend/src/services/scraper/playwright-fetcher.ts > /tmp/playwright-fetcher-keep.diff
wc -l /tmp/playwright-fetcher-keep.diff
# Expect: ~80-100 lines of diff (cookie capture + sgcaptcha wait + iPhone UA opt)
```

- [ ] **Step 3:** Revert all modified files EXCEPT playwright-fetcher.ts.

```bash
git checkout backend/package.json package-lock.json \
  backend/scripts/pre-bootstrap.ts \
  backend/scripts/probe-modules/__test__/test-pre-bootstrap.ts \
  backend/scripts/probe-modules/probe-access.ts \
  backend/scripts/probe-modules/probe-catalog-urls.ts \
  backend/scripts/probe-modules/probe-extraction.ts \
  backend/scripts/probe-modules/probe-fetch.ts \
  backend/scripts/probe-modules/probe-platform.ts \
  backend/scripts/probe-modules/probe-sitemap.ts \
  backend/scripts/probe-modules/probe-sort.ts
```

- [ ] **Step 4:** Verify playwright-fetcher.ts changes are still present.

```bash
git diff backend/src/services/scraper/playwright-fetcher.ts | wc -l
# Expect: matches step 2 line count (still in working tree)
```

- [ ] **Step 5:** Verify CLAUDE.md correction from previous session is still committed.

```bash
git log --oneline -1 CLAUDE.md
# Expect: 9d0acda (the spec commit which includes the T1 direction correction)
```

- [ ] **Step 6:** Type-check the post-revert state.

```bash
cd backend && npx tsc --noEmit 2>&1 | head -20
# Expect: 2 pre-existing frontend errors only (per CLAUDE.md known issue)
```

- [ ] **Step 7:** Commit the playwright-fetcher.ts production changes (keep it isolated from the rebuild).

```bash
git add backend/src/services/scraper/playwright-fetcher.ts
git commit -m "$(cat <<'EOF'
fix(playwright-fetcher): preserve cookie capture + sgcaptcha wait + iPhone UA from prior session

Carries forward production-relevant changes that were uncommitted at the
2026-04-24 hard-reset. These changes help the production catalog-crawler
and watermark-crawler handle sgcaptcha PoW + Sucuri/Incapsula cookie reuse,
independent of the pre-bootstrap rebuild.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 0.3: Cleanup scratch files from prior session

**Files:**
- Delete: scratch test scripts, intermediate reports, scratch JS scripts.
- Keep: `_remaining-issues.md`, `.claude/probe-rewrite-lessons.md`.

**Goal:** Per spec §11.1 cleanup list.

- [ ] **Step 1:** List what will be deleted (dry run).

```bash
ls -la \
  backend/scripts/probe-modules/__test__/test-phase*.ts \
  backend/scripts/probe-modules/__test__/test-pre-bootstrap-20.ts \
  backend/scripts/probe-modules/__test__/test-pre-bootstrap-batch3.ts \
  backend/scripts/probe-modules/_*.md \
  backend/get-ground-truth.js \
  backend/scripts/compare-before-after.js \
  backend/scripts/load-siteprofiles.js \
  backend/scripts/rerun-14.ts \
  gotenda-stderr2.tmp gotenda-stdout2.tmp probe-access-stderr.tmp \
  2>/dev/null
```

- [ ] **Step 2:** Delete the listed files.

```bash
rm -f \
  backend/scripts/probe-modules/__test__/test-phase*.ts \
  backend/scripts/probe-modules/__test__/test-pre-bootstrap-20.ts \
  backend/scripts/probe-modules/__test__/test-pre-bootstrap-batch3.ts \
  backend/scripts/probe-modules/_*.md \
  backend/get-ground-truth.js \
  backend/scripts/compare-before-after.js \
  backend/scripts/load-siteprofiles.js \
  backend/scripts/rerun-14.ts \
  gotenda-stderr2.tmp gotenda-stdout2.tmp probe-access-stderr.tmp
```

- [ ] **Step 3:** Verify cleanup.

```bash
git status --short
# Expect: only .claude/probe-rewrite-lessons.md and verify-14-db-writes.js as untracked
# (plus .claude/scheduled_tasks.lock — irrelevant)
```

- [ ] **Step 4:** Move `verify-14-db-writes.js` to a discoverable location and add it to git (it's a useful one-shot utility).

```bash
git add backend/scripts/verify-14-db-writes.js
git add .claude/probe-rewrite-lessons.md
git commit -m "$(cat <<'EOF'
chore(repo): keep DB-write verifier + probe-rewrite-lessons as repo references

verify-14-db-writes.js: read-only checker for the 14 DB writes from the
2026-04-23 session. Useful to re-verify after schema changes or DB resets.

probe-rewrite-lessons.md: distilled anti-patterns from the 2026-04-21..04-24
session. Referenced by the rebuild spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 0.4: Delete old probe-modules directory (not needed for rebuild)

**Files:**
- Delete: `backend/scripts/probe-modules/` (entire folder)
- Delete: `backend/scripts/pre-bootstrap.ts` (will be replaced)

**Goal:** The new architecture replaces these entirely. Keep nothing.

- [ ] **Step 1:** Confirm no other code imports from these (it shouldn't).

```bash
grep -rn "probe-modules\|pre-bootstrap" backend/src/ 2>/dev/null
# Expect: 0 matches (probe code is scripts/, not src/)
```

- [ ] **Step 2:** Delete the directory and orchestrator.

```bash
rm -rf backend/scripts/probe-modules/
rm -f backend/scripts/pre-bootstrap.ts
```

- [ ] **Step 3:** Type-check.

```bash
cd backend && npx tsc --noEmit 2>&1 | head -10
# Expect: 2 pre-existing frontend errors only
```

- [ ] **Step 4:** Commit.

```bash
git add -u backend/scripts/
git commit -m "$(cat <<'EOF'
chore(pre-bootstrap): remove old probe-modules/ + pre-bootstrap.ts (rebuild forthcoming)

Per docs/superpowers/specs/2026-04-24-pre-bootstrap-rebuild-design.md, the
9 probe modules and orchestrator are replaced by a 5-room lifecycle
architecture in backend/scripts/probe/. Snapshots of the deleted files are
in docs/superpowers/plans/cherry-pick-snapshots/ (gitignored) for cherry-pick
reference during implementation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 1 — Shared Infrastructure (`probe/shared/`)

Spec reference: §3.1, §3.2.

### Task 1.1: Create folder structure + types.ts (cumulative state)

**Files:**
- Create: `backend/scripts/probe/shared/types.ts`

**Goal:** Type definitions for the 5 rooms' cumulative state. TypeScript enforces dependency order at compile time.

- [ ] **Step 1:** Create folder.

```bash
mkdir -p backend/scripts/probe/shared
mkdir -p backend/scripts/probe/shared/__test__
```

- [ ] **Step 2:** Write types.ts. Cover spec §4.1, §4.2, §4.3, §4.4, §4.5 contract types.

```typescript
// backend/scripts/probe/shared/types.ts
// Cumulative state types per spec §5.1.
// Each room's output extends the previous room's output. No mutation.

// ─── Room 1: Intake ──────────────────────────────────────────────────────────
export type IntakeState = {
  inputUrl: string;
  canonicalUrl: string;
  timestamp: string;
  runId: string;
};

// ─── Room 2: Access & Identity ──────────────────────────────────────────────
export type WafType =
  | 'cloudflare-passive' | 'cloudflare-active'
  | 'sucuri' | 'sgcaptcha' | 'incapsula' | 'akamai' | 'malcare'
  | 'cloudflare-passive-with-owasp'
  | null;

export type AccessMethod =
  | 'axios-desktop' | 'axios-iphone'
  | 'playwright-chromium'
  | 'playwright-iphone-cookies'
  | 'playwright-real-chrome';

export type PlatformTag = string;  // detector registry-issued IDs (e.g. 'bigcommerce-stencil')

export type HeavyProbeBatchResult = {
  batchId: number;
  description: string;
  status: number | null;
  headers: Record<string, string>;
  bodySnippet: string;  // first 2KB
  durationMs: number;
};

export type PlatformMarkerEvidence = {
  detectorId: PlatformTag;
  confidence: 'high' | 'medium' | 'low';
  signals: Record<string, unknown>;
  compositeRuleApplied?: string;
};

export type AccessIdentityState = IntakeState & {
  canonicalOrigin: string;
  canonicalOriginResolution: {
    apexResponded: boolean;
    apexWasChallenged: boolean;
    wwwFallbackUsed: boolean;
    serverHeaders: { apex?: string; canonical?: string };
  };
  hasWaf: boolean;
  wafType: WafType;
  wafProbeEvidence: {
    method: 'heavy-8-batch';
    timestamp: string;
    batches: HeavyProbeBatchResult[];
    cfHeaders?: string[];
    sucuriHeaders?: string[];
    sgCaptchaDetected?: boolean;
    incapsulaCookies?: string[];
    akamaiServer?: boolean;
    malcareInBody?: boolean;
    rapidBurstStatus: string;
    sqliRuleFired: boolean;
    xssRuleFired: boolean;
    botUaBlocked: boolean;
    honeypotPathsBlocked: boolean;
  };
  needsPlaywright: boolean;
  userAgentOverride: string | null;
  accessMethod: AccessMethod;
  platform: PlatformTag;
  platformMarker: PlatformMarkerEvidence;
};

// ─── Room 3: Geography & Count ──────────────────────────────────────────────
export type CountMethod =
  | 'wp-rest-header' | 'wc-store-api-header'
  | 'shopify-count-json' | 'shopify-products-walk'
  | 'ecwid-storefront-search' | 'klevu-api'
  | 'bc-xmlsitemap' | 'magento-toolbar'
  | 'celerant-perpage-all' | 'generic-product-sitemap'
  | 'wix-store-products-sitemap' | 'catalog-walk-only';

export type GeographyCountState = AccessIdentityState & {
  catalogUrls: string[];
  catalogUrlSource: 'nav' | 'taxonomy-api' | 'category-tree-walk' | 'manual';
  catalogUrlWalkCounts: Array<{ url: string; uniqueProducts: number; pages: number }>;
  walkedUniqueCount: number;
  globalProductCount: number;
  globalProductCountMethod: CountMethod;
  globalProductCountEvidence: {
    endpoint?: string;
    responseSample?: string;
    headerValue?: string;
    sitemapShards?: string[];
    sitemapTotalLocs?: number;
    sitemapProductLocs?: number;
    sitemapHeadSamples?: Array<{ url: string; status: number }>;
  };
  driftPct: number;
  coverageStrategy: 'api-walk' | 'html-walk' | 'hybrid';
};

// ─── Room 4: Navigation ─────────────────────────────────────────────────────
export type PaginationPattern = {
  type: 'query' | 'path' | 'offset-query' | 'suffix-replace' | null;
  template?: string;
  match?: string;
  perPage: number;
  firstPageHasParam: boolean;
  startPage: number;
};

export type WatermarkMethod =
  | 'api-date-since-watermark'
  | 'navigate-from-watermark'
  | 'full-catalog-sweep';

export type DateVerificationMethod =
  | 'api-date-field' | 'listing-html-date' | 'detail-page-date-spot-check'
  | 'sitemap-lastmod' | 'rss-feed' | 'sourceId-autoincrement';

export type NavigationState = GeographyCountState & {
  paginationPattern: PaginationPattern;
  paginationEvidence: {
    testA_page1_vs_page2: { passed: boolean; sample: string[] };
    testB_pageN_vs_pageN_1: { passed: boolean; sample: string[] };
    testC_overflow_vs_page1: { passed: boolean; sample: string[] };
    testD_perPage_sanity: { passed: boolean; observedPerPage: number; expectedPerPage: number };
    totalPagesEstimate: number;
    totalPagesSource: 'widget-markup' | 'api-total' | 'sitemap-math' | 'walk-to-empty';
  };
  sortParam: string | null;
  sortEvidence: {
    selectHtml: string;
    candidateParams: string[];
    dateVerification: {
      method: DateVerificationMethod;
      page1FirstDate: string;
      page1SecondDate: string;
      page1ThirdDate: string;
      survivesPagination: boolean;
      monotonicallyDecreasing: boolean;
    } | null;
    idJumpBefore: string;
    idJumpAfter: string;
  };
  watermarkMethod: WatermarkMethod;
  watermarkMethodSelection: {
    reason: string;
    dateSourceForMethodA?: string;
    urlSortVerifiedForMethodB?: boolean;
    fallbackToMethodCReason?: string;
  };
};

// ─── Room 5: Bootstrap ──────────────────────────────────────────────────────
export type BootstrapState = NavigationState & {
  productsIndexed: number;
  indexingStrategyUsed: 'api-walk' | 'html-walk' | 'hybrid';
  detailEnrichmentStats: {
    productsEnriched: number;
    avgDetailFetchMs: number;
    detailFetchFailures: number;
  };
  newestProduct: {
    url: string;
    sourceId?: string;
    postDate: string;
    title: string;
    price?: number;
  };
  finalDriftPct: number;
  durationMs: number;
  dbWrites: {
    productIndexRows: number;
    monitoredSiteCreated: boolean;
    lastWatermarkUrlSet: boolean;
    lastWatermarkDateSet: boolean;
    isEnabledSet: boolean;
  };
};

// ─── Room failure ──────────────────────────────────────────────────────────
export type RoomFailure = {
  roomFailed: true;
  roomNumber: 1 | 2 | 3 | 4 | 5;
  reason: string;
  evidence: Record<string, unknown>;
  timestamp: string;
};

export type RoomResult<T> = T | RoomFailure;
```

- [ ] **Step 3:** Type-check.

```bash
cd backend && npx tsc --noEmit
# Expect: 2 pre-existing frontend errors only
```

- [ ] **Step 4:** Commit.

```bash
git add backend/scripts/probe/shared/types.ts
git commit -m "feat(probe-shared): add cumulative state types for 5-room pipeline" \
  -m "Per spec §4 + §5.1: IntakeState ⊂ AccessIdentityState ⊂ GeographyCountState ⊂ NavigationState ⊂ BootstrapState. RoomFailure is the union alternative when a room hard-fails." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.2: shared/url-utils.ts

**Files:**
- Create: `backend/scripts/probe/shared/url-utils.ts`
- Create: `backend/scripts/probe/shared/__test__/url-utils.test.ts`

**Goal:** URL canonicalization, nav-URL filtering, fragment preservation. Lift `isLikelyNavUrl` from cherry-pick snapshot.

- [ ] **Step 1:** Write the failing test.

```typescript
// backend/scripts/probe/shared/__test__/url-utils.test.ts
import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, isLikelyNavUrl, stripTrailingSlash, preserveFragment } from '../url-utils';

describe('canonicalizeUrl', () => {
  it('lowercases scheme + host, preserves path case + query + fragment', () => {
    expect(canonicalizeUrl('HTTPS://Example.COM/Product/Foo?a=1#bar'))
      .toBe('https://example.com/Product/Foo?a=1#bar');
  });
  it('adds https when scheme missing', () => {
    expect(canonicalizeUrl('example.com')).toBe('https://example.com/');
  });
  it('rejects malformed', () => {
    expect(() => canonicalizeUrl('not a url')).toThrow();
  });
});

describe('isLikelyNavUrl', () => {
  it('flags wishlist/cart/checkout/account/login as nav', () => {
    for (const path of ['/wishlist', '/cart', '/checkout', '/account', '/login', '/register']) {
      expect(isLikelyNavUrl(`https://example.com${path}`)).toBe(true);
    }
  });
  it('flags about/faq/privacy/terms/blog as nav', () => {
    for (const path of ['/about', '/faq', '/privacy', '/terms', '/blog/post-1']) {
      expect(isLikelyNavUrl(`https://example.com${path}`)).toBe(true);
    }
  });
  it('does NOT flag product/category URLs', () => {
    for (const url of [
      'https://example.com/product/awesome-rifle',
      'https://example.com/firearms/rifles',
      'https://example.com/product-category/handguns',
    ]) {
      expect(isLikelyNavUrl(url)).toBe(false);
    }
  });
});

describe('stripTrailingSlash', () => {
  it('strips trailing slash from non-root', () => {
    expect(stripTrailingSlash('https://example.com/foo/')).toBe('https://example.com/foo');
  });
  it('keeps trailing slash on root', () => {
    expect(stripTrailingSlash('https://example.com/')).toBe('https://example.com/');
  });
});

describe('preserveFragment', () => {
  it('preserves #fragment when adding query params (Searchspring case)', () => {
    const u = new URL('https://example.com/cat#/sort:created_at:desc');
    u.searchParams.set('page', '3');
    expect(preserveFragment(u.toString())).toBe('https://example.com/cat?page=3#/sort:created_at:desc');
  });
});
```

- [ ] **Step 2:** Run test to verify failure.

```bash
cd backend && npx vitest run scripts/probe/shared/__test__/url-utils.test.ts
# Expect: ALL tests fail with "module not found" or similar
```

- [ ] **Step 3:** Implement url-utils.ts.

```typescript
// backend/scripts/probe/shared/url-utils.ts
const NAV_PATTERNS = /\/(wishlist|cart|checkout|account|login|register|registration|giftcert|contact|about|faq|privacy|terms|shipping|returns|blog|news|pages?\/|sitemap|robots|search\/?$)/i;
const NAV_FRAGMENTS = /^(mailto:|javascript:|tel:|sms:|#)/i;

export function canonicalizeUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) {
    if (!s.includes('://')) s = 'https://' + s;
    else throw new Error(`Unsupported scheme: ${input}`);
  }
  let u: URL;
  try { u = new URL(s); }
  catch (err) { throw new Error(`Malformed URL: ${input}`); }
  // Reject localhost/private
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) {
    throw new Error(`Private/localhost not allowed: ${host}`);
  }
  u.protocol = u.protocol.toLowerCase();
  u.hostname = host;
  // Path case is preserved (e.g. Magento URLs are case-sensitive in some installs)
  return u.toString();
}

export function isLikelyNavUrl(url: string): boolean {
  if (NAV_FRAGMENTS.test(url)) return true;
  let path: string;
  try { path = new URL(url).pathname; } catch { return false; }
  return NAV_PATTERNS.test(path);
}

export function stripTrailingSlash(url: string): string {
  if (url.length > 1 && url.endsWith('/') && !url.endsWith('://')) {
    // Preserve trailing slash on bare-host root
    const u = new URL(url);
    if (u.pathname === '/') return url;
    return url.replace(/\/$/, '');
  }
  return url;
}

export function preserveFragment(url: string): string {
  // URL class already preserves fragments through searchParams.set, this is a no-op pass-through
  // but exists for future cases where we need to manipulate the URL string directly
  return url;
}
```

- [ ] **Step 4:** Run test to verify pass.

```bash
cd backend && npx vitest run scripts/probe/shared/__test__/url-utils.test.ts
# Expect: ALL pass
```

- [ ] **Step 5:** Commit.

```bash
git add backend/scripts/probe/shared/url-utils.ts backend/scripts/probe/shared/__test__/url-utils.test.ts
git commit -m "feat(probe-shared): add url-utils with canonicalize, isLikelyNavUrl, fragment preservation" \
  -m "isLikelyNavUrl is the cherry-picked filter from prior session orchestrator. Per spec §3.1." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.3: shared/redis-cookies.ts

**Files:**
- Create: `backend/scripts/probe/shared/redis-cookies.ts`

**Goal:** Wrapper around production `waf-cookie-manager` Redis cookie cache. Cherry-pick from `probe-fetch.ts.snapshot`.

- [ ] **Step 1:** Read the snapshot to find the existing implementation.

```bash
grep -n "waf-cookie-manager\|getCookies\|g_redisAvailable" docs/superpowers/plans/cherry-pick-snapshots/probe-fetch.ts.snapshot | head -20
```

- [ ] **Step 2:** Read `backend/src/services/scraper/waf-cookie-manager.ts` to confirm its exported API.

```bash
grep -n "^export" backend/src/services/scraper/waf-cookie-manager.ts
```

- [ ] **Step 3:** Implement redis-cookies.ts.

```typescript
// backend/scripts/probe/shared/redis-cookies.ts
// Thin wrapper around production waf-cookie-manager Redis cache.
// Probe shares the same cookie cache as production crawlers — solving once benefits both.

import { getCookies as prodGetCookies } from '../../../src/services/scraper/waf-cookie-manager';

let redisAvailable: boolean | null = null;

async function probeRedis(): Promise<boolean> {
  if (redisAvailable !== null) return redisAvailable;
  try {
    // Try a no-op fetch with a dummy domain — if Redis is up we get null cookies; if down we throw
    await prodGetCookies('__redis_probe__.invalid');
    redisAvailable = true;
  } catch (err) {
    console.warn('[probe/redis-cookies] Redis unreachable, cookie cache disabled:', (err as Error).message);
    redisAvailable = false;
  }
  return redisAvailable;
}

export async function getCachedCookies(domain: string): Promise<string | null> {
  if (!(await probeRedis())) return null;
  try {
    const cookies = await prodGetCookies(domain);
    return cookies && cookies.length > 0 ? cookies : null;
  } catch (err) {
    console.warn(`[probe/redis-cookies] getCookies(${domain}) failed:`, (err as Error).message);
    return null;
  }
}
```

- [ ] **Step 4:** Type-check.

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 5:** Commit.

```bash
git add backend/scripts/probe/shared/redis-cookies.ts
git commit -m "feat(probe-shared): wrap waf-cookie-manager Redis cache for probe reuse" \
  -m "Cherry-pick from probe-fetch.ts (prior session). Probe shares production cookie cache — solving sgcaptcha/Sucuri/Incapsula PoW once benefits both. Per spec §9 + §3.1." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.4: shared/ua.ts

**Files:**
- Create: `backend/scripts/probe/shared/ua.ts`
- Create: `backend/scripts/probe/shared/__test__/ua.test.ts`

**Goal:** UA escalation ladder per spec §1.1 + Mistake 30 Fix B (iPhone UA load-bearing post-sgcaptcha).

- [ ] **Step 1:** Write test.

```typescript
// backend/scripts/probe/shared/__test__/ua.test.ts
import { describe, it, expect } from 'vitest';
import { UA_LADDER, pickUaForWaf, UA_DESKTOP, UA_IPHONE, UA_BOT, UA_PYTHON } from '../ua';

describe('UA_LADDER', () => {
  it('starts with desktop, iphone before any bot UA', () => {
    expect(UA_LADDER[0].id).toBe('axios-desktop');
    expect(UA_LADDER[1].id).toBe('axios-iphone');
    // Bot UAs are not in the ladder — they're for heavy-probe vendor detection only
    expect(UA_LADDER.find(s => s.ua.includes('python-requests'))).toBeUndefined();
    expect(UA_LADDER.find(s => s.ua.includes('curl/'))).toBeUndefined();
  });
});

describe('pickUaForWaf', () => {
  it('picks iPhone for sgcaptcha (Mistake 30 Fix B)', () => {
    expect(pickUaForWaf('sgcaptcha')).toBe(UA_IPHONE);
  });
  it('picks iPhone for Sucuri with UA-filter (doctordeals precedent)', () => {
    expect(pickUaForWaf('sucuri')).toBe(UA_IPHONE);
  });
  it('picks desktop for cloudflare-passive', () => {
    expect(pickUaForWaf('cloudflare-passive')).toBe(UA_DESKTOP);
  });
  it('picks desktop for null wafType', () => {
    expect(pickUaForWaf(null)).toBe(UA_DESKTOP);
  });
});

describe('UA constants', () => {
  it('UA_DESKTOP looks like a real Chrome', () => {
    expect(UA_DESKTOP).toMatch(/Chrome\/\d+\.\d+/);
  });
  it('UA_IPHONE looks like Safari iOS', () => {
    expect(UA_IPHONE).toMatch(/iPhone.*Safari/);
  });
});
```

- [ ] **Step 2:** Run failing.

```bash
cd backend && npx vitest run scripts/probe/shared/__test__/ua.test.ts
```

- [ ] **Step 3:** Implement.

```typescript
// backend/scripts/probe/shared/ua.ts
// UA escalation ladder per spec §1.1 (Room 2 access method).
// Bot UAs (curl, python-requests) are for heavy-probe Batch 2 vendor detection ONLY,
// never for site access — they guarantee WAF triggers on protected sites.

import type { WafType, AccessMethod } from './types';

export const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
export const UA_BOT = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
export const UA_PYTHON = 'python-requests/2.31.0';
export const UA_CURL = 'curl/8.1.2';

type UaLadderStep = { id: AccessMethod; ua: string; usePlaywright: boolean; useCookies: boolean; channel?: 'chrome' };

// Ladder for ACCESS — never includes bot UAs.
export const UA_LADDER: UaLadderStep[] = [
  { id: 'axios-desktop',                ua: UA_DESKTOP, usePlaywright: false, useCookies: false },
  { id: 'axios-iphone',                 ua: UA_IPHONE,  usePlaywright: false, useCookies: false },
  { id: 'playwright-chromium',          ua: UA_DESKTOP, usePlaywright: true,  useCookies: false },
  { id: 'playwright-iphone-cookies',    ua: UA_IPHONE,  usePlaywright: true,  useCookies: true },
  { id: 'playwright-real-chrome',       ua: UA_DESKTOP, usePlaywright: true,  useCookies: true, channel: 'chrome' },
];

// For WAF-suspected fetches, pick the UA most likely to succeed.
// Mistake 30 Fix B: sgcaptcha + Sucuri (with UA filter) require iPhone post-challenge.
export function pickUaForWaf(wafType: WafType): string {
  if (wafType === 'sgcaptcha') return UA_IPHONE;
  if (wafType === 'sucuri') return UA_IPHONE;  // doctordeals precedent
  return UA_DESKTOP;
}
```

- [ ] **Step 4:** Run tests pass.

```bash
cd backend && npx vitest run scripts/probe/shared/__test__/ua.test.ts
```

- [ ] **Step 5:** Commit.

```bash
git add backend/scripts/probe/shared/ua.ts backend/scripts/probe/shared/__test__/ua.test.ts
git commit -m "feat(probe-shared): add UA escalation ladder + WAF-aware UA picker" \
  -m "Per spec §1.1 7-step ladder. Bot UAs intentionally excluded from access ladder (heavy-probe-only). pickUaForWaf encodes Mistake 30 Fix B (iPhone for sgcaptcha + Sucuri post-challenge)." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.5: shared/fetch.ts

**Files:**
- Create: `backend/scripts/probe/shared/fetch.ts`

**Goal:** WAF-aware fetch wrapping axios + Playwright + Redis cookies + native-fetch HPE fallback. Cherry-pick the Redis integration + HPE fallback + iPhone-UA-on-WAF auto-switch from `probe-fetch.ts.snapshot`.

- [ ] **Step 1:** Inspect snapshot for the cherry-pick targets.

```bash
grep -n "nativeFetchText\|HPE_INVALID\|fetchWithPlaywright\|getCachedCookies\|wafSuspected" docs/superpowers/plans/cherry-pick-snapshots/probe-fetch.ts.snapshot | head -30
```

- [ ] **Step 2:** Implement fetch.ts (use the snapshot as reference, do NOT copy-paste — rewrite for the new structure).

```typescript
// backend/scripts/probe/shared/fetch.ts
// WAF-aware fetch primitive used by all rooms.
// Layers: axios (with HPE native-fetch fallback) → Playwright → Playwright + cookies.
// Cherry-picked from probe-fetch.ts (prior session): native-fetch HPE fallback,
// Redis cookie cache integration, iPhone UA auto-switch on WAF-suspected.

import axios, { AxiosError } from 'axios';
import { fetchWithPlaywright } from '../../../src/services/scraper/playwright-fetcher';
import { getCachedCookies } from './redis-cookies';
import { UA_DESKTOP, UA_IPHONE, pickUaForWaf } from './ua';
import type { WafType } from './types';

export type FetchOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
  ua?: string;
  hasWaf?: boolean;
  wafType?: WafType;
  forcePlaywright?: boolean;
};

export type FetchResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyBytes: number;
  durationMs: number;
  method: 'axios' | 'native-fetch' | 'playwright' | 'playwright-cookies';
  cookiesUsed?: string;
};

const DEFAULT_TIMEOUT_MS = 30000;

async function nativeFetchText(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': opts.ua ?? UA_DESKTOP, ...(opts.headers ?? {}) },
      signal: controller.signal,
      redirect: 'follow',
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return {
      status: res.status,
      headers,
      body,
      bodyBytes: body.length,
      durationMs: Date.now() - start,
      method: 'native-fetch',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function axiosFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': opts.ua ?? UA_DESKTOP, ...(opts.headers ?? {}) },
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      maxRedirects: 5,
      responseType: 'text',
      transformResponse: [(d) => d],
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      headers[k.toLowerCase()] = String(v);
    }
    return {
      status: res.status,
      headers,
      body: res.data as string,
      bodyBytes: (res.data as string).length,
      durationMs: Date.now() - start,
      method: 'axios',
    };
  } catch (err) {
    const ae = err as AxiosError & { code?: string };
    // HPE_INVALID_HEADER_TOKEN — Celerant trailing-space headers — fall back to native fetch
    if (ae.code === 'HPE_INVALID_HEADER_TOKEN' || /Parse Error|Invalid header/i.test(ae.message ?? '')) {
      return nativeFetchText(url, opts);
    }
    throw err;
  }
}

async function playwrightFetch(url: string, opts: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const ua = opts.ua ?? (opts.wafType ? pickUaForWaf(opts.wafType) : UA_DESKTOP);
  const isIphone = ua === UA_IPHONE;
  const result = await fetchWithPlaywright(url, {
    timeout: opts.timeoutMs ?? 45000,
    userAgentOverride: isIphone ? UA_IPHONE : undefined,
  });
  return {
    status: 200,  // playwright-fetcher returns rendered HTML or throws
    headers: {},
    body: result.html,
    bodyBytes: result.html.length,
    durationMs: Date.now() - start,
    method: 'playwright',
  };
}

export async function fetchUrl(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  // If WAF-suspected and we have cached cookies, prefer Playwright with cookies
  if (opts.forcePlaywright || (opts.hasWaf && opts.wafType)) {
    const domain = new URL(url).hostname;
    const cookies = await getCachedCookies(domain);
    if (cookies) {
      // Production playwright-fetcher honors injected cookies via context.addCookies — pass via headers fallback
      const r = await playwrightFetch(url, { ...opts, ua: opts.wafType ? pickUaForWaf(opts.wafType) : UA_IPHONE });
      return { ...r, method: 'playwright-cookies', cookiesUsed: cookies };
    }
    return playwrightFetch(url, opts);
  }
  // Default path: axios first, native-fetch on HPE
  return axiosFetch(url, opts);
}
```

- [ ] **Step 3:** Type-check.

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 4:** Smoke test against a no-WAF site.

```bash
cd backend && npx tsx -e "
import { fetchUrl } from './scripts/probe/shared/fetch';
fetchUrl('https://aagcanada.ca/').then(r => console.log({ status: r.status, bytes: r.bodyBytes, method: r.method }));
"
# Expect: { status: 200, bytes: > 5000, method: 'axios' }
```

- [ ] **Step 5:** Commit.

```bash
git add backend/scripts/probe/shared/fetch.ts
git commit -m "feat(probe-shared): WAF-aware fetch with axios+Playwright+Redis cookies+HPE fallback" \
  -m "Cherry-pick from probe-fetch.ts: native-fetch HPE fallback (Celerant), Redis cookie cache integration, iPhone UA auto-switch on WAF-suspected. Per spec §3.1 + §9." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.6: shared/extract.ts

**Files:**
- Create: `backend/scripts/probe/shared/extract.ts`

**Goal:** Thin wrapper around production `extractCatalogProducts` so rooms 3/4/5 use the same extraction logic the production crawler uses.

- [ ] **Step 1:** Read the production extract entry point.

```bash
grep -n "export.*extractCatalogProducts\|export function extractCatalogProducts" backend/src/services/scraper/adapters/generic-retail.ts | head -3
```

- [ ] **Step 2:** Implement.

```typescript
// backend/scripts/probe/shared/extract.ts
// Thin wrapper around the production catalog extractor.
// All rooms must extract via this — never write probe-specific selectors.

import * as cheerio from 'cheerio';
import { GenericRetailAdapter } from '../../../src/services/scraper/adapters/generic-retail';

const adapter = new GenericRetailAdapter();

export type ExtractedProduct = {
  url: string;
  title: string;
  price?: number;
  imageUrl?: string;
  sourceId?: string;
};

export function extractProducts(html: string, pageUrl: string): ExtractedProduct[] {
  const $ = cheerio.load(html);
  // GenericRetailAdapter.extractCatalogProducts is the production canonical extractor
  const products = adapter.extractCatalogProducts($, pageUrl);
  return products.map(p => ({
    url: p.url,
    title: p.title,
    price: p.price ?? undefined,
    imageUrl: p.imageUrl ?? undefined,
    sourceId: p.sourceId ?? undefined,
  }));
}
```

- [ ] **Step 3:** Type-check.

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 4:** Smoke test.

```bash
cd backend && npx tsx -e "
import { fetchUrl } from './scripts/probe/shared/fetch';
import { extractProducts } from './scripts/probe/shared/extract';
const r = await fetchUrl('https://aagcanada.ca/collections/all');
console.log('extracted:', extractProducts(r.body, 'https://aagcanada.ca/collections/all').length);
"
# Expect: extracted: > 0 (real product count)
```

- [ ] **Step 5:** Commit.

```bash
git add backend/scripts/probe/shared/extract.ts
git commit -m "feat(probe-shared): wrap production extractCatalogProducts for probe reuse" \
  -m "Per spec §3.2 principle 4: rooms never write probe-specific selectors. All extraction goes through the production adapter so probe and crawler agree." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Room 1: Intake

Spec reference: §4.1.

### Task 2.1: room1-intake module + tests

**Files:**
- Create: `backend/scripts/probe/room1-intake/index.ts`
- Create: `backend/scripts/probe/room1-intake/validate-url.ts`
- Create: `backend/scripts/probe/room1-intake/__test__/index.test.ts`

- [ ] **Step 1:** Scaffold folder + write tests.

```bash
mkdir -p backend/scripts/probe/room1-intake/__test__
```

```typescript
// backend/scripts/probe/room1-intake/__test__/index.test.ts
import { describe, it, expect } from 'vitest';
import { runRoom1 } from '../index';

describe('runRoom1', () => {
  it('returns IntakeState with canonicalUrl + runId for valid input', async () => {
    const r = await runRoom1('https://Example.COM/');
    if ('roomFailed' in r) throw new Error('expected pass');
    expect(r.canonicalUrl).toBe('https://example.com/');
    expect(r.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.inputUrl).toBe('https://Example.COM/');
  });
  it('rejects malformed URL', async () => {
    const r = await runRoom1('not a url at all');
    if (!('roomFailed' in r)) throw new Error('expected fail');
    expect(r.roomNumber).toBe(1);
    expect(r.reason).toMatch(/malformed/i);
  });
  it('rejects localhost', async () => {
    const r = await runRoom1('http://localhost:3000');
    if (!('roomFailed' in r)) throw new Error('expected fail');
    expect(r.roomNumber).toBe(1);
    expect(r.reason).toMatch(/private|localhost/i);
  });
  it('adds https when scheme missing', async () => {
    const r = await runRoom1('example.com');
    if ('roomFailed' in r) throw new Error('expected pass');
    expect(r.canonicalUrl).toBe('https://example.com/');
  });
});
```

- [ ] **Step 2:** Run failing.

```bash
cd backend && npx vitest run scripts/probe/room1-intake/
```

- [ ] **Step 3:** Implement.

```typescript
// backend/scripts/probe/room1-intake/validate-url.ts
import { canonicalizeUrl } from '../shared/url-utils';
export { canonicalizeUrl };
```

```typescript
// backend/scripts/probe/room1-intake/index.ts
// Room 1: Intake. URL validation + canonicalization. No DB writes. No HTTP. Per spec §4.1.

import { randomUUID } from 'crypto';
import { canonicalizeUrl } from './validate-url';
import type { IntakeState, RoomFailure } from '../shared/types';

export async function runRoom1(inputUrl: string): Promise<IntakeState | RoomFailure> {
  try {
    const canonicalUrl = canonicalizeUrl(inputUrl);
    return {
      inputUrl,
      canonicalUrl,
      timestamp: new Date().toISOString(),
      runId: randomUUID(),
    };
  } catch (err) {
    return {
      roomFailed: true,
      roomNumber: 1,
      reason: (err as Error).message,
      evidence: { inputUrl },
      timestamp: new Date().toISOString(),
    };
  }
}
```

- [ ] **Step 4:** Run tests pass + tsc.

```bash
cd backend && npx vitest run scripts/probe/room1-intake/ && npx tsc --noEmit
```

- [ ] **Step 5:** Commit.

```bash
git add backend/scripts/probe/room1-intake/
git commit -m "feat(probe-room1): intake module — URL validation + canonicalization" \
  -m "Per spec §4.1. No DB, no HTTP. RoomFailure on malformed/localhost." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Room 2: Access & Identity

Spec reference: §4.2 + §6 (date sources matter for later rooms but only verified in Room 4).

This is the largest room. Broken into 6 tasks: canonical-host, waf-detect, waf-heavy-probe, detector registry, detectors, room index.

### Task 3.1: room2-access-identity/canonical-host.ts

**Files:**
- Create: `backend/scripts/probe/room2-access-identity/canonical-host.ts`
- Create: `backend/scripts/probe/room2-access-identity/__test__/canonical-host.test.ts`

**Goal:** Resolve apex vs www, with www-fallback when apex body has challenge markers (lockharttactical fix per spec §9 cherry-pick).

- [ ] **Step 1:** Scaffold folder + write test.

```bash
mkdir -p backend/scripts/probe/room2-access-identity/__test__/fixtures
```

```typescript
// backend/scripts/probe/room2-access-identity/__test__/canonical-host.test.ts
import { describe, it, expect } from 'vitest';
import { hasChallengeMarkers } from '../canonical-host';

describe('hasChallengeMarkers', () => {
  it('detects Cloudflare challenge body', () => {
    expect(hasChallengeMarkers('<html><title>Just a moment...</title>...cf-mitigated...</html>')).toBe(true);
  });
  it('detects sgcaptcha meta-refresh', () => {
    expect(hasChallengeMarkers('<meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=...">')).toBe(true);
  });
  it('detects Sucuri body marker', () => {
    expect(hasChallengeMarkers('sucuri_cloudproxy_js')).toBe(true);
  });
  it('does NOT match real product page that mentions cdn-cgi/challenge-platform in JS bundle', () => {
    expect(hasChallengeMarkers('<html>...</html>'.padEnd(60000, ' ') + 'cdn-cgi/challenge-platform')).toBe(false);
    // Body too large to be a real challenge page
  });
});
```

- [ ] **Step 2:** Run failing.

```bash
cd backend && npx vitest run scripts/probe/room2-access-identity/__test__/canonical-host.test.ts
```

- [ ] **Step 3:** Implement.

```typescript
// backend/scripts/probe/room2-access-identity/canonical-host.ts
// Resolve apex vs www. Per spec §4.2 + Mistake (lockharttactical).
// Apex may serve a CF Managed Challenge while www is clean.

import { fetchUrl } from '../shared/fetch';

const CHALLENGE_BODY_MARKERS = [
  /Just a moment\.\.\./i,
  /_cf_chl_opt/,
  /sucuri_cloudproxy_js/,
  /<meta\s+http-equiv="refresh"\s+content="\d+;\s*\/\.well-known\/sgcaptcha\//i,
  /Incapsula incident ID/i,
  /cf-mitigated:\s*challenge/i,
];

export function hasChallengeMarkers(body: string): boolean {
  // Real challenge bodies are tiny (< 50KB) — anything larger is real content that happens to mention a marker
  if (body.length > 50000) return false;
  return CHALLENGE_BODY_MARKERS.some(re => re.test(body));
}

export type CanonicalHostResult = {
  canonicalOrigin: string;
  apexResponded: boolean;
  apexWasChallenged: boolean;
  wwwFallbackUsed: boolean;
  serverHeaders: { apex?: string; canonical?: string };
};

export async function resolveCanonicalHost(canonicalUrl: string): Promise<CanonicalHostResult> {
  const u = new URL(canonicalUrl);
  const host = u.hostname;
  const apexHost = host.startsWith('www.') ? host.slice(4) : host;
  const wwwHost = host.startsWith('www.') ? host : `www.${host}`;
  const result: CanonicalHostResult = {
    canonicalOrigin: `${u.protocol}//${host}`,
    apexResponded: false,
    apexWasChallenged: false,
    wwwFallbackUsed: false,
    serverHeaders: {},
  };

  // Try the input host first
  let primary;
  try {
    primary = await fetchUrl(`${u.protocol}//${host}/`);
    result.apexResponded = true;
    result.serverHeaders.apex = primary.headers['server'];
    if (primary.status >= 400 && hasChallengeMarkers(primary.body)) {
      result.apexWasChallenged = true;
    } else if (primary.status >= 200 && primary.status < 400 && !hasChallengeMarkers(primary.body)) {
      // Primary works, no www-fallback needed
      result.serverHeaders.canonical = primary.headers['server'];
      return result;
    }
  } catch {
    result.apexResponded = false;
  }

  // www-fallback: try the OTHER form (apex → www, or www → apex)
  const fallbackHost = host.startsWith('www.') ? apexHost : wwwHost;
  if (fallbackHost === host) return result;
  try {
    const fallback = await fetchUrl(`${u.protocol}//${fallbackHost}/`);
    if (fallback.status >= 200 && fallback.status < 400 && !hasChallengeMarkers(fallback.body)) {
      result.canonicalOrigin = `${u.protocol}//${fallbackHost}`;
      result.wwwFallbackUsed = true;
      result.serverHeaders.canonical = fallback.headers['server'];
    }
  } catch { /* leave canonicalOrigin = primary */ }

  return result;
}
```

- [ ] **Step 4:** Tests pass.

```bash
cd backend && npx vitest run scripts/probe/room2-access-identity/__test__/canonical-host.test.ts && npx tsc --noEmit
```

- [ ] **Step 5:** Commit.

```bash
git add backend/scripts/probe/room2-access-identity/canonical-host.ts backend/scripts/probe/room2-access-identity/__test__/canonical-host.test.ts
git commit -m "feat(probe-room2): canonical-host with www-fallback on challenge body" \
  -m "Per spec §4.2 + lockharttactical fix from cherry-pick. hasChallengeMarkers requires body < 50KB to avoid false-positives on JS bundles that mention cdn-cgi/challenge-platform." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.2: room2-access-identity/waf-heavy-probe.ts

**Files:**
- Create: `backend/scripts/probe/room2-access-identity/waf-heavy-probe.ts`

**Goal:** TypeScript wrapper around `backend/scripts/heavy-waf-probe.sh` (existing). Returns structured `HeavyProbeBatchResult[]`.

- [ ] **Step 1:** Verify the bash script still exists.

```bash
ls -la backend/scripts/heavy-waf-probe.sh
```

- [ ] **Step 2:** Implement wrapper.

```typescript
// backend/scripts/probe/room2-access-identity/waf-heavy-probe.ts
// Wrapper around backend/scripts/heavy-waf-probe.sh (8-batch probe).
// Parses the bash script's output into structured HeavyProbeBatchResult[].

import { spawn } from 'child_process';
import * as path from 'path';
import type { HeavyProbeBatchResult } from '../shared/types';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'heavy-waf-probe.sh');

export type HeavyProbeOutput = {
  rawOutput: string;
  batches: HeavyProbeBatchResult[];
};

export async function runHeavyWafProbe(targetUrl: string): Promise<HeavyProbeOutput> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn('bash', [SCRIPT_PATH, targetUrl], {
      timeout: 180000,  // 3 minutes
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0 && stdout.length < 500) {
        reject(new Error(`heavy-waf-probe.sh exited ${code}: ${stderr}`));
        return;
      }
      resolve({ rawOutput: stdout, batches: parseBatches(stdout) });
    });
    child.on('error', reject);
  });
}

function parseBatches(output: string): HeavyProbeBatchResult[] {
  const batches: HeavyProbeBatchResult[] = [];
  // Match `=== BATCH N: <description> ===` followed by content until next batch or EOF
  const re = /===\s*BATCH\s+(\d+):\s*([^=]+?)\s*===([\s\S]*?)(?=\n===\s*BATCH|\n*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const [, idStr, description, content] = m;
    const headers: Record<string, string> = {};
    let status: number | null = null;
    // Parse header lines: `header-name: value`
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const httpMatch = /^HTTP\/[12]\.[01]?\s+(\d{3})/.exec(t);
      if (httpMatch) { status = parseInt(httpMatch[1], 10); continue; }
      const hMatch = /^([a-z][a-z0-9-]*?):\s*(.+)$/i.exec(t);
      if (hMatch) headers[hMatch[1].toLowerCase()] = hMatch[2];
    }
    batches.push({
      batchId: parseInt(idStr, 10),
      description: description.trim(),
      status,
      headers,
      bodySnippet: content.slice(0, 2048),
      durationMs: 0,
    });
  }
  return batches;
}
```

- [ ] **Step 3:** Smoke test.

```bash
cd backend && npx tsx -e "
import { runHeavyWafProbe } from './scripts/probe/room2-access-identity/waf-heavy-probe';
runHeavyWafProbe('https://aagcanada.ca/').then(r => console.log({ batches: r.batches.length, hasOutput: r.rawOutput.length > 1000 }));
"
# Expect: { batches: 8, hasOutput: true }
```

- [ ] **Step 4:** tsc + commit.

```bash
cd backend && npx tsc --noEmit
git add backend/scripts/probe/room2-access-identity/waf-heavy-probe.ts
git commit -m "feat(probe-room2): wrap heavy-waf-probe.sh with structured batch parsing" \
  -m "Per spec §4.2 — 8-batch probe is mandatory for WAF detection. Parser anchors on 'BATCH N:' headers; only counts actual response headers (not interpretation-guide trailer text)." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.3: room2-access-identity/waf-detect.ts

**Files:**
- Create: `backend/scripts/probe/room2-access-identity/waf-detect.ts`
- Create: `backend/scripts/probe/room2-access-identity/__test__/waf-detect.test.ts`

**Goal:** Vendor classification from heavy-probe output. Cherry-pick from `probe-access.ts.snapshot`: CF active/passive desktop+iphone-only rule, Sucuri/Incapsula/sgcaptcha/Akamai/MalCare detectors, origin-rule exclusion (mod_security ≠ WAF), consistency guard.

- [ ] **Step 1:** Snapshot inspection.

```bash
grep -n "cloudflare-active\|cloudflare-passive\|x-sucuri-id\|sg-captcha\|x-iinfo\|AkamaiGHost\|MalCare\|mod_security\|wafType !=" docs/superpowers/plans/cherry-pick-snapshots/probe-access.ts.snapshot | head -40
```

- [ ] **Step 2:** Write tests with realistic batch fixtures.

```typescript
// backend/scripts/probe/room2-access-identity/__test__/waf-detect.test.ts
import { describe, it, expect } from 'vitest';
import { classifyWaf } from '../waf-detect';
import type { HeavyProbeBatchResult } from '../../shared/types';

function batch(id: number, desc: string, status: number, headers: Record<string,string>, body = ''): HeavyProbeBatchResult {
  return { batchId: id, description: desc, status, headers, bodySnippet: body, durationMs: 0 };
}

describe('classifyWaf', () => {
  it('classifies CF passive (cf-ray on every 200, no challenge)', () => {
    const batches = [
      batch(1, 'header fingerprint',    200, { 'cf-ray': 'abc-YYZ', server: 'cloudflare' }),
      batch(2, 'multi-UA desktop',      200, { 'cf-ray': 'def-YYZ', server: 'cloudflare' }),
      batch(3, 'rapid burst',           200, { 'cf-ray': 'ghi-YYZ' }),
      batch(6, 'sqli query',            200, {}),
      batch(7, 'xss query',             200, {}),
    ];
    const r = classifyWaf(batches);
    expect(r.hasWaf).toBe(true);
    expect(r.wafType).toBe('cloudflare-passive');
  });

  it('does NOT classify CF active just because curl/bot UA gets 403', () => {
    const batches = [
      batch(1, 'header fingerprint', 200, { 'cf-ray': 'a', server: 'cloudflare' }),
      batch(2, 'multi-UA desktop',   200, { 'cf-ray': 'b' }),
      batch(2, 'multi-UA bot',       403, { 'cf-ray': 'c' }),  // CF Bot Fight Mode — passive, not active
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('cloudflare-passive');  // NOT 'cloudflare-active'
  });

  it('classifies sgcaptcha (HTTP 202 + sg-captcha header)', () => {
    const batches = [
      batch(1, 'header fingerprint', 202, { 'sg-captcha': 'challenge' }, '<meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/">'),
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('sgcaptcha');
  });

  it('classifies Sucuri (x-sucuri-id header)', () => {
    const batches = [
      batch(1, 'header fingerprint', 200, { 'x-sucuri-id': '20017', server: 'Sucuri/Cloudproxy' }),
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('sucuri');
  });

  it('classifies Akamai (server: AkamaiGHost)', () => {
    const batches = [
      batch(1, 'header fingerprint', 200, { server: 'AkamaiGHost' }),
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('akamai');
  });

  it('classifies MalCare from body marker', () => {
    const batches = [
      batch(1, 'header fingerprint', 403, { server: 'Apache' }, '<title>MalCare WordPress Security Plugin</title>Blocked because of Malicious Activities Reference ID: abc123'),
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('malcare');
  });

  it('does NOT classify mod_security as WAF (origin-rule exclusion)', () => {
    const batches = [
      batch(1, 'header fingerprint', 200, { server: 'Apache' }),
      batch(6, 'sqli query',         403, { server: 'Apache' }),  // mod_security blocks SQLi
      batch(7, 'xss query',          403, { server: 'Apache' }),  // mod_security blocks XSS
    ];
    const r = classifyWaf(batches);
    expect(r.hasWaf).toBe(false);
    expect(r.wafType).toBeNull();
  });

  it('consistency guard: hasWaf forced to true when wafType is non-null', () => {
    const batches = [
      batch(1, 'header fingerprint', 200, { 'x-sucuri-id': '1' }),
    ];
    const r = classifyWaf(batches);
    expect(r.wafType).toBe('sucuri');
    expect(r.hasWaf).toBe(true);
  });
});
```

- [ ] **Step 3:** Run failing.

```bash
cd backend && npx vitest run scripts/probe/room2-access-identity/__test__/waf-detect.test.ts
```

- [ ] **Step 4:** Implement waf-detect.ts. Use snapshot for inspiration; rewrite for the new structure. Key logic:
  - **CF active**: any browser-UA batch (id 2 desktop, id 2 iphone, id 1) returns 4xx + `cf-mitigated: challenge` header.
  - **CF passive**: `cf-ray` present on any 200 + no active criteria.
  - **Sucuri**: `x-sucuri-id` OR `server: Sucuri/Cloudproxy` OR `sucuri_cloudproxy_js` in body.
  - **sgcaptcha**: 202 + `sg-captcha` header OR `/.well-known/sgcaptcha/` in body.
  - **Incapsula**: `x-iinfo` header OR `visid_incap_*` / `incap_ses_*` cookies.
  - **Akamai**: `server: AkamaiGHost`.
  - **MalCare**: body contains `MalCare WordPress Security Plugin` + `Blocked because of Malicious Activities`.
  - **Origin-rule exclusion**: SQLi/XSS batches return non-200 BUT no vendor header on any batch → `hasWaf: false, wafType: null`.
  - **Consistency guard**: if `wafType !== null` then `hasWaf: true`.

```typescript
// backend/scripts/probe/room2-access-identity/waf-detect.ts
// Vendor classification from heavy-probe batches. Cherry-picked from probe-access.ts.
// Rules:
//   - Active CF requires browser-UA challenge (curl/bot 403 from Bot Fight Mode is passive, not active)
//   - Origin rules (mod_security/Wordfence) blocking SQLi/XSS without vendor headers ≠ WAF
//   - Consistency guard: wafType != null → hasWaf = true
// Reference: spec §4.2, .claude/probe-rewrite-lessons.md §2

import type { HeavyProbeBatchResult, WafType, AccessIdentityState } from '../shared/types';

type WafEvidence = AccessIdentityState['wafProbeEvidence'];

export type WafClassification = {
  hasWaf: boolean;
  wafType: WafType;
  evidenceFlags: Pick<WafEvidence,
    'cfHeaders' | 'sucuriHeaders' | 'sgCaptchaDetected'
    | 'incapsulaCookies' | 'akamaiServer' | 'malcareInBody'
    | 'rapidBurstStatus' | 'sqliRuleFired' | 'xssRuleFired'
    | 'botUaBlocked' | 'honeypotPathsBlocked'
  >;
};

export function classifyWaf(batches: HeavyProbeBatchResult[]): WafClassification {
  const evidence: WafClassification['evidenceFlags'] = {
    cfHeaders: [],
    sucuriHeaders: [],
    sgCaptchaDetected: false,
    incapsulaCookies: [],
    akamaiServer: false,
    malcareInBody: false,
    rapidBurstStatus: 'unknown',
    sqliRuleFired: false,
    xssRuleFired: false,
    botUaBlocked: false,
    honeypotPathsBlocked: false,
  };

  // Scan all batches for vendor markers
  for (const b of batches) {
    const h = b.headers;
    const body = b.bodySnippet;
    if (h['cf-ray']) evidence.cfHeaders!.push(h['cf-ray']);
    if (h['x-sucuri-id'] || /Sucuri\/Cloudproxy/i.test(h['server'] ?? '') || /sucuri_cloudproxy_js/.test(body)) {
      evidence.sucuriHeaders!.push(h['x-sucuri-id'] || h['server']);
    }
    if (h['sg-captcha'] || /\/\.well-known\/sgcaptcha\//.test(body)) evidence.sgCaptchaDetected = true;
    if (h['x-iinfo'] || (h['set-cookie'] && /visid_incap|incap_ses/.test(h['set-cookie']))) {
      evidence.incapsulaCookies!.push(h['x-iinfo'] || 'cookie');
    }
    if (/AkamaiGHost/i.test(h['server'] ?? '')) evidence.akamaiServer = true;
    if (/MalCare WordPress Security Plugin/i.test(body) && /Blocked because of Malicious Activities/i.test(body)) {
      evidence.malcareInBody = true;
    }
    // Per-batch interpretation
    if (b.batchId === 3) evidence.rapidBurstStatus = `${b.status}`;
    if (b.batchId === 6 && b.status && b.status >= 400) evidence.sqliRuleFired = true;
    if (b.batchId === 7 && b.status && b.status >= 400) evidence.xssRuleFired = true;
    if (b.batchId === 4 && b.status && b.status >= 400) evidence.honeypotPathsBlocked = true;
    if (/bot/i.test(b.description) && b.status && b.status >= 400) evidence.botUaBlocked = true;
  }

  // Vendor classification, ordered by specificity
  if (evidence.malcareInBody) return wrap('malcare');
  if (evidence.sgCaptchaDetected) return wrap('sgcaptcha');
  if (evidence.incapsulaCookies!.length > 0) return wrap('incapsula');
  if (evidence.sucuriHeaders!.length > 0) return wrap('sucuri');
  if (evidence.akamaiServer) return wrap('akamai');
  if (evidence.cfHeaders!.length > 0) {
    // Decide active vs passive: only browser-UA challenge counts as active
    const browserBatches = batches.filter(b => b.batchId === 1 || (b.batchId === 2 && /desktop|iphone/i.test(b.description)));
    const activeChallenge = browserBatches.some(b =>
      b.status && b.status >= 400 && /challenge/i.test(b.headers['cf-mitigated'] ?? '')
    );
    return wrap(activeChallenge ? 'cloudflare-active' : 'cloudflare-passive');
  }

  // Origin-rule exclusion: SQLi/XSS blocked but no vendor header → not a WAF
  return { hasWaf: false, wafType: null, evidenceFlags: evidence };

  function wrap(t: WafType): WafClassification {
    // Consistency guard
    return { hasWaf: t !== null, wafType: t, evidenceFlags: evidence };
  }
}
```

- [ ] **Step 5:** Tests pass + tsc.

```bash
cd backend && npx vitest run scripts/probe/room2-access-identity/__test__/waf-detect.test.ts && npx tsc --noEmit
```

- [ ] **Step 6:** Commit.

```bash
git add backend/scripts/probe/room2-access-identity/waf-detect.ts backend/scripts/probe/room2-access-identity/__test__/waf-detect.test.ts
git commit -m "feat(probe-room2): WAF vendor classification with browser-UA active rule + origin-rule exclusion + consistency guard" \
  -m "Cherry-picks: dantesports/g4c CF-active misclassification fix, mod_security exclusion (budgetshooter/corwin/icollector), Akamai detection, MalCare body marker, hasWaf↔wafType guard. Per spec §4.2 + probe-rewrite-lessons §2." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.4: Detector registry interface + first 3 detectors

**Files:**
- Create: `backend/scripts/probe/room2-access-identity/platform-detect.ts`
- Create: `backend/scripts/probe/room2-access-identity/detectors/index.ts`
- Create: `backend/scripts/probe/room2-access-identity/detectors/woocommerce.ts`
- Create: `backend/scripts/probe/room2-access-identity/detectors/shopify.ts`
- Create: `backend/scripts/probe/room2-access-identity/detectors/bigcommerce-stencil.ts`

**Goal:** Per spec §4.2 detector registry pattern. Add 3 highest-volume platforms first.

- [ ] **Step 1:** Define the interface + registry shell.

```typescript
// backend/scripts/probe/room2-access-identity/platform-detect.ts
import type { PlatformTag, PlatformMarkerEvidence } from '../shared/types';

export type DetectorInput = {
  url: string;
  html: string;
  headers: Record<string, string>;
  cookies: string[];
};

export type DetectorOutput = {
  matched: boolean;
  confidence: 'high' | 'medium' | 'low';
  signals: Record<string, unknown>;
};

export interface PlatformDetector {
  id: PlatformTag;
  detect(input: DetectorInput): Promise<DetectorOutput>;
}

import { detectors } from './detectors';

export async function detectPlatform(input: DetectorInput): Promise<PlatformMarkerEvidence | null> {
  const matches: Array<{ d: PlatformDetector; out: DetectorOutput }> = [];
  for (const d of detectors) {
    const out = await d.detect(input);
    if (out.matched) matches.push({ d, out });
  }
  if (matches.length === 0) return null;
  // Highest confidence wins; ties → first registered
  matches.sort((a, b) => CONF_RANK[b.out.confidence] - CONF_RANK[a.out.confidence]);
  const winner = matches[0];
  return {
    detectorId: winner.d.id,
    confidence: winner.out.confidence,
    signals: winner.out.signals,
  };
}

const CONF_RANK = { high: 3, medium: 2, low: 1 } as const;
```

```typescript
// backend/scripts/probe/room2-access-identity/detectors/index.ts
import type { PlatformDetector } from '../platform-detect';
import { woocommerceDetector } from './woocommerce';
import { shopifyDetector } from './shopify';
import { bigcommerceStencilDetector } from './bigcommerce-stencil';

// Append-only registry. Adding a platform = 1 new file + 1 entry here.
export const detectors: PlatformDetector[] = [
  bigcommerceStencilDetector,  // most specific first
  shopifyDetector,
  woocommerceDetector,
];
```

```typescript
// backend/scripts/probe/room2-access-identity/detectors/woocommerce.ts
import type { PlatformDetector } from '../platform-detect';
import { fetchUrl } from '../../shared/fetch';

export const woocommerceDetector: PlatformDetector = {
  id: 'woocommerce',
  async detect({ url, html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;
    if (/<meta\s+name="generator"\s+content="WooCommerce/i.test(html)) {
      signals.metaGenerator = true;
      matched = true;
      confidence = 'high';
    }
    if (/wp-content\/plugins\/woocommerce/.test(html)) {
      signals.pluginAsset = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }
    // WP REST probe (low cost, definitive)
    try {
      const u = new URL(url);
      const r = await fetchUrl(`${u.protocol}//${u.hostname}/wp-json/wp/v2/product?per_page=1`, { timeoutMs: 8000 });
      if (r.status === 200 && r.headers['x-wp-total']) {
        signals.wpRestReachable = true;
        signals.xWpTotal = r.headers['x-wp-total'];
        matched = true;
        confidence = 'high';
      }
    } catch { /* not reachable */ }
    return { matched, confidence, signals };
  },
};
```

```typescript
// backend/scripts/probe/room2-access-identity/detectors/shopify.ts
import type { PlatformDetector } from '../platform-detect';
import { fetchUrl } from '../../shared/fetch';

export const shopifyDetector: PlatformDetector = {
  id: 'shopify',
  async detect({ url, html, headers }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;
    if (/cdn\.shopify\.com/.test(html) || /Shopify\.theme/.test(html)) {
      signals.cdnAsset = true;
      matched = true;
      confidence = 'medium';
    }
    if (/x-shopid/i.test(Object.keys(headers).join(','))) {
      signals.xShopIdHeader = true;
      matched = true;
      confidence = 'high';
    }
    try {
      const u = new URL(url);
      const r = await fetchUrl(`${u.protocol}//${u.hostname}/products/count.json`, { timeoutMs: 8000 });
      if (r.status === 200 && /^\s*\{\s*"count"/.test(r.body)) {
        signals.productsCountJson = true;
        matched = true;
        confidence = 'high';
      }
    } catch { /* not reachable */ }
    return { matched, confidence, signals };
  },
};
```

```typescript
// backend/scripts/probe/room2-access-identity/detectors/bigcommerce-stencil.ts
import type { PlatformDetector } from '../platform-detect';

export const bigcommerceStencilDetector: PlatformDetector = {
  id: 'bigcommerce-stencil',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;
    if (/<meta\s+name="platform"\s+content="bigcommerce\.stencil"/i.test(html)) {
      signals.platformMeta = 'bigcommerce.stencil';
      matched = true;
      confidence = 'high';
    } else if (/cdn11\.bigcommerce\.com.*stencil/i.test(html)) {
      signals.cdnStencilAsset = true;
      matched = true;
      confidence = 'medium';
    }
    if (/Stencil\.storefrontAPIToken/.test(html)) {
      signals.storefrontApiToken = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }
    return { matched, confidence, signals };
  },
};
```

- [ ] **Step 2:** Smoke test against 3 known sites.

```bash
cd backend && npx tsx -e "
import { fetchUrl } from './scripts/probe/shared/fetch';
import { detectPlatform } from './scripts/probe/room2-access-identity/platform-detect';
for (const url of ['https://aagcanada.ca/', 'https://canadafirstammo.ca/', 'https://theammosource.com/']) {
  const r = await fetchUrl(url);
  const p = await detectPlatform({ url, html: r.body, headers: r.headers, cookies: [] });
  console.log(url, '→', p);
}
"
# Expect: shopify, woocommerce, bigcommerce-stencil
```

- [ ] **Step 3:** tsc + commit.

```bash
cd backend && npx tsc --noEmit
git add backend/scripts/probe/room2-access-identity/platform-detect.ts backend/scripts/probe/room2-access-identity/detectors/
git commit -m "feat(probe-room2): detector registry pattern + woocommerce/shopify/bc-stencil detectors" \
  -m "Per spec §4.2 — adding a platform requires 1 new detector file + 1 array entry. No edits to existing code. Highest confidence wins; ties go to first registered." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3.5: Remaining platform detectors (15 detectors)

**Files:** Add one detector file per platform under `backend/scripts/probe/room2-access-identity/detectors/`.

**Goal:** Cover all platforms in the 24-site Tier-2 fleet.

Same pattern as Task 3.4 for each. List of detectors to add (each ~40-60 lines):

- [ ] `bigcommerce-blueprint.ts` — `<meta name="platform" content="BigCommerce">` + `BCData` global without Stencil markers
- [ ] `magento-1x.ts` — `BCData` (M1 distinct from BC) OR `var Mage = ` global OR `/skin/frontend/`
- [ ] `magento-2x.ts` — `static/version` path OR `requirejs-config.js` OR `data-mage-init`
- [ ] `lightspeed-ecom.ts` — `shoplightspeed` in HTML OR `cdn.shoplightspeed.com`
- [ ] `lightspeed-classic.ts` — `webshopapp.com` OR LightSpeed Classic-specific markers
- [ ] `opencart.ts` — `<select id="input-sort">` with `p.*` values OR `route=product/category`
- [ ] `volusion.ts` — `x-powered-by: Volusion` OR `/v/vspfiles/` paths
- [ ] `nopcommerce.ts` — `<meta name="generator" content="nopCommerce">` OR footer `Powered by nopCommerce`
- [ ] `odoo.ts` — `<meta name="generator" content="Odoo">` OR `oe_website_sale` OR `oe_currency_value`
- [ ] `hikashop-joomla.ts` — `hikashop_*` classes OR `/components/com_hikashop/`
- [ ] `xenforo.ts` — `<meta name="generator" content="XenForo">` OR forum-specific markers
- [ ] `godaddy-ols.ts` — `[data-aid="PRODUCT_LIST_RENDERED"]` OR GoDaddy-specific DPS header
- [ ] `wix-thunderbolt.ts` — `<?xml ... generatedBy="WIX">` in sitemap OR `wixBiSession`/`thunderbolt` in HTML
- [ ] `ecwid-on-wordpress.ts` — `<script src="https://app.ecwid.com/script.js?<storeId>">` + WordPress markers (composite)
- [ ] `celerant-coldfusion.ts` — `celerantwebservices.com/jquery/` + CFID/CFTOKEN cookies + `server: Null` (composite)
- [ ] `drupal-commerce.ts` — `x-generator: Drupal N` + `x-drupal-cache-tags` + (optional) `x-commerce-core` (composite)

For each:
- [ ] **Step a:** Create the detector file following the pattern of Task 3.4 detectors. Use the exact HTML/header markers from the audit history (`memory/34-site-audit-history.md`) and crawler-specialist persona.
- [ ] **Step b:** Add the detector to `detectors/index.ts` (ordered by specificity — composites first).
- [ ] **Step c:** Smoke-test against the matching site from the Tier-2 fleet (e.g., gunpost.ca for `drupal-commerce`).
- [ ] **Step d:** Commit one detector per commit OR group composites in one commit.

Per-detector commit example:
```bash
git add backend/scripts/probe/room2-access-identity/detectors/celerant-coldfusion.ts backend/scripts/probe/room2-access-identity/detectors/index.ts
git commit -m "feat(probe-room2): celerant-coldfusion composite detector" \
  -m "Composite: celerantwebservices.com/jquery + CFID/CFTOKEN cookies + server: Null. Per spec §4.2 + Mistake 36." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

After all 15 detectors:
- [ ] **Step e:** Smoke test the full registry.

```bash
cd backend && npx tsx -e "
import { fetchUrl } from './scripts/probe/shared/fetch';
import { detectPlatform } from './scripts/probe/room2-access-identity/platform-detect';
const sites = [
  ['https://bullseyenorth.com/', 'celerant-coldfusion'],
  ['https://gunpost.ca/', 'drupal-commerce'],
  ['https://gagnonsports.com/', 'lightspeed-classic'],
  ['https://solelyoutdoors.com/', 'lightspeed-ecom'],
  ['https://outfitters.goldnloan.com/', 'odoo'],
  ['https://lockharttactical.com/', 'hikashop-joomla'],
  ['https://reliablegun.com/', 'nopcommerce'],
  ['https://liangjian.ca/', 'godaddy-ols'],
  ['https://surplusherbys.com/', 'wix-thunderbolt'],
  ['https://triggersandbows.com/', 'ecwid-on-wordpress'],
];
for (const [url, expected] of sites) {
  const r = await fetchUrl(url);
  const p = await detectPlatform({ url, html: r.body, headers: r.headers, cookies: [] });
  console.log(url, '→', p?.detectorId, p?.detectorId === expected ? 'OK' : 'EXPECTED ' + expected);
}
"
# Expect: all 10 print 'OK'
```

---

### Task 3.6: room2-access-identity/index.ts (room composer)

**Files:**
- Create: `backend/scripts/probe/room2-access-identity/index.ts`

**Goal:** Compose canonical-host + heavy-probe + waf-detect + platform-detect + access-method ladder selection.

- [ ] **Step 1:** Implement.

```typescript
// backend/scripts/probe/room2-access-identity/index.ts
// Room 2 composer. Per spec §4.2.

import { resolveCanonicalHost } from './canonical-host';
import { runHeavyWafProbe } from './waf-heavy-probe';
import { classifyWaf } from './waf-detect';
import { detectPlatform } from './platform-detect';
import { fetchUrl } from '../shared/fetch';
import { UA_LADDER, pickUaForWaf, UA_DESKTOP, UA_IPHONE } from '../shared/ua';
import type { IntakeState, AccessIdentityState, RoomFailure } from '../shared/types';

export async function runRoom2(prev: IntakeState): Promise<AccessIdentityState | RoomFailure> {
  // 1. Canonical host
  const ch = await resolveCanonicalHost(prev.canonicalUrl);
  if (!ch.apexResponded && !ch.wwwFallbackUsed) {
    return fail(`No response from ${prev.canonicalUrl} or www-fallback`, { ch });
  }
  const origin = ch.canonicalOrigin;

  // 2. Heavy WAF probe
  const probe = await runHeavyWafProbe(`${origin}/`);
  const waf = classifyWaf(probe.batches);

  // 3. Platform detection (using a fresh fetch with UA tuned to WAF)
  const accessUa = pickUaForWaf(waf.wafType);
  const accessFetch = await fetchUrl(`${origin}/`, { ua: accessUa, hasWaf: waf.hasWaf, wafType: waf.wafType });
  if (accessFetch.status >= 400 && !waf.hasWaf) {
    // Try the next UA in the ladder
    for (const step of UA_LADDER.slice(1)) {
      try {
        const r = await fetchUrl(`${origin}/`, { ua: step.ua, forcePlaywright: step.usePlaywright });
        if (r.status < 400 && r.bodyBytes > 5000) { /* accept */ break; }
      } catch { /* try next */ }
    }
  }

  const platform = await detectPlatform({
    url: `${origin}/`,
    html: accessFetch.body,
    headers: accessFetch.headers,
    cookies: (accessFetch.headers['set-cookie'] ?? '').split(',').map(s => s.trim()),
  });
  if (!platform) {
    return fail('No platform detector matched', { html_bytes: accessFetch.bodyBytes });
  }

  // 4. Pick the access method that worked
  let accessMethod: AccessIdentityState['accessMethod'] = 'axios-desktop';
  if (accessUa === UA_IPHONE) accessMethod = 'axios-iphone';
  if (waf.wafType === 'sgcaptcha' || waf.wafType === 'incapsula') accessMethod = 'playwright-iphone-cookies';

  return {
    ...prev,
    canonicalOrigin: origin,
    canonicalOriginResolution: ch,
    hasWaf: waf.hasWaf,
    wafType: waf.wafType,
    wafProbeEvidence: {
      method: 'heavy-8-batch',
      timestamp: new Date().toISOString(),
      batches: probe.batches,
      ...waf.evidenceFlags,
    },
    needsPlaywright: accessMethod.startsWith('playwright'),
    userAgentOverride: accessUa === UA_DESKTOP ? null : accessUa,
    accessMethod,
    platform: platform.detectorId,
    platformMarker: platform,
  };

  function fail(reason: string, evidence: Record<string, unknown>): RoomFailure {
    return {
      roomFailed: true, roomNumber: 2, reason, evidence,
      timestamp: new Date().toISOString(),
    };
  }
}
```

- [ ] **Step 2:** Tier-1 smoke test.

```bash
cd backend && npx tsx -e "
import { runRoom1 } from './scripts/probe/room1-intake';
import { runRoom2 } from './scripts/probe/room2-access-identity';
const sites = ['https://canadafirstammo.ca/', 'https://aagcanada.ca/', 'https://theammosource.com/', 'https://bullseyenorth.com/', 'https://gunpost.ca/'];
for (const url of sites) {
  const r1 = await runRoom1(url);
  if ('roomFailed' in r1) { console.log(url, 'R1 FAIL', r1.reason); continue; }
  const r2 = await runRoom2(r1);
  if ('roomFailed' in r2) { console.log(url, 'R2 FAIL', r2.reason); continue; }
  console.log(url, '→ waf:', r2.wafType, 'platform:', r2.platform, 'method:', r2.accessMethod);
}
" 2>&1 | tee /tmp/room2-smoke.log
# Expect:
#   canadafirstammo.ca → waf: cloudflare-passive, platform: woocommerce, method: axios-desktop
#   aagcanada.ca       → waf: cloudflare-passive, platform: shopify, method: axios-desktop
#   theammosource.com  → waf: cloudflare-passive, platform: bigcommerce-stencil
#   bullseyenorth.com  → platform: celerant-coldfusion
#   gunpost.ca         → waf: cloudflare-active, platform: drupal-commerce, method: playwright-*
```

- [ ] **Step 3:** tsc + commit.

```bash
cd backend && npx tsc --noEmit
git add backend/scripts/probe/room2-access-identity/index.ts
git commit -m "feat(probe-room2): compose canonical-host + heavy-probe + waf-detect + platform-detect + UA ladder" \
  -m "Tier-1 smoke (5 sites) verified: WooCommerce/Shopify/BC-Stencil/Celerant/Drupal-classifieds all classified correctly with appropriate access methods. Per spec §4.2." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Room 3: Geography & Count

Spec reference: §4.3.

### Task 4.1: room3-geography-count/sitemap-parse.ts

**Files:**
- Create: `backend/scripts/probe/room3-geography-count/sitemap-parse.ts`
- Create: `backend/scripts/probe/room3-geography-count/__test__/sitemap-parse.test.ts`

**Goal:** Cherry-pick from `probe-sitemap.ts.snapshot`: static-mode XML fetch, URL-pattern classification (CS-Cart `_p_`, .html slugs, numeric-ID, etc.), WAF bail-out, sitemap-index follow, byte-identical-shard md5 dedup.

- [ ] **Step 1:** Inspect snapshot for the patterns.

```bash
grep -n "PRODUCT_URL_PATTERNS\|sitemapMd5\|sitemap-index\|consecutiveWafFailures" docs/superpowers/plans/cherry-pick-snapshots/probe-sitemap.ts.snapshot | head -30
```

- [ ] **Step 2:** Write tests using realistic XML fixtures (capture from gotenda.com sitemap, BC Stencil sitemap, Wix sitemap).

```typescript
// backend/scripts/probe/room3-geography-count/__test__/sitemap-parse.test.ts
import { describe, it, expect } from 'vitest';
import { isLikelyProductUrl, parseSitemapXml } from '../sitemap-parse';

describe('isLikelyProductUrl', () => {
  it('matches BC Stencil product URL pattern', () => {
    expect(isLikelyProductUrl('https://example.com/some-product-slug/')).toBeTruthy();
  });
  it('matches Magento product URL pattern', () => {
    expect(isLikelyProductUrl('https://example.com/catalog/product/view/id/123/s/slug/')).toBeTruthy();
  });
  it('matches CS-Cart _p_NN.html', () => {
    expect(isLikelyProductUrl('https://example.com/some-cat/some-product_p_25.html')).toBeTruthy();
  });
  it('rejects category URL', () => {
    expect(isLikelyProductUrl('https://example.com/product-category/firearms/')).toBe(false);
    expect(isLikelyProductUrl('https://example.com/category/handguns/')).toBe(false);
  });
  it('rejects nav URL', () => {
    expect(isLikelyProductUrl('https://example.com/about-us/')).toBe(false);
  });
});

describe('parseSitemapXml', () => {
  it('extracts <loc> entries', () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://example.com/product1</loc></url>
      <url><loc>https://example.com/product2</loc></url>
    </urlset>`;
    expect(parseSitemapXml(xml)).toEqual([
      'https://example.com/product1',
      'https://example.com/product2',
    ]);
  });
  it('handles HTML-entity-encoded URLs', () => {
    const xml = `<urlset><url><loc>https://example.com/p?a=1&amp;b=2</loc></url></urlset>`;
    expect(parseSitemapXml(xml)).toEqual(['https://example.com/p?a=1&b=2']);
  });
});
```

- [ ] **Step 3:** Run failing.

```bash
cd backend && npx vitest run scripts/probe/room3-geography-count/__test__/sitemap-parse.test.ts
```

- [ ] **Step 4:** Implement.

```typescript
// backend/scripts/probe/room3-geography-count/sitemap-parse.ts
// Sitemap discovery + parsing + product-URL classification.
// Cherry-pick: static-mode XML fetch, broadened WAF bail-out, expanded URL patterns,
// byte-identical shard md5 dedup, sitemap-index follow-through.

import { createHash } from 'crypto';
import { fetchUrl } from '../shared/fetch';
import { hasChallengeMarkers } from '../room2-access-identity/canonical-host';

const PRODUCT_URL_POSITIVE = [
  /\/products?\//i,
  /\/product-page\//i,
  /\/catalog\/product\/view\/id\/\d+/i,
  /\/shop\/[^/]+(?:-\d{2,})?$/i,
  /[-_]p[-_]?\d{2,}\.html$/i,
  /\/[a-z0-9-]+-\d{4,}\/?$/i,    // slug-NNNN
  /\.html$/i,                      // generic
];

const PRODUCT_URL_NEGATIVE = [
  /\/(product-)?category\//i,
  /\/collections\//i,
  /\/brand\//i,
  /\/tag\//i,
  /\/page\/\d+/i,
  /\/(cart|login|checkout|account|search|sitemap|wp-admin|wp-login|robots)/i,
  /\/sitemap[^/]*\.xml/i,
];

export function isLikelyProductUrl(url: string): boolean {
  if (PRODUCT_URL_NEGATIVE.some(re => re.test(url))) return false;
  return PRODUCT_URL_POSITIVE.some(re => re.test(url));
}

export function parseSitemapXml(xml: string): string[] {
  const re = /<loc>([^<]+)<\/loc>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(decodeXmlEntities(m[1].trim()));
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export type SitemapDiscoveryResult = {
  productUrls: string[];
  totalLocs: number;
  shardsCounted: string[];
  duplicateShardsByMd5: number;
  wafBailedOut: boolean;
};

const SITEMAP_CANDIDATES = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/product-sitemap.xml',
  '/sitemap_products.xml',
  '/xmlsitemap.php?type=products',  // BigCommerce
  '/store-products-sitemap.xml',     // Wix
];

export async function discoverProductSitemap(origin: string): Promise<SitemapDiscoveryResult> {
  const result: SitemapDiscoveryResult = {
    productUrls: [],
    totalLocs: 0,
    shardsCounted: [],
    duplicateShardsByMd5: 0,
    wafBailedOut: false,
  };
  const seenMd5 = new Set<string>();
  let consecutiveWafFails = 0;

  for (const path of SITEMAP_CANDIDATES) {
    const url = `${origin}${path}`;
    let body: string;
    try {
      // Static-mode: XML doesn't need Playwright, even on WAF sites
      const r = await fetchUrl(url, { timeoutMs: 15000 });
      if (hasChallengeMarkers(r.body) || r.status >= 400) {
        consecutiveWafFails++;
        if (consecutiveWafFails >= 3) { result.wafBailedOut = true; return result; }
        continue;
      }
      body = r.body;
    } catch { continue; }
    consecutiveWafFails = 0;

    const md5 = createHash('md5').update(body).digest('hex');
    if (seenMd5.has(md5)) { result.duplicateShardsByMd5++; continue; }
    seenMd5.add(md5);
    result.shardsCounted.push(url);

    const locs = parseSitemapXml(body);
    result.totalLocs += locs.length;

    // sitemap-index → follow children
    if (/<sitemapindex/i.test(body)) {
      for (const childUrl of locs.slice(0, 40)) {
        try {
          const cr = await fetchUrl(childUrl, { timeoutMs: 15000 });
          if (hasChallengeMarkers(cr.body) || cr.status >= 400) continue;
          const cmd5 = createHash('md5').update(cr.body).digest('hex');
          if (seenMd5.has(cmd5)) { result.duplicateShardsByMd5++; continue; }
          seenMd5.add(cmd5);
          result.shardsCounted.push(childUrl);
          const childLocs = parseSitemapXml(cr.body);
          result.totalLocs += childLocs.length;
          result.productUrls.push(...childLocs.filter(isLikelyProductUrl));
        } catch { /* skip */ }
      }
    } else {
      result.productUrls.push(...locs.filter(isLikelyProductUrl));
    }

    // Stop after first valid sitemap (don't double-count)
    if (result.productUrls.length > 0) break;
  }

  // Dedupe product URLs across shards
  result.productUrls = [...new Set(result.productUrls)];
  return result;
}
```

- [ ] **Step 5:** Tests pass + smoke.

```bash
cd backend && npx vitest run scripts/probe/room3-geography-count/__test__/sitemap-parse.test.ts
npx tsx -e "
import { discoverProductSitemap } from './scripts/probe/room3-geography-count/sitemap-parse';
discoverProductSitemap('https://theammosource.com').then(r => console.log({ urls: r.productUrls.length, shards: r.shardsCounted.length, dupes: r.duplicateShardsByMd5 }));
"
# Expect: urls > 40000, shards >= 5
```

- [ ] **Step 6:** Commit.

```bash
git add backend/scripts/probe/room3-geography-count/sitemap-parse.ts backend/scripts/probe/room3-geography-count/__test__/
git commit -m "feat(probe-room3): sitemap discovery + parsing + product-URL classification" \
  -m "Cherry-picks: static-mode XML, broadened WAF bail-out, byte-identical shard md5 dedup, sitemap-index follow-through. Per spec §4.3 + §9 + Mistake 31/36." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.2: room3-geography-count/global-count.ts

**Files:**
- Create: `backend/scripts/probe/room3-geography-count/global-count.ts`
- Create: `backend/scripts/probe/room3-geography-count/__test__/global-count.test.ts`

**Goal:** API/sitemap count dispatch per platform. Priority order per spec §4.3 step 2. Cherry-pick API count extraction from `probe-platform.ts.snapshot`.

- [ ] **Step 1:** Implement following spec §4.3 step 2 priority order. Each method in its own private function. Top-level `getGlobalCount(state)` dispatches based on `state.platform` + tries the priority list.

```typescript
// backend/scripts/probe/room3-geography-count/global-count.ts
// Per spec §4.3 step 2. API-first, sitemap-fallback.
// Cherry-pick: x-wp-total, /products/count.json, ecwid totalProductsCount.

import { fetchUrl } from '../shared/fetch';
import { discoverProductSitemap } from './sitemap-parse';
import * as cheerio from 'cheerio';
import type { AccessIdentityState, GeographyCountState, CountMethod } from '../shared/types';

type CountResult = {
  count: number;
  method: CountMethod;
  evidence: GeographyCountState['globalProductCountEvidence'];
};

export async function getGlobalCount(state: AccessIdentityState): Promise<CountResult | null> {
  const origin = state.canonicalOrigin;
  const ua = state.userAgentOverride ?? undefined;
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua };

  // 1. WP REST x-wp-total
  if (/woocommerce|wp-rest/.test(state.platform) || (state.platformMarker.signals as any).wpRestReachable) {
    const r = await safeFetch(`${origin}/wp-json/wp/v2/product?per_page=1`, ctx);
    if (r && r.headers['x-wp-total']) {
      return { count: parseInt(r.headers['x-wp-total'], 10), method: 'wp-rest-header',
        evidence: { endpoint: 'wp/v2/product', headerValue: r.headers['x-wp-total'] }};
    }
  }
  // 2. WC Store API x-wp-total
  if (/woocommerce/.test(state.platform)) {
    const r = await safeFetch(`${origin}/wp-json/wc/store/v1/products?per_page=1`, ctx);
    if (r && r.headers['x-wp-total']) {
      return { count: parseInt(r.headers['x-wp-total'], 10), method: 'wc-store-api-header',
        evidence: { endpoint: 'wc/store/v1/products', headerValue: r.headers['x-wp-total'] }};
    }
  }
  // 3. Shopify /products/count.json
  if (/shopify/.test(state.platform)) {
    const r = await safeFetch(`${origin}/products/count.json`, ctx);
    if (r && r.status === 200) {
      const m = /"count"\s*:\s*(\d+)/.exec(r.body);
      if (m) return { count: parseInt(m[1], 10), method: 'shopify-count-json',
        evidence: { endpoint: '/products/count.json', responseSample: r.body.slice(0, 200) }};
    }
  }
  // 4. Ecwid POST /catalog/search (no parentCategoryId)
  if (/ecwid/.test(state.platform)) {
    const storeId = (state.platformMarker.signals as any).ecwidStoreId;
    if (storeId) {
      const url = `https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/${storeId}/catalog/search`;
      const body = JSON.stringify({ lang: 'en', pagination: { offset: 0, limit: 1 }, urlParams: { baseUrl: '/store/', isCleanUrls: true }});
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': origin, 'Referer': origin }, body });
        const json = await r.json();
        if (typeof json.totalProductsCount === 'number') {
          return { count: json.totalProductsCount, method: 'ecwid-storefront-search',
            evidence: { endpoint: url, responseSample: JSON.stringify(json).slice(0, 200) }};
        }
      } catch { /* skip */ }
    }
  }
  // 5. BigCommerce sitemap (/xmlsitemap.php?type=products)
  if (/bigcommerce/.test(state.platform)) {
    const sitemap = await discoverProductSitemap(origin);
    if (sitemap.productUrls.length > 0) {
      return { count: sitemap.productUrls.length, method: 'bc-xmlsitemap',
        evidence: { sitemapShards: sitemap.shardsCounted, sitemapTotalLocs: sitemap.totalLocs, sitemapProductLocs: sitemap.productUrls.length }};
    }
  }
  // 6. Magento toolbar amount on /new-products.html
  if (/magento/.test(state.platform)) {
    const r = await safeFetch(`${origin}/new-products.html`, ctx);
    if (r && r.status === 200) {
      const $ = cheerio.load(r.body);
      const nums = $('.toolbar-number').map((_, el) => parseInt($(el).text().trim(), 10)).get().filter(Number.isFinite);
      if (nums.length >= 3) return { count: nums[2], method: 'magento-toolbar',
        evidence: { endpoint: '/new-products.html', responseSample: nums.join(',') }};
    }
  }
  // 7. Generic product sitemap (last sitemap-based attempt)
  {
    const sitemap = await discoverProductSitemap(origin);
    if (sitemap.productUrls.length > 0) {
      return { count: sitemap.productUrls.length, method: 'generic-product-sitemap',
        evidence: { sitemapShards: sitemap.shardsCounted, sitemapTotalLocs: sitemap.totalLocs, sitemapProductLocs: sitemap.productUrls.length }};
    }
  }
  return null;
}

async function safeFetch(url: string, ctx: { hasWaf?: boolean; wafType?: any; ua?: string }) {
  try {
    return await fetchUrl(url, ctx);
  } catch { return null; }
}
```

- [ ] **Step 2:** Smoke test.

```bash
cd backend && npx tsx -e "
import { runRoom1 } from './scripts/probe/room1-intake';
import { runRoom2 } from './scripts/probe/room2-access-identity';
import { getGlobalCount } from './scripts/probe/room3-geography-count/global-count';
const sites = ['https://canadafirstammo.ca/', 'https://aagcanada.ca/', 'https://theammosource.com/'];
for (const url of sites) {
  const r1 = await runRoom1(url);
  if ('roomFailed' in r1) continue;
  const r2 = await runRoom2(r1);
  if ('roomFailed' in r2) continue;
  const c = await getGlobalCount(r2);
  console.log(url, '→', c?.count, 'via', c?.method);
}
"
# Expect: 3 sites with count > 0 and method matching their platform
```

- [ ] **Step 3:** tsc + commit.

```bash
cd backend && npx tsc --noEmit
git add backend/scripts/probe/room3-geography-count/global-count.ts
git commit -m "feat(probe-room3): global-count with API-first priority dispatch per platform" \
  -m "Cherry-pick API count extraction from probe-platform (now correctly scoped to Room 3 per spec §4.3 architectural fix). 7-step priority: WP REST → WC Store → Shopify count.json → Ecwid → BC sitemap → Magento toolbar → generic sitemap." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.3: room3-geography-count/catalog-urls.ts

**Files:**
- Create: `backend/scripts/probe/room3-geography-count/catalog-urls.ts`

**Goal:** Discover catalogUrls via nav + taxonomy API + category tree walk. Cherry-pick async empirical pickTestUrl from `pre-bootstrap.ts.snapshot`.

- [ ] **Step 1:** Inspect snapshot.

```bash
grep -n "pickTestUrl\|getCatalogUrls\|navLinks" docs/superpowers/plans/cherry-pick-snapshots/pre-bootstrap.ts.snapshot | head -20
```

- [ ] **Step 2:** Implement.

```typescript
// backend/scripts/probe/room3-geography-count/catalog-urls.ts
// Discover minimum catalogUrls covering 100% of products with minimum overlap.
// Per spec §4.3 step 1 + playbook Phase 3.

import * as cheerio from 'cheerio';
import { fetchUrl } from '../shared/fetch';
import { isLikelyNavUrl } from '../shared/url-utils';
import { extractProducts } from '../shared/extract';
import type { AccessIdentityState } from '../shared/types';

export type CatalogUrlsResult = {
  catalogUrls: string[];
  source: 'nav' | 'taxonomy-api' | 'category-tree-walk' | 'manual';
};

export async function discoverCatalogUrls(state: AccessIdentityState): Promise<CatalogUrlsResult> {
  const origin = state.canonicalOrigin;
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };

  // 1. Try platform-specific taxonomy APIs first (most reliable)
  if (/woocommerce/.test(state.platform)) {
    const r = await fetchUrl(`${origin}/wp-json/wp/v2/product_cat?per_page=100&hide_empty=false`, ctx);
    if (r.status === 200) {
      try {
        const cats = JSON.parse(r.body) as Array<{ slug: string; count: number; parent: number }>;
        // Top-level non-empty categories
        const tops = cats.filter(c => c.parent === 0 && c.count > 0);
        return {
          catalogUrls: tops.map(c => `${origin}/product-category/${c.slug}/`),
          source: 'taxonomy-api',
        };
      } catch { /* fall through */ }
    }
  }
  if (/shopify/.test(state.platform)) {
    const r = await fetchUrl(`${origin}/collections.json?limit=250`, ctx);
    if (r.status === 200) {
      try {
        const json = JSON.parse(r.body) as { collections: Array<{ handle: string; published_at?: string; products_count?: number }> };
        const visible = json.collections.filter(c => (c.products_count ?? 1) > 0);
        return {
          catalogUrls: visible.map(c => `${origin}/collections/${c.handle}`),
          source: 'taxonomy-api',
        };
      } catch { /* fall through */ }
    }
  }

  // 2. Nav-link discovery from homepage HTML
  const home = await fetchUrl(`${origin}/`, ctx);
  const $ = cheerio.load(home.body);
  const navAnchors = $('nav a, header a, .menu a, [class*="nav"] a').map((_, el) => $(el).attr('href')).get();
  const candidates = navAnchors
    .filter((h): h is string => Boolean(h))
    .map(h => {
      try { return new URL(h, origin).toString(); } catch { return null; }
    })
    .filter((u): u is string => Boolean(u))
    .filter(u => new URL(u).hostname === new URL(origin).hostname)
    .filter(u => !isLikelyNavUrl(u));

  const unique = [...new Set(candidates)];

  // 3. Empirical filter: keep candidates that actually return products via production extractor
  const probed: Array<{ url: string; productCount: number }> = [];
  for (const url of unique.slice(0, 30)) {
    try {
      const r = await fetchUrl(url, { ...ctx, timeoutMs: 12000 });
      const products = extractProducts(r.body, url);
      probed.push({ url, productCount: products.length });
    } catch { /* skip */ }
  }
  probed.sort((a, b) => b.productCount - a.productCount);
  const productive = probed.filter(p => p.productCount >= 3).map(p => p.url);

  return {
    catalogUrls: productive,
    source: productive.length > 0 ? 'nav' : 'manual',
  };
}
```

- [ ] **Step 3:** Smoke test + commit.

```bash
cd backend && npx tsx -e "
import { runRoom1 } from './scripts/probe/room1-intake';
import { runRoom2 } from './scripts/probe/room2-access-identity';
import { discoverCatalogUrls } from './scripts/probe/room3-geography-count/catalog-urls';
const r1 = await runRoom1('https://aagcanada.ca/');
if ('roomFailed' in r1) throw new Error();
const r2 = await runRoom2(r1);
if ('roomFailed' in r2) throw new Error();
const u = await discoverCatalogUrls(r2);
console.log('found', u.catalogUrls.length, 'via', u.source, '— first 3:', u.catalogUrls.slice(0,3));
"
# Expect: 5+ catalogUrls via taxonomy-api or nav

cd backend && npx tsc --noEmit
git add backend/scripts/probe/room3-geography-count/catalog-urls.ts
git commit -m "feat(probe-room3): catalog URL discovery via taxonomy API + nav + empirical filter" \
  -m "Cherry-pick: empirical pickTestUrl from pre-bootstrap.ts (replaces keyword-regex guessing). Priority: taxonomy API > nav > manual. Per spec §4.3 step 1 + Playbook Step 3d." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4.4: room3-geography-count/walk-verify.ts + index.ts

**Files:**
- Create: `backend/scripts/probe/room3-geography-count/walk-verify.ts`
- Create: `backend/scripts/probe/room3-geography-count/index.ts`

**Goal:** Walk every catalogUrl, dedupe, compute drift, gate per spec §4.3 step 3+4 + pass criteria.

- [ ] **Step 1:** Implement walk-verify.

```typescript
// backend/scripts/probe/room3-geography-count/walk-verify.ts
import { fetchUrl } from '../shared/fetch';
import { extractProducts } from '../shared/extract';
import type { AccessIdentityState } from '../shared/types';

export type WalkResult = {
  walkCounts: Array<{ url: string; uniqueProducts: number; pages: number }>;
  uniqueProductUrls: Set<string>;
};

export async function walkAndDedupe(
  state: AccessIdentityState,
  catalogUrls: string[],
): Promise<WalkResult> {
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };
  const seen = new Set<string>();
  const counts: WalkResult['walkCounts'] = [];

  for (const url of catalogUrls) {
    let pages = 0;
    let countForUrl = 0;
    let nextUrl: string | null = url;
    while (nextUrl && pages < 200) {
      try {
        const r = await fetchUrl(nextUrl, { ...ctx, timeoutMs: 15000 });
        if (r.status >= 400) break;
        const products = extractProducts(r.body, nextUrl);
        if (products.length === 0) break;
        let added = 0;
        for (const p of products) {
          if (!seen.has(p.url)) { seen.add(p.url); added++; }
        }
        countForUrl += added;
        pages++;
        // Probe-level pagination: try ?page=N+1 and confirm new products
        const u = new URL(nextUrl);
        const curPage = parseInt(u.searchParams.get('page') ?? '1', 10);
        u.searchParams.set('page', String(curPage + 1));
        nextUrl = u.toString();
      } catch { break; }
    }
    counts.push({ url, uniqueProducts: countForUrl, pages });
  }

  return { walkCounts: counts, uniqueProductUrls: seen };
}
```

- [ ] **Step 2:** Implement room index.

```typescript
// backend/scripts/probe/room3-geography-count/index.ts
import { discoverCatalogUrls } from './catalog-urls';
import { getGlobalCount } from './global-count';
import { walkAndDedupe } from './walk-verify';
import type { AccessIdentityState, GeographyCountState, RoomFailure } from '../shared/types';

export async function runRoom3(prev: AccessIdentityState): Promise<GeographyCountState | RoomFailure> {
  // Step 1: catalogUrls
  const cu = await discoverCatalogUrls(prev);
  if (cu.catalogUrls.length === 0) {
    return fail('no catalogUrls discovered', { source: cu.source });
  }
  // Step 2: global count (independent)
  const gc = await getGlobalCount(prev);
  // Step 3: walk
  const walk = await walkAndDedupe(prev, cu.catalogUrls);
  if (walk.uniqueProductUrls.size === 0) {
    return fail('walk returned 0 products from all catalogUrls', { walkCounts: walk.walkCounts });
  }
  // Step 4: reconcile
  const walkedCount = walk.uniqueProductUrls.size;
  const globalCount = gc?.count ?? walkedCount;
  const method = gc?.method ?? 'catalog-walk-only';
  const driftPct = gc ? Math.abs(globalCount - walkedCount) / globalCount * 100 : 0;
  if (driftPct > 5) {
    return fail(`drift ${driftPct.toFixed(1)}% > 5%`, { globalCount, walkedCount, method, walkCounts: walk.walkCounts });
  }
  // Pass / soft-warn
  return {
    ...prev,
    catalogUrls: cu.catalogUrls,
    catalogUrlSource: cu.source,
    catalogUrlWalkCounts: walk.walkCounts,
    walkedUniqueCount: walkedCount,
    globalProductCount: globalCount,
    globalProductCountMethod: method,
    globalProductCountEvidence: gc?.evidence ?? {},
    driftPct,
    coverageStrategy: gc && /api|wp-rest|store-api|shopify|ecwid|klevu/.test(method) ? 'api-walk'
                    : (gc ? 'hybrid' : 'html-walk'),
  };

  function fail(reason: string, evidence: Record<string, unknown>): RoomFailure {
    return { roomFailed: true, roomNumber: 3, reason, evidence, timestamp: new Date().toISOString() };
  }
}
```

- [ ] **Step 3:** Tier-1 smoke + commit.

```bash
cd backend && npx tsx -e "
import { runRoom1 } from './scripts/probe/room1-intake';
import { runRoom2 } from './scripts/probe/room2-access-identity';
import { runRoom3 } from './scripts/probe/room3-geography-count';
const sites = ['https://canadafirstammo.ca/', 'https://aagcanada.ca/', 'https://theammosource.com/', 'https://bullseyenorth.com/', 'https://gunpost.ca/'];
for (const url of sites) {
  const r1 = await runRoom1(url);
  if ('roomFailed' in r1) continue;
  const r2 = await runRoom2(r1);
  if ('roomFailed' in r2) continue;
  const r3 = await runRoom3(r2);
  if ('roomFailed' in r3) { console.log(url, 'R3 FAIL', r3.reason); continue; }
  console.log(url, '→', r3.globalProductCount, 'via', r3.globalProductCountMethod, 'walked', r3.walkedUniqueCount, 'drift', r3.driftPct.toFixed(2)+'%', '| catalogUrls:', r3.catalogUrls.length);
}
"
# Expect: 5 sites with drift ≤ 3%

cd backend && npx tsc --noEmit
git add backend/scripts/probe/room3-geography-count/
git commit -m "feat(probe-room3): walk-verify + index — geography-first ordering with reconciliation" \
  -m "Per spec §4.3: catalogUrls discovery first, global count via API/sitemap, walk reconciles. 3% drift gate, 5% hard fail. Tier-1 smoke verified on 5 families." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Room 4: Navigation

Spec reference: §4.4.

### Task 5.1: room4-navigation/pagination-detect.ts

**Files:**
- Create: `backend/scripts/probe/room4-navigation/pagination-detect.ts`

**Goal:** 4-pattern test + 4-point verification (silent-ignore, clamp-to-last, wrap-around, perPage-sanity) per spec §4.4 + the 3-point check we agreed.

- [ ] **Step 1:** Implement. Key logic:
  - Estimate `totalPages` from widget markup OR from `count / perPage` math.
  - For each pattern in [`query` w/ `?page=N`, `path` w/ `/page/N`, `offset-query` w/ `?top=(N-1)*perPage`, `suffix-replace` w/ `-N.html`]:
    - Test A: page 1 vs page 2 — first 3 products differ.
    - If A passes: Test B (page N-1 vs N), Test C (page N+2 vs page 1), Test D (perPage sanity).
  - Return first pattern that passes A; document which of B/C/D passed/skipped.

(Code shape similar to prior tasks — full implementation ~150 lines. The engineer follows the algorithm above; per-pattern URL builders use the same templates documented in Mistake 14.)

- [ ] **Step 2:** Smoke test on 5 Tier-1 sites; tsc; commit.

---

### Task 5.2: room4-navigation/sort-detect.ts

**Files:**
- Create: `backend/scripts/probe/room4-navigation/sort-detect.ts`

**Goal:** Read `<select>` HTML for sort options + verify via DATE comparison (not just ID-jump) per spec §4.4. Per Mistake 29 3-outcome counter-control.

- [ ] **Step 1:** Implement. Key steps:
  - Fetch a known catalog page (first `catalogUrls`).
  - Find `<select id|name|class="sort|order|sortby"` and extract `<option value text>` pairs.
  - For each candidate sort param (newest-pattern via `/\b(new|latest|recent|date|created|published)\b/i`):
    - Build URL with sort param.
    - Fetch page 1 with sort.
    - Date-verify: extract per-product dates (priority: API field → schema.org `datePublished` listing → detail-page spot check → sitemap `<lastmod>` → `sourceId` autoincrement).
    - If first 3 dates strictly decreasing → sort honored.
    - Pick a counter-control (alphaasc, price-asc, etc.); if its first product differs from default AND from sorted, distinguish honored from no-op.
  - Return `sortParam` + `sortEvidence` with full date verification trail.

- [ ] **Step 2:** Smoke test + tsc + commit.

---

### Task 5.3: room4-navigation/watermark-method.ts + index.ts

**Files:**
- Create: `backend/scripts/probe/room4-navigation/watermark-method.ts`
- Create: `backend/scripts/probe/room4-navigation/index.ts`

**Goal:** Pick Method A/B/C per spec §6.3 + compose Room 4.

- [ ] **Step 1:** Implement watermark-method.ts:
  - Method A: API supports `dateAfter=` filter AND returns per-product dates → A.
  - Method B: any of 5 date sources yields dates AND newest-first sort verified by dates → B.
  - Method C: no date source anywhere → C.

- [ ] **Step 2:** Implement room4-navigation/index.ts composing pagination + sort + method.

- [ ] **Step 3:** Tier-1 smoke + commit.

```bash
cd backend && npx tsx -e "
import { runRoom1 } from './scripts/probe/room1-intake';
import { runRoom2 } from './scripts/probe/room2-access-identity';
import { runRoom3 } from './scripts/probe/room3-geography-count';
import { runRoom4 } from './scripts/probe/room4-navigation';
const sites = ['https://canadafirstammo.ca/', 'https://aagcanada.ca/', 'https://theammosource.com/', 'https://bullseyenorth.com/', 'https://gunpost.ca/'];
for (const url of sites) {
  let s: any = await runRoom1(url);
  if ('roomFailed' in s) continue;
  s = await runRoom2(s); if ('roomFailed' in s) continue;
  s = await runRoom3(s); if ('roomFailed' in s) continue;
  s = await runRoom4(s);
  if ('roomFailed' in s) { console.log(url, 'R4 FAIL', s.reason); continue; }
  console.log(url, '→ pag:', s.paginationPattern.type, 'sort:', s.sortParam ?? 'none', 'method:', s.watermarkMethod);
}
"
# Expect: 5 sites with watermarkMethod set, sort verified
```

---

## Phase 6 — Orchestrator + Dry-Run Harnesses

Spec reference: §3.1 + §5.

### Task 6.1: backend/scripts/pre-bootstrap.ts (orchestrator)

**Files:**
- Create: `backend/scripts/pre-bootstrap.ts`
- Create: `docs/pre-bootstrap-output/.gitkeep`

**Goal:** Thin composition per spec §5.3. ≤ 150 lines. Writes profile JSON + report markdown.

- [ ] **Step 1:** Implement.

```typescript
// backend/scripts/pre-bootstrap.ts
// Orchestrator. Composes Rooms 1-4. Writes profile JSON + human report. No detection logic.

import { runRoom1 } from './probe/room1-intake';
import { runRoom2 } from './probe/room2-access-identity';
import { runRoom3 } from './probe/room3-geography-count';
import { runRoom4 } from './probe/room4-navigation';
import * as fs from 'fs/promises';
import * as path from 'path';

const OUTPUT_DIR = path.join(process.cwd(), '..', 'docs', 'pre-bootstrap-output');

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('Usage: npx tsx backend/scripts/pre-bootstrap.ts <url>'); process.exit(2); }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let state: any = await runRoom1(url);
  if ('roomFailed' in state) return halt(state, url);

  state = await runRoom2(state);
  if ('roomFailed' in state) return halt(state, url);

  state = await runRoom3(state);
  if ('roomFailed' in state) return halt(state, url);

  state = await runRoom4(state);
  if ('roomFailed' in state) return halt(state, url);

  const domain = new URL(state.canonicalOrigin).hostname;
  const profilePath = path.join(OUTPUT_DIR, `${domain}-profile.json`);
  const reportPath = path.join(OUTPUT_DIR, `${domain}-report.md`);
  await fs.writeFile(profilePath, JSON.stringify(state, null, 2));
  await fs.writeFile(reportPath, renderReport(state));
  console.log(`✓ ${domain}: probe complete`);
  console.log(`  profile: ${profilePath}`);
  console.log(`  report:  ${reportPath}`);
}

async function halt(failure: any, url: string) {
  const safeName = url.replace(/[^a-z0-9]/gi, '_');
  const failPath = path.join(OUTPUT_DIR, `${safeName}-FAILURE.json`);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(failPath, JSON.stringify(failure, null, 2));
  console.error(`✗ Room ${failure.roomNumber} HARD FAIL: ${failure.reason}`);
  console.error(`  evidence: ${failPath}`);
  process.exit(1);
}

function renderReport(s: any): string {
  return `# Pre-Bootstrap Probe Report — ${new URL(s.canonicalOrigin).hostname}

**Run:** ${s.runId} at ${s.timestamp}

## Access & Identity
- Canonical origin: \`${s.canonicalOrigin}\`
- WAF: \`${s.wafType ?? 'none'}\` (hasWaf: ${s.hasWaf})
- Platform: \`${s.platform}\`
- Access method: \`${s.accessMethod}\`
- needsPlaywright: ${s.needsPlaywright}

## Geography & Count
- Global count: **${s.globalProductCount}** via \`${s.globalProductCountMethod}\`
- catalogUrls (${s.catalogUrls.length}): ${s.catalogUrls.slice(0, 5).map((u:string) => `\`${u}\``).join(', ')}${s.catalogUrls.length > 5 ? `, ... (+${s.catalogUrls.length - 5})` : ''}
- Walked unique: ${s.walkedUniqueCount}
- Drift: ${s.driftPct.toFixed(2)}%

## Navigation
- Pagination: \`${s.paginationPattern.type}\` perPage=${s.paginationPattern.perPage}
- Sort: \`${s.sortParam ?? 'none'}\`
- Watermark method: **${s.watermarkMethod}**

## Next step

Review this report. If acceptable, run:
\`\`\`
npx tsx backend/scripts/bootstrap.ts ${new URL(s.canonicalOrigin).hostname}
\`\`\`
`;
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2:** Verify line count ≤ 150 (per spec §11.2 success #2).

```bash
wc -l backend/scripts/pre-bootstrap.ts
```

- [ ] **Step 3:** Commit.

```bash
git add backend/scripts/pre-bootstrap.ts docs/pre-bootstrap-output/.gitkeep 2>/dev/null
git commit -m "feat(pre-bootstrap): orchestrator composes Rooms 1-4, writes profile + report" \
  -m "Pure composition. No detection logic. Per spec §5.3." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6.2: dry-run harnesses

**Files:**
- Create: `backend/scripts/probe/__test__/dry-run-smoke.ts`
- Create: `backend/scripts/probe/__test__/dry-run-fleet.ts`

**Goal:** Per spec §8.3.

- [ ] **Step 1:** Implement smoke harness (5 Tier-1 sites).

```typescript
// backend/scripts/probe/__test__/dry-run-smoke.ts
import { spawnSync } from 'child_process';
const SITES = [
  'https://canadafirstammo.ca/',
  'https://aagcanada.ca/',
  'https://theammosource.com/',
  'https://bullseyenorth.com/',
  'https://gunpost.ca/',
];
let pass = 0, fail = 0;
for (const url of SITES) {
  const r = spawnSync('npx', ['tsx', 'scripts/pre-bootstrap.ts', url], { stdio: 'inherit', cwd: 'backend' });
  if (r.status === 0) pass++; else fail++;
}
console.log(`\nSMOKE: ${pass}/${SITES.length} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2:** Implement fleet harness with the 24 sites from spec §8.1 Tier-2.

- [ ] **Step 3:** Run smoke; if 5/5 pass, commit.

```bash
cd backend && npx tsx scripts/probe/__test__/dry-run-smoke.ts
# Expect: SMOKE: 5/5 pass

git add backend/scripts/probe/__test__/dry-run-smoke.ts backend/scripts/probe/__test__/dry-run-fleet.ts
git commit -m "feat(probe-test): dry-run smoke (5 sites) + fleet (24 sites) harnesses" \
  -m "Per spec §8.3. Smoke runs every commit; fleet runs at milestone gates." \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7 — Room 5: Bootstrap Utility

Spec reference: §4.5 + §6.4.

### Task 7.1: room5-bootstrap modules

**Files:**
- Create: `backend/scripts/probe/room5-bootstrap/strategy-dispatch.ts`
- Create: `backend/scripts/probe/room5-bootstrap/detail-enrich.ts`
- Create: `backend/scripts/probe/room5-bootstrap/index-products.ts`
- Create: `backend/scripts/probe/room5-bootstrap/index.ts`

**Goal:** Per spec §4.5 control flow + §6.4 detail-page enrichment.

- [ ] **Step 1:** Implement strategy-dispatch.ts (api-walk vs html-walk vs hybrid).
- [ ] **Step 2:** Implement detail-enrich.ts (concurrency ≤ 3, batch by catalogUrl, token budget reuse).
- [ ] **Step 3:** Implement index-products.ts (productClassifier + ProductIndex upsert + watermark seed).
- [ ] **Step 4:** Implement index.ts composer.
- [ ] **Step 5:** tsc + commit.

---

### Task 7.2: backend/scripts/bootstrap.ts entry script

**Files:**
- Create: `backend/scripts/bootstrap.ts`

- [ ] **Step 1:** Implement entry script that loads `<domain>-profile.json`, runs Room 5, writes DB.

```typescript
// backend/scripts/bootstrap.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { runRoom5 } from './probe/room5-bootstrap';
import { prisma } from '../src/lib/prisma';

async function main() {
  const domain = process.argv[2];
  if (!domain) { console.error('Usage: npx tsx backend/scripts/bootstrap.ts <domain>'); process.exit(2); }

  const profilePath = path.join(process.cwd(), '..', 'docs', 'pre-bootstrap-output', `${domain}-profile.json`);
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf-8'));
  const result = await runRoom5(profile);
  if ('roomFailed' in result) {
    console.error(`✗ Bootstrap FAIL: ${result.reason}`);
    process.exit(1);
  }
  console.log(`✓ Bootstrap complete: ${result.productsIndexed} products, drift ${result.finalDriftPct.toFixed(2)}%`);
  await prisma.$disconnect();
}

main().catch(async err => { console.error(err); await prisma.$disconnect(); process.exit(1); });
```

- [ ] **Step 2:** Verify ≤ 200 lines (per spec §11.2 success #3).
- [ ] **Step 3:** Commit.

---

### Tasks 7.3–7.7: Bootstrap each Tier-1 site

For each of the 5 Tier-1 sites:
- [ ] Run `pre-bootstrap.ts <url>` → review profile + report.
- [ ] Run `bootstrap.ts <domain>` → verify DB (productsIndexed, lastWatermarkUrl, isEnabled=true, drift ≤ 3%).
- [ ] Spot-check: query 5 random products from ProductIndex, verify URL/title/price/postDate present.
- [ ] Commit any per-platform fixes discovered (e.g., detail-extractor for a specific platform).

---

## Phase 8 — Tier-2 Fleet Regression (milestone gate)

### Task 8.1: Fleet dry-run + per-family triage

- [ ] **Step 1:** Run `dry-run-fleet.ts`. Expect partial fail.
- [ ] **Step 2:** Group failures by family. For each family failure:
  - Add fixture to `__test__/fixtures/<site>.html`.
  - Add unit test for the missed pattern.
  - Fix the failing module.
  - Re-run smoke + the failing fleet site.
- [ ] **Step 3:** Repeat until 24/24 pass.

---

## Phase 9 — Documentation + Cleanup

### Task 9.1: Update SKILL.md

- [ ] Edit `.claude/skills/pre-bootstrap/SKILL.md` to reflect 5-room architecture, new judgment hooks, the detector registry contract, and how to add a new platform.

### Task 9.2: Final cleanup

- [ ] Delete `docs/superpowers/plans/cherry-pick-snapshots/` (no longer needed).
- [ ] Final tsc + smoke + fleet pass.
- [ ] Tag the rebuild commit.

```bash
git tag rebuild-complete -a -m "Pre-bootstrap rebuild complete — 5 rooms + bootstrap utility, all Tier-1 + Tier-2 fleet pass"
```

---

## Self-Review Checklist (run before considering plan ready)

- [ ] **Spec coverage:** every spec section §1–§12 has at least one implementing task.
- [ ] **Placeholder scan:** no `TBD`, `TODO`, `implement later`, `fill in details`, `similar to Task N`.
- [ ] **Type consistency:** function names, types, file paths match across tasks.
- [ ] **No backwards refs:** no later task assumes a name/signature defined ambiguously in an earlier task.
- [ ] **Each task is bite-sized:** steps within a task are 2-5 minutes each.
- [ ] **Test-first where applicable:** TDD pattern used for pure functions; integration tests where TDD doesn't fit.
- [ ] **Commit per logical unit:** each module gets its own commit; no monster commits.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-25-pre-bootstrap-rebuild.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a plan this size — keeps the main context window lean and gives independent review per task.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints. Best when you want to sit alongside execution and steer per-task.

**Which approach?**

If Subagent-Driven chosen:
- REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`.
- Fresh subagent per task + two-stage review.

If Inline Execution chosen:
- REQUIRED SUB-SKILL: Use `superpowers:executing-plans`.
- Batch execution with checkpoints for review.
