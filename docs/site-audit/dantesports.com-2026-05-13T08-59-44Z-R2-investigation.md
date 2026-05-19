# dantesports.com R2 live investigation

Run: `dantesports.com-2026-05-13T08-59-44Z-R2`. Reviewer: testing-api-tester. Method: live HTTP probes with methods DIFFERENT from R1. NO DB writes; 800ms inter-request delay.

R1 file: `docs/site-audit/dantesports.com-2026-05-13T08-18-57Z-R1.json`
DB snapshot read 2026-04-30T08:00:45Z (siteProfile last touched 2026-04-11).

---

## Mandated tests (per R2 prompt)

### Orphan-walk result

R1 claim: **32 products unreachable** from 16 DB top-level catalogUrls; needs 3 extra subcat URLs (`vetements`, `entretien-d-arme-a-feu-2`, `lance-pigeon`).

R2 finding: **0 orphans**. R1 was misled by an API blind spot.

Evidence (chronological):

1. **WC Store API walk (R1's method, reproduced)**: 22 pages * 100 per_page -> 2117 unique product IDs matching `x-wp-total=2117`. Cross-referencing each product's `categories[].id` against the 16 top-level cat IDs yielded 13 apparent orphans (not R1's 32 but same general pattern). Sample orphan: `vortex-crossfire-point-vert`, with `categories: []` in the Store API response.

2. **Direct WP REST product fetch** for the same orphan slug returned `product_cat: [2305]`, where 2305 = `non-classe` (Uncategorized). The WC **Store API silently omits the "Uncategorized" assignment from its `categories[]` field** -- a documented WC behavior intended to hide the special Uncategorized term from frontends. This is the source of R1's wrong orphan list: R1 trusted Store API categories[] as the truth source for cat assignments.

3. **WP REST walk (truth source)**: 22 pages * 100 per_page on `/fr/wp-json/wp/v2/product?_fields=id,slug,product_cat` -> 2117 unique products with their real `product_cat[]`. Cross-reference against 16 top-level cat IDs (resolved via taxonomy parent walk): **0 orphans**. All 2117 products belong to a cat that is either top-level or descendant of a top-level in the 16-cat list.

4. **HTML inclusion test (definitive)**: Full HTML walk of `/fr/categorie-produit/accessoires/` p1..p25 (per_page=12 default) yielded 293 unique product slugs, matching Store API `?category=540 -> x-wp-total=293`. Then for 3 sampled products from `entretien-d-arme-a-feu-2` (subcat, parent=540) and 3 from `lance-pigeon` (subcat, parent=540): **all 6 appear in the parent `/accessoires/` walk**. Similarly `/autre-fr/` walk -> 267 slugs; all 3 sampled `vetements` products (parent=1715=autre-fr) appear there.

**Conclusion**: WC parent category pages on dantesports.com DO include descendant products. R1's 3 extra subcat URLs are harmless duplicates but NOT required. The 16 top-level URLs give 100% coverage. SKILL.md should retire the "parent excludes subcat" assumption (theme-dependent).

### WPML language test result

R1 claim: apex `/` -> 302 to `/fr/`. R1 picked `/fr/` (2117 products). DB picked `/en/` (2086 products, was 2116 fresh).

R2 finding: **UA-conditional redirect**, but R1's choice is runtime-aligned.

Evidence:

- `iPhone Safari UA` apex `/` -> HTTP 200 directly (FR content served at apex; `link` header points to `/fr/wp-json/wp/v2/pages/30959` = FR home).
- `Chrome Win64 UA` apex `/` -> HTTP 302 -> `/fr/`.
- `/fr/wp-json/wc/store/v1/products?per_page=1` -> `x-wp-total: 2117`
- `/en/wp-json/wc/store/v1/products?per_page=1` -> `x-wp-total: 2116` (one untranslated product on FR side)
- **Bare-origin `/wp-json/wc/store/v1/products?per_page=1` -> `x-wp-total: 2117`** (same as FR -- bare origin defaults to default-language).

**Runtime-code trace**: The woocommerce adapter (`backend/src/services/scraper/adapters/woocommerce.ts:340, 422, 530`) hardcodes endpoints as `${origin}/wp-json/wp/v2/product` and `${origin}/wp-json/wc/store/v1/products` -- uses **bare origin** with no language prefix. Therefore:
- DB's `crawlers.watermark.apiEndpoint = "/en/wp-json/wp/v2/product"` is **decoration-only** -- adapter ignores it
- R1's `/fr/wp-json/wc/store/v1/products` is **also decoration-only** -- adapter still hits bare origin
- Effective runtime endpoint = `https://dantesports.com/wp-json/wc/store/v1/products` -> returns FR catalog (2117 products) by WPML default

**R2 correction**: Both DB and R1 should drop the language prefix from `apiEndpoint`. The runtime is bare-origin FR by default. R1's `expectedProductCount: 2117` is correct. SKILL.md Stage 7 needs a warning that `apiEndpoint` field is documentation-only on woocommerce adapter.

### cf-active vs cf-passive verdict

R1: `cloudflare-active`. DB: `cloudflare-passive`. R2: **inconclusive -- SKILL.md itself is self-contradicting**.

Live battery (Chrome UA except where noted):

| Test | Endpoint | UA | Result |
|------|----------|----|--------|
| Normal home | `/fr/` | Chrome | 200 |
| Normal catalog | `/fr/categorie-produit/armes-a-feu/` | Chrome | 200 |
| Normal API | `/fr/wp-json/wc/store/v1/products?per_page=1` | Chrome | 200 |
| Bot UA | `/fr/` | curl/8.0.1 | 403 (edge UA filter) |
| XSS payload | `/fr/?s=<script>alert(1)</script>` | Chrome | 403 + CF block page |
| SQLi payload | `/fr/?s=test' UNION SELECT 1--` | Chrome | 200 (rule did not fire) |
| Rapid burst | 10 x `/fr/` | Chrome | 10/10 200 |

Rule-selective Cloudflare. Bot-UA filter active. XSS rule active. SQLi rule NOT active. Normal browser-UA crawler paths all return 200; rate-limit does not fire on legitimate UA.

SKILL.md self-contradicts:
- Line 200: "cf-ray AND any 5xx/challenge response -> cloudflare-active" -- but our 403s are not 5xx
- Line 205: "cf-ray AND all 200 AND no plugin markers -> cloudflare-passive" -- but we did NOT have "all 200" (curl UA -> 403)

Operational impact: `hasWaf: true` (with either tag) routes through `catalog-crawler.ts:403-413` Playwright fallback + drops perPage to 20 in some code paths. The production crawler uses browser UA which never triggers a 403 on this site, so the cost of cf-active treatment is unwarranted.

**R2 verdict**: kept R1's `cloudflare-active` as the conservative choice, but DB's `cloudflare-passive` is defensible. This is a SKILL.md gap, not an R1 error. The operator should weigh: edge-UA filter is real (real crawlers can get blocked if UA isn't browser-shaped), so `active` errs safe.

---

## Other findings

### perPage cap

Verified via pagination-link extraction (different method from R1's product-count extraction):

| `?per_page=` | max-page link found | implied perPage |
|------|---------------------|-----------------|
| (default) | 92 | 12 |
| 12 | 92 | 12 |
| 24 | 46 | 24 |
| 48 | 23 | 48 |
| 100 | 92 | 12 (silent fallback) |

Honored set is `{12, 24, 48}`. 36 also silently fell back to 12. R1's `perPage: 48` is correct; DB's `perPage: 12` recorded the floor not the cap.

### productCountMethod runtime check

DB stores `productCountMethod: "wp-rest-api"` as a **bare string**. The runtime function `probeExpectedProductCount` at `product-count-probe.ts:118` expects the discriminated union `ProductCountMethod` with `.method` property. The switch at line 148 falls through to `default: return null` because `"wp-rest-api".method === undefined`. **The probe is silently disabled for this site in production.** R1's object shape `{method:"wp-rest-header", endpoint:"...", header:"x-wp-total"}` fixes this. R2 additionally drops the `/fr/` prefix to match the bare-origin runtime endpoint convention.

### Sort verification

3-outcome counter-control:

| Variant | First slug |
|---------|------------|
| (default, no `orderby`) | `canuck-wrangler-regulator-action-a-levier-357-mag` |
| `?orderby=date&_nonce=R2` | `canuck-wrangler-regulator-action-a-levier-357-mag` |
| `?orderby=price&_nonce=R2` | `charles-daly-101-un-coup-410-ga` |

Default == `?orderby=date` (verified, identical first slug). `?orderby=price` is honored and differs. SKILL Stage 6 satisfied; `sortVerified: true` correct.

### Watermark date-filter

`after=2099-01-01` returns 0 (Store API, WP REST FR, WP REST EN). `after=1999-01-01` returns the full total on each. Date filter honored across all 3 endpoints.

### Pagination pattern

Walked `/fr/categorie-produit/accessoires/page/2/` through `/page/25/` -- all 200, all yielded new products. `/page/26/` -> 404. Pattern `/page/{N}/` confirmed. R1's leading-slash form `/page/{N}/` is canonical; DB's `page/{N}/` (missing leading slash) works in practice via adapter URL join.

### SPA / server-render check

Plain GET `/fr/categorie-produit/armes-a-feu/?per_page=48` -> 349 KB HTML, **48 server-rendered `<li class=product>` elements**, no SPA markers. `extractCatalogProducts` (`generic-retail.ts:931`, selector `'li.product'`) will work without Playwright. `needsPlaywright: false` confirmed.

---

## Top 3 corrections

1. **catalogUrls -- REJECT R1's 3 extra subcat URLs.** R1 was misled by the WC Store API `categories[]` Uncategorized blind spot. WP REST `product_cat` walk + HTML inclusion test prove the 16 top-level URLs give 100% coverage on this theme.

2. **productCountMethod.endpoint + crawlers.watermark.apiEndpoint -- drop `/fr/` prefix.** woocommerce.ts hardcodes bare-origin endpoints; the language prefix in siteProfile is decoration-only and misleading. Use `/wp-json/wc/store/v1/products`.

3. **wafType `cloudflare-active` vs `cloudflare-passive` is genuinely ambiguous.** SKILL.md self-contradicts on this case (rule-fired 403 on synthetic payloads when normal-UA paths return 200). Kept R1's `active` as conservative; flagged as SKILL gap.

---

## SKILL.md gaps surfaced

1. **Stage 4d "parent cat doesn't include subcats" is theme-dependent.** On dantesports (default WC theme behavior), the parent DOES include descendants. Replace the page-1-sample heuristic with a definitive HTML inclusion test: walk parent cat HTML, look up a known subcat product slug, verify presence.

2. **WC Store API `categories[]` silently omits "Uncategorized".** Audit harness must use WP REST `product_cat` field for coverage analysis -- never Store API `categories[]`. This caused 13-32 false orphans depending on which products fell into the special `Uncategorized` cat.

3. **Stage 2 cf-active vs cf-passive is ambiguous.** Synthetic-payload 403 + bot-UA 403 + normal-UA 200 doesn't fit either branch. Need an explicit rule: rule-fired 403 on a real crawler path -> active; rule-fired 403 only on synthetic payloads with normal-UA 200 -> passive.

4. **Stage 7 `crawlers.watermark.apiEndpoint` field is decoration-only on woocommerce adapter.** Adapter hardcodes bare-origin endpoints. WPML language scoping happens at the site (default-language served at bare origin), not via the profile field. Document this so future audits don't carefully craft language-prefixed endpoints that have no runtime effect.

---

## Artifacts

- `_audit_tmp/walk-dante-storeapi.js` -- WC Store API walk (reproduces R1's blind spot)
- `_audit_tmp/walk-dante-wprest.js` -- WP REST walk (truth source; 0 orphans)
- `_audit_tmp/test-parent-coverage.js` -- HTML inclusion test for parent cat coverage
- `_audit_tmp/perpage-confirm.js` -- perPage cap via pagination-link extraction
- `_audit_tmp/walk-output.txt`, `walk-wprest-output.txt`, `parent-coverage-output.txt` -- captured outputs
