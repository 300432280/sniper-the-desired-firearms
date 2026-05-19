# Round 4 — Synthesis (Orchestrator, Karpathy §1–§4 throughout)

Batch: 2026-05-15 re-run with Karpathy + ECC skills (10 sites, 4 rounds, 30 agent-spawns, no DB writes).

Sites: gunpost.ca, shooterschoice.com, internationalshootingsupplies.com, budgetshootersupply.ca, dantesports.com, fishingworldgc.ca, oleysarmoury.com, alsimmonsgunshop.com, pavillonchassepeche.ca, leverarms.com.

---

## A. Per-site final corrections — fields that need to change (no DB writes)

| Site | Final correction set |
|---|---|
| **shooterschoice.com** | Use R2 as-is. `paginationPattern.template = /page/{N}/`; `expectedProductCount = 11370` (4493 in-stock + 6877 OOS, 5-way confirmed); `verifyMethod = json-ld` (avoids silent loss-of-signal for 6877 OOS — see B2#3); `wafType = wordfence-on-cloudflare-passive` (5 Wordfence strings in 403 body); `4027-accessoires` and `tbsarrows-componets` are real categories (R1 fabricated "typo 404"). |
| **gunpost.ca** | Use R2 **except** classifieds fields: `soldDetection = ["field-sold Yes"]` ONLY (R3 confirmed runtime regex matches both `sold Yes` and `sold No`); `wantedDetection` must NOT be an array (Array.toString() coercion bug — pipe-joined string or omit). `expectedProductCount = 25,186` (3 independent methods: pager walk, province facet sum, new_in_box facet sum all agree exact). |
| **internationalshootingsupplies.com** | Use R2 as-is. `expectedProductCount = 5237`; `catalogUrls = 80 leaf`; **`verifyMethod = store-api`** (operator's explicit 2026-04-03 incident decision — accepts silent-loss-of-signal tradeoff for this site's 2923 OOS to prevent wrongful deactivation); remove `crawlers.catalog` (dead audit-trail residue, confirmed via repo-wide grep). |
| **budgetshootersupply.ca** | Use R2 as-is. `expectedProductCount = 2809` (5 independent methods all agree exact, min/max ids match); `catalogUrls = ['/products/']` (API-only mode; HTML branch unreachable per `catalog-crawler.ts:358` traced); `apiDateFilter.param = modified_after` (runtime-hardcoded at `woocommerce.ts:337`); `hasWaf = false`. |
| **dantesports.com** | Use R2 **with corrections**: **strip `/en/` prefix from API endpoints** — decoration only, runtime uses `${origin}` (R3 confirmed prior R3, this R2 was wrong); `expectedProductCount = 2131` (not R2's 2130 — bare origin is what runtime sees); `unclassified solo-count = 13` not 14 (1 multi-cat); `wafType = wordfence-on-cloudflare-passive`; `perPage = 100` (Store API max, `woocommerce.ts:293` clamps). |
| **fishingworldgc.ca** | Use R2 as-is. `paginationPattern.perPage = 24` (3-method confirmation); `perPage = 250` (API); `catalogUrls = ['/collections/all']` (zero unique outside, verified across 3 NEW sub-collections beyond R2's set); `hasWaf = false`; `verifyMethod` correction is label-canonical only (identical runtime path). |
| **oleysarmoury.com** | Use R2 **with refinements**: `tokenCacheTtlMs = 172,800,000` (48h actual JWT TTL, not R2's 1h — 48× wasted re-scrapes); `tokenScrapeUrl = '/'` (site-wide JWT — 3 catalog pages return byte-identical JWT); `productCountMethod.url` must be path-only; keep `/swag/` (64 unique, zero overlap); `hasWaf = false`. |
| **alsimmonsgunshop.com** | Use R2 as-is. `expectedProductCount = 160` (instock 160 + outofstock 1502 + onbackorder 0 = 1662 admin total); `productCountMethod = wp-rest-header` (not `dual-api`); `hasWaf = false` (60-burst at 800ms all 200, last10 faster than first10). **Note**: R2's "consignment-hidden" narrative was mechanistically wrong (real mechanism is WC `hide_out_of_stock_items`); numeric correction unchanged. |
| **pavillonchassepeche.ca** | Use R2 **with framing correction**: there is **NO Rule-C-vs-full-coverage conflict** (both files say "firearm-relevant" verbatim — R2 misread). R1's exclusion of fishing/clothing/outdoors is playbook-correct; DB's wider set is operator override. **`verifyMethod = json-ld` routes to Playwright** via `worker.ts:769` (overturns prior batch's "dead code" verdict). `expectedProductCount = 1243` (Store API today, DB's 1318 is 33-day stale). `perPage` schema split: `paginationPattern.perPage = 36` (HTML), `perPage = 100` (API). WPML: x-default = FR (EN is alternate, not co-equal). |
| **leverarms.com** | Use R2 as-is. `paginationPattern.template = /page/{N}/` (6-permutation simulation, leading slash decisive); `expectedProductCount = 972` (5-way confirmed); `hasWaf = false`. **`crawlers.bootstrap.apiEndpoints` is pure audit-trail residue** — repo-wide grep (incl. frontend) zero consumers, no validator. |

---

## B. Cross-cutting lessons learned by artifact

### B1. SKILL.md gaps (revised from prior batch — 15 items, biggest first)

1. **`verifyMethod` is an operator-policy decision, not a default.** Both `store-api` and any-truthy-other-value are valid runtime paths with *different failure modes*:
   - `store-api` → fast-path; prevents wrongful deactivation (2026-04-03 fix) BUT silently no-ops OOS-transition products (`worker.ts:549` unconditional `handledProductIds.push` → caller early-returns at L711 → never reaches Playwright fallback at L759-769). Result: restock detection dies silently.
   - non-`store-api` truthy (`json-ld`, `detail-page`, anything) → `worker.ts:397` returns null → falls through to `verifyProductsViaPlaywright` unconditionally at L769. Catches OOS transitions, slower (10-100×). Comment at L768 says `'detail-page'` is canonical but code accepts any truthy value.
   - SKILL.md must name this tradeoff and force operator policy per site at promotion.
2. **Stage 8 validator gate against runtime switch.** Confirmed across 6+ sites: `dual-api`, `products-json-walk`, `pagination-walk`, `wp-rest-api`, `bc-xmlsitemap`, `dataFlow` all DB labels that fall through `product-count-probe.ts:148-451 default→return null`.
3. **WC `?modified_after=` is the runtime filter, not `?after=`.** Hardcoded at `woocommerce.ts:337`. Skill Stage 7 still documents only `?after=`. 44× different result sets at 7-day window.
4. **WP REST `?product_cat=` does NOT recurse; WC Store API `?category=` DOES recurse.** 19.6× to infinite coverage gap across 4 cats tested. Using WP REST per-category → 95% silent coverage collapse.
5. **`/en/` and other locale prefixes in API endpoints are DECORATION.** Runtime uses `${origin}/wp-json/...` per WHATWG `new URL().origin` (no pathname). SKILL.md must not emit prefix-bearing `apiEndpoint` shapes on WPML sites.
6. **`catalog-crawler.ts:358` break-on-zero kills HTML fallback** when WC parent-category page renders tiles instead of products (Astra/Woodmart themes). Stage 4 must walk every URL and verify products exist, not subcategory tiles.
7. **`paginationPattern.template` MUST have leading slash.** `catalog-crawler.ts:121-125` strips baseUrl's trailing slash; `page/{N}/` produces broken `gunspage/2/` (404).
8. **WC `expectedProductCount` choice depends on watermark crawler config.** Watermark queries WP REST `/wp/v2/product` → admin total is right denominator. Customer-visible Store API is right when `storeApiOnly: true`. Conditional must be encoded.
9. **`crawlers.bootstrap.apiEndpoints` is pure audit-trail residue (Rule B).** Repo-wide grep zero runtime consumers. No validator (only `.watermark.*` validated at `profile-validator.ts:97-165`). Should be **removed from output target**.
10. **Sticky/promoted listings inflate pagination math on classifieds** (gunpost: 15 regular + 3 sticky rotating per page; naive `pages × 18` over-counts by 5,040). Stage 8 must use facet-sum or province-sum cross-check.
11. **WC Store API combined-stock-filter syntax**: `stock_status[N]=` bracketed array required; repeated-key form collapses via PHP last-write-wins. Skill should document for OOS-walk discovery.
12. **JWT TTL must be decoded from JWT itself, not defaulted to 1h.** BC GraphQL JWT is 48h; default 1h causes 48× wasted re-scrapes.
13. **`wafType` is cosmetic for crawler runtime but consumed by frontend admin UX** (5 references in `frontend/src/app/dashboard/admin/profiles/page.tsx`). Skill must still set it correctly for operator triage.
14. **WPML/multilingual canonical**: `<link rel="alternate" hreflang="x-default">` is authoritative. x-default = site-canonical; other locales are alternates. Skill should default to x-default and document operator's override path.
15. **No Rule-C vs `feedback_full_coverage.md` conflict** — both files say "firearm-relevant" verbatim. Skill's Rule C and project's Full Coverage rule agree. Prior R4 synthesis claim of conflict was wrong.

### B2. Runtime code bugs (file separately — not pre-bootstrap concern)

1. **`product-verifier.ts:259-260` wantedDetection array→regex coercion**. `new RegExp(arrayValue, 'i')` with array input → `Array.toString()` → comma-joined nonsense regex. Wanted classification silently disabled fleet-wide.
2. **`product-verifier.ts:290-301` soldDetection regex matches both "Yes" and "No"** qualifiers. On gunpost (37k listings), would flag every alive ad sold. Only `["field-sold Yes"]` exact-match works.
3. **`worker.ts:549` unconditional `handledProductIds.push` + L711 early-return → silent loss-of-signal under `verifyMethod=store-api`** for OOS-transition products. Architectural tension between the 2026-04-03 anti-deactivation guard (L537-546) and the restock-detection signal path. Either:
   - Make the L549 push conditional on actual update happening, OR
   - Force a separate slow-path verify for OOS products under store-api.
4. **`product-count-probe.ts` has no schema validator** for `productCountMethod.method`. Unknown labels silently disabled.
5. **`adapter-registry.ts:116` confirms `adapterType` is sole routing key.** `crawlers.catalog.method` is ignored. DB profiles where these disagree are silently inconsistent.

### B3. Harness / methodology gaps (R1→R2→R3 process)

1. **`worker.ts:381-400` control-flow requires reading BOTH branches of L397 gate.** Prior R3 stopped at the guard (L537-546) and concluded "safe." This batch's R3 (3 sites agreeing — shooterschoice, ISS, pavillon, fishingworldgc) traced through to L711 early-return and L759-769 else branch, surfaced the silent-loss-of-signal mechanism. Lesson: trace through to the **caller's** decision, not just the callee's local guard.
2. **Subagent grep must include the full repo, not just `backend/src`.** Prior R3 missed 5 frontend consumers of `wafType`. This batch's R3 (dantesports) found them by globbing `frontend/src/`.
3. **R2's "high confidence" can still be wrong on framing.** R3 caught: dantesports R2's "/en/ prefix is runtime" (decoration); alsimmons R2's "consignment-hidden" narrative (real mechanism is `hide_out_of_stock_items`); pavillon R2's "Rule C vs full_coverage conflict" (both files verbatim agree). High-confidence numeric correction can be right while accompanying narrative is wrong.
4. **Skeptic round delivers value when there's a runtime code path to read.** 7/10 R3 returned 0 counters because R2 had already done line-by-line work. The 3 wins (gunpost soldDetection/wantedDetection, dantesports /en/-decoration + wafType-frontend-consumers, pavillon Rule-C reconciliation) all came from R3 reading code or files R2 didn't.
5. **R1 can fabricate evidence even with Karpathy injected.** R1-shooterschoice claimed `4027-accessoires` was a "typo 404 duplicate"; live probe returned 200 with 112 products. Karpathy §1 reduces but doesn't eliminate confident-wrong claims. R2 catches these on different fields each batch.
6. **Cross-batch verification surfaces incomplete prior reasoning.** Last batch's R3 ruled `'json-ld'` was dead code; this batch's R3 (3 sites) overturned that by reading the else branch. Without the meta-adversarial pass on prior R3, the wrong ruling would have propagated.

---

**Round-by-round artifacts**: `docs/site-audit/<domain>-2026-05-15T*-{R1,R2,R3}-*.{json,md}` (30 files).
