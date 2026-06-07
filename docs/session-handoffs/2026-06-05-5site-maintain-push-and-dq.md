# Session handoff — 2026-06-05 — 5-site maintain push + out_of_scope + data-quality

READ THIS FIRST next session, then `git log --oneline -15` on branch `chore/commit-pending-work-2026-06-05`.

## 2026-06-06 PART 2 — full-fleet validation + data fixes (READ THIS)

User asked for comprehensive validation + fix everything. Results:

**DONE + verified:**
- **gobles → MAINTAIN + validated** (honest gate). See site #3 below.
- **Full fleet validation** (`backend/scripts/_fleet-validate-2026-06-06.ts`): 58/65 maintain, 7 bootstrap
  (2 auctions hibid/icollector, 1 forum canadiangunnutz, 2 disabled basspro/millerandmiller, + sail). Daily
  stale-check cron LIVE (`0 4 * * *`, 11 runs done) + continuous verify (43,932 products/24h, 153,816/7d).
  Keyword search accurate, **0 out_of_scope leaks** (`_keyword-search-check-2026-06-06.ts`). Title 100%, price/stock ~98% fleet-wide.
- **rdsc.ca FIXED**: deactivated **1347** category + `?manufacturer=` faceted pages wrongly indexed as products
  (`_rdsc-cleanup2` + `_rdsc-final-cleanup`, soft-delete + backups). price 88%→**100%**, search clean. One-time
  2026-06-04 indexing event (0 added since), not actively re-indexing.
- **triggersandbows.com stock FIXED**: ecwid-on-wordpress (Instant Site). Backfilled via Ecwid storefront API
  `POST app.ecwid.com/storefront/api/v1/92697308/catalog/search` — stock from `flags.isAllVariationsSoldOut`,
  match DB.sourceId==identifier.productId. stock **12%→99%** (4326 fixes, `_triggersandbows-backfill-2026-06-06.ts`). Plain HTTP, no Playwright.

**Internalization rule (user, 2026-06-06):** deactivated/sold entries must be kept as records (price history) for
analysis; decide keep-vs-discard. System already satisfies this: ProductHistory (259,925 rows, changeKind price/stock/new)
+ soft-delete preserves the product row with its last price. Junk (category/nav pages, null price, no history) → discard bucket (soft-delete, flagged).

**CODE FIX #1 DONE (2026-06-06): `challenge-platform` WAF-pattern false-positive — FLEET-WIDE.**
   Cloudflare injects `/cdn-cgi/challenge-platform/scripts/jsd/main.js` on EVERY page (even passive) → the substring
   false-matched real pages on ALL CF sites → needless Playwright fallback (OOM/slow). Removed `'challenge-platform'`
   from FOUR code paths (code-reviewer caught 3 I missed): `product-verifier.ts:49` DEFAULT_WAF_PATTERNS,
   `catalog-crawler.ts:436` + `:849` (isBlocked regex), `watermark-crawler.ts:109` (isBlockedOrEmpty). Real challenges
   still caught by `_cf_chl`/`Just a moment...`/`cf-browser-verification` + Incapsula/Sucuri/Imunify360. Canonical
   classifier `scraper/cf-interstitial.ts isCfInterstitial()` already excludes the beacon (future: consolidate to it).
   tsc clean; no site DB `wafConfig.challengePatterns` has it; PROVEN: gobles product verify = plain HTTP, no PW fallback,
   real stock. Reviewed by engineering-code-reviewer (APPROVE-WITH-NITS; nits addressed).

## 2026-06-07 PART 3 — code-fix phase via harness (READ)
- **CODE FIX #2 DONE: faceted/category-URL exclusion** in `base.ts isNavUrl` — deny-list `[?&](manufacturer|brand|filter|color|colour|size|dir|cat|sort|order|price|...)=`. Reviewed vs ALL 358k products → 0 real products dropped (Odoo `?category=` deliberately EXCLUDED — 50 real products use it; OpenCart `?route=`/`product_id`, Volusion `?ProductCode=`, Shopify `?variant=` protected). GAP-B (multi-segment category PATHS) left to null-price upsert signal (no safe generic structural signal).
- **OPS FIX DONE (major): killed ~20 DUPLICATE WORKER processes.** The watchdog (`_worker-watchdog`) was respawning `npm run dev` without killing old ts-node-dev → ~10 worker clusters competing for BullMQ jobs → "job stalled more than allowable limit" failures fleet-wide + the earlier OOMs. Killed all + chrome; started ONE clean worker (no watchdog). Fleet recovered 11/10m → 54-60/5m. **TODO: fix watchdog's kill-all-before-respawn before re-enabling it.**
- **CODE FIX #3 DONE: sail.ca → MAINTAIN + validated.** New Searchspring-API catalog path in `generic-retail.ts` (`_fetchSearchspringPage`, config from `siteProfile.apiAlternative`, zero framework change — fits the api-stream model). 7 ammo/optics category filters = 1224 products (resultsPerPage NOT pageSize; `&page=N`; `&sort.created_at=desc`; stock=`variant_in_stock`). adapterType=generic-retail, needsPlaywright=false, expectedProductCount=1224. Reviewed (caught bolt-action→parts + rifle-ammo→firearm misclassification → fixed by sourcing `sourceCategory` from `category_hierarchy` leaf). Residue: 1997 out-of-scope old-crawl rows soft-deleted (sourceId-not-in-scope, NOT lastSeenAt; history preserved). Validated: hornady/vortex/federal/tikka return real results, bolt-action=firearm.
- **CODE FIX #4 DONE: triggersandbows thumbnails 0.1%→96.4%** (Ecwid real image = `defaultOptionsOverrides.variationOverrides.mediaItems[].image400pxUrl` + `seo.ogMetaTags.image`, CloudFront CDN; jsonLD.image was the store-page trap). Stock already 99%. Backfill script `_triggersandbows-thumb-backfill-2026-06-07.ts`.
- **CODE FIX #5 (g4c) DONE: g4cgunstore thumbnails 25%→98.8%** (the "40%" was 911 base64 placeholders). Source = WP REST `/wp-json/wp/v2/product` (open; WC Store API 403+in-stock-only). **Adapter root-cause fix: added `data-wood-src` (Woodmart lazy-load) to `base.ts:91 _thumbnailFromImg`** so future crawls keep real thumbnails. tsc clean.

**ALL CODE CHANGES UNCOMMITTED** on branch `chore/commit-pending-work-2026-06-05` (worker runs the working tree via ts-node-dev, so fixes are LIVE). Files: product-verifier.ts, catalog-crawler.ts, watermark-crawler.ts (WAF fix), base.ts (faceted-exclusion + data-wood-src), generic-retail.ts (sail Searchspring). Reviewer suggested splitting WAF + faceted + sail + g4c into separate commits. NOT committed (user rule).

**REMAINING (tail — follow-up):**
- townpost.ca thumbnails 6% (classifieds, nextjs-custom; images on detail pages / og:image — needs backfill or adapter work). marstar 86% / ellwoodepps 90% (minor, edge accessories).
- basspro.ca feasibility (WebSphere+WAF, enabled=false, 0 products).
- Fix `_worker-watchdog` duplicate-spawn bug, then re-enable.
- Ecwid ADAPTER thumbnail maintenance for triggersandbows (backfill fixed current; crawler still won't fetch mediaItems images for NEW products — needs adapter use of storefront API images).

**(superseded) earlier REMAINING list below:**
2. **Faceted/category-URL exclusion in extraction** (base.ts isNavUrl-style): exclude `?`-query URLs (e.g. `?manufacturer=`)
   and known category paths from being indexed as products (prevents rdsc-style re-pollution). Generic, helps fleet.
3. **sail.ca rebuild** (Searchspring API — see site #4). Default scope decision: index Hunting=3218, let out_of_scope filter gear (fleet-consistent).
4. **Ecwid real-image extraction** (triggersandbows thumb 11%): jsonLD.image is the STORE-PAGE URL (text/html, Mistake 31),
   storefront product-detail endpoint 404s, productResponseFields.media no-ops. Need real Ecwid image CDN source (jsApiOnly? v3 API w/ token?).
5. **Thumbnail gaps**: g4c 40% (lazy-load data-src), marstar 86%, ellwoodepps 90%, townpost 6% (classifieds re-crawl).
6. **basspro feasibility** (WebSphere+WAF, 0 products, parked).

All `_*-2026-06-06.ts` diagnostic/fix scripts are in `backend/scripts/` (gitignored). DB writes have `_*-backup-*.json`.

## TL;DR
Drove the 5 parked bootstrap RETAIL sites toward maintain, shipped a global apparel-exclusion
(`out_of_scope`), fixed live data-quality bugs, and committed a large backlog of prior-session work.
2 of 5 sites are now in maintain+validated. The worker OOM'd twice under concurrent Playwright — now
guarded by a watchdog.

## Git state
- Branch **`chore/commit-pending-work-2026-06-05`** (off `main`). **NOT pushed; main not updated.**
- Commits this session (newest first): `1393efa` dq extraction fixes; `15f0c68` out_of_scope productType;
  `8b28391` verify Availability-label stock; `edba173` (siteId,firstSeenAt) btree + pg_trgm GIN;
  `6bcc22f` docs/probe; `afd59d4` frontend live-search; `00e4dad` crawler hardening; `b0fd025` scraper
  listingOmitsStock; `00fe77e` matcher; `1220a4c` alert cursor-dispatch; `f7a474c` schema; `b9cff3c` gitignore.
- Pre-session uncommitted tree (~40 files) was reviewed + committed in Phase A (8 logical commits).

## Runtime state (IMPORTANT — both are background processes, NOT harness-tracked)
- **Worker**: `cd backend && npm run dev` (ts-node-dev). Crashed twice this session from OOM.
- **Watchdog**: `backend/scripts/_worker-watchdog-2026-06-05.ts` — polls crawlEvents every 3 min; if 0 in 8 min,
  kills ONLY the ts-node-dev worker (never `_stock-backfill`/itself) and respawns `npm run dev`. Keep it running.
- **OOM LAW (learned the hard way)**: worker has Playwright cap=3 (playwright-fetcher.ts). worker + 2 Playwright
  backfills = ~5 Chromium = OOM (exit 4294967295). Run only ONE Playwright-heavy job at a time alongside the worker.
  ts-node-dev `--respawn` does NOT recover hard crashes (only file-change restarts) — that's why the watchdog exists.

## The 5 bootstrap retail sites
1. **store.theshootingcentre.com — DONE (maintain + validated).** expectedProductCount set 6676->10362 (true
   crawled count; the 158 catalogUrls are the full store incl gear, NOT 158 firearm-only). verifyMethod=detail-page.
   556 apparel/lifestyle hidden via out_of_scope. Search verified: vortex->scopes (apparel suppressed), tikka->rifles.
2. **northprosports.com — DONE (maintain + validated).** OpenCart. Detail-page stock backfill ->99% real stock.
   verifyMethod=detail-page. Search verified clean.
3. **www.gobles.ca — catalogUrls FIXED + re-seeded; awaiting bootstrap re-crawl, then transition (2026-06-06).**
   lightspeed-ecom, plain HTTP (NO WAF, NO Playwright — handoff's "static blocked" was WRONG; every fetch 200).
   Investigation (2026-06-06):
   - Root cause was NOT just firearms-only catalogUrls. The old 84 had single-parent URLs for optics/ammunition/
     reloading/accessories/field-gear/maintenance — but LightSpeed PARENT pages show **subcategory tiles, not
     products** (verified), so those parents indexed ~0. Need LEAF categories (persona Mistake 22 + truenortharms rule).
   - Also: LightSpeed **hides out-of-stock from category listings** (mossberg-535 absent from both its brand AND
     type listing). So the sitemap (3887) OVER-COUNTS by 391 unreachable hidden-OOS. **Catalog walk is ground truth.**
   - Built catalogUrls from the nav megamenu: all depth>=2 leaf categories, classified depth-2 as LISTER (lists all
     products → drop child leaves) vs LANDING (tiles → keep child leaves). Firearms keeps BOTH axes (type-action
     leaves + brand leaves) because the type axis has no handgun category and brand axis misses Cooey/Maverick.
   - Walk-verified: full 264-cat set = 3496 listable; minimal 178 = 3468; +`/reloading/bullets/hornady/` (28 unique) = 3496.
   - **APPLIED to DB** (backup `backend/_gobles-profile-backup-2026-06-06.json`): catalogUrls 84->**179**,
     expectedProductCount 3876->**3496** (honest walk count), lastVerified bumped -> scheduler `maybeReseedStreamState`
     fired -> streamState 84->**179 streams** (77 preserved, ~95 fresh idle). Gate uses stored 3496 directly
     (maintain-readiness.ts:196); both auto-writers (scheduler:290, worker:398) are guarded on `!expectedProductCount`
     so 3496 is safe from sitemap re-probe. productCountMethod left as generic-product-sitemap but DORMANT.
   - NEXT: bootstrap crawl is walking the 95 new streams to index ~412 recoverable products (real ammo/optics/scopes).
     When active climbs to ~3496+ and search returns optics/ammo, run `_transition-site-2026-06-05.ts www.gobles.ca --apply`
     (honest gate, coverage now 96%+ on 3496) then `_validate-site-2026-06-05.ts www.gobles.ca leupold hornady vortex`.
   - Diagnostic scripts (all `_gobles-*-2026-06-06.ts`): gap, cats, classify, build-catalogurls, recover28,
     apply-profile, streamcheck, streaminspect, crawl-progress, monitor. catalogUrls saved /tmp/gobles-catalogUrls-final.json.
4. **sail.ca — DISCOVERY DONE (2026-06-06), rebuild pending (needs harness + scoping decision).** magento-2.x + Searchspring.
   Read-only Searchspring API probe (siteId `s8zq1c`, plain HTTP JSON, NO Playwright needed — needsPlaywright=true is WRONG):
   - **API:** `https://s8zq1c.a.searchspring.io/api/search/search.json?siteId=s8zq1c&resultsFormat=native&pageSize=100`
   - **Total catalog = 18,743** (general outdoor retailer: Fishing/Hunting/Camping/Footwear/Women/Men/Kids apparel).
     Only firearms-relevant slice = **`filter.category_hierarchy=Hunting` → 3218** (use `filter.` NOT `bgfilter.`/`ss_category_hierarchy`).
   - **STOCK FIELD = `variant_in_stock`** ("100"=in stock, "0"=OOS). The all-3080-OOS bug = crawler never reads it / defaults OOS. `saleable` field also present.
   - Result fields: name, price, msrp, regular_price, brand, sku, url, imageUrl/thumbnailImageUrl, category_hierarchy, instore_only, clearance, variant_in_stock, saleable, new, popularity.
   - **Scoping reality:** even "Hunting" (3218) is mostly hunting GEAR (blinds, chairs, cameras, SD cards, boots); firearms-relevant = ammo/optics/crossbows + any actual guns (uncertain sail sells firearms online). out_of_scope classifier handles gear (consistent w/ fleet), but may want to narrow to ammo/optics sub-cats — DECISION NEEDED.
   - NEXT (harness, testing-api-tester): add Searchspring-API crawl path (paginate search.json by category_hierarchy=Hunting),
     map stock from `variant_in_stock`, set catalogUrls to the API URL(s), expectedProductCount=3218 (Hunting), drop needsPlaywright,
     set adapterType. Diagnostic scripts: `_sail-profile-2026-06-06.ts`, `_sail-searchspring-probe-2026-06-06.ts`, `_sail-stockfield2-2026-06-06.ts`.
   - Persona lesson (backend-architect:51) said sort is hash `#/sort:created_at:desc` for the STOREFRONT; but crawling via the
     Searchspring API directly sidesteps the storefront sort entirely (API takes `sort.<field>=desc`).
5. **basspro.ca — parked, not started.** enabled=false, paused=true, 0 products, IBM WebSphere Commerce + WAF,
   expected 16543, needsPlaywright. NEXT: feasibility — can it be crawled (WAF bypass + WebSphere catalog
   API/sitemap)? If not, keep parked with a documented reason. Hardest; do last.

## out_of_scope (apparel/lifestyle exclusion) — SHIPPED + applied
- New productType `out_of_scope` in `product-classifier.ts` (Layer-0) with a STRUCTURAL FIREARM-SIGNAL VETO
  (firearm url-path/tags/sourceCategory never out_of_scope) — converged over 6 review rounds to ZERO firearm/
  optics/parts hidden. Apparel/lifestyle hide; functional caps/socks (battery cap, handguard cap, gun sock,
  scope+sock) KEEP.
- Enforced in `keyword-matcher.ts` searchProductIndex refine (covers search + alert-dispatch + daily-digest).
  Upsert (`product-upsert.ts`) runs the OOS veto over scraper-preset types. CATEGORY_MAP no longer maps apparel->gear.
- Fleet reclassify applied: 3844 rows -> out_of_scope (backup `backend/_reclassify-oos-backup-2026-06-05.json`).
  Search filter reads STORED productType, so any NEW polluted rows need re-crawl OR a re-run of the reclassify.

## Data-quality (live maintain sites)
- DONE: truenortharms `_bc_fsnf` faceted-nav excluded (`base.ts` isNavUrl) + 364 rows deactivated
  (delistReason=nav-page). townpost title-strip (`base.ts` extractTitle, gated on leading `$price` + `categories:`),
  `/api/og` card-image rejection (`product-verifier.ts` extractFromOpenGraph), classifieds host-normalization
  (`generic.ts` _normalizeClassifiedHost) + 7646 titles cleaned, 497 /api/og thumbnails nulled.
- PENDING: g4cgunstore.com thumbnails (60% null + 911 base64 placeholders; fix: read lazy-load `data-src`
  via WAF/Playwright path). triggersandbows.com thumbnails (89% store page-URL not image; Ecwid SPA — capture
  real image source / og:image per playbook Mistake 31; testing-api-tester persona). townpost existing-row
  thumbnails re-populate on re-crawl. townpost www->bare URL re-key (LOW urgency, no near-term dup risk in maintain).

## Phase B infra (DONE)
- Indexes created CONCURRENTLY on live DB via the DIRECT (non-pooler) Neon endpoint + modeled in schema
  (migrate-diff empty): `product_index_siteId_firstSeenAt_idx` (btree), `product_index_title_trgm_idx` (pg_trgm GIN).
  EXPLAIN confirms both used. pg_trgm extension created.
- `.env` DATABASE_URL got `&connection_limit=10&pool_timeout=20` (takes effect next worker restart; backup
  `.env.phaseB-backup.local`).

## Key reusable scripts (backend/, all gitignored `_*`)
- `_stock-backfill-2026-06-05.ts <domain> --apply` + `_stock-backfill-progress-2026-06-05.ts`.
- `scripts/_transition-site-2026-06-05.ts <domain> [--apply]` (checkMaintainReadiness + gate-checked transition).
- `scripts/_validate-site-2026-06-05.ts <domain> [keywords]` (search validation: fields + out_of_scope leaks + crawl events).
- `scripts/_worker-watchdog-2026-06-05.ts` (keep running). `_reclassify-oos-apply-2026-06-05.ts`, `_dq-cleanup-2026-06-05.ts`,
  `_apply-indexes-2026-06-05.ts`, `scripts/_5site-status-2026-06-05.ts`, `scripts/_batch-phase-2026-06-05.ts` (status).

## Readiness gate (maintain-readiness.ts:162 checkMaintainReadiness)
Blocks transition unless: coverage >=95% (active/expectedProductCount; `unknown` stock counts as NO-stock),
stockCoverage >= category threshold, priceCoverage, tiersComplete (all bootstrap streams' T4 done), hasWatermark,
verifyMethod set (store-api+endpoint OR detail-page). `transitionSiteToMaintain(id)` with NO skipReadinessCheck = honest.

## Gotchas
GateGuard hook: present facts before any Write + before first Bash. cwd resets to repo root -> `cd /d/Projects/FIREARM-ALERT/backend &&` first. Inline `npx tsx -e` mangles `$` -> write `.ts` files. `prisma db push` not migrate. Code changes go through the 3-role harness (implementer + code-reviewer + silent-failure-hunter) with personas from `.claude/agents/` inlined. Every DB write has a `_*-backup-*.json`.
