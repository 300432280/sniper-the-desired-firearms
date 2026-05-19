# Diff — g4cgunstore.com — Candidate B4R1 vs DB siteProfile

- Candidate: `docs/site-audit/g4cgunstore.com-2026-05-15T18-45-42Z-B4R1.json`
- DB row: `monitoredSite.findFirst({domain:'g4cgunstore.com'})` read 2026-05-15
- DB `lastVerified`: 2026-04-07 (~38 days old)

## Summary

13 divergent fields. The two most consequential disagreements:
1. **WAF severity**: DB says `cloudflare-passive` + `needsPlaywright: false` + http-direct works. Candidate observed Cloudflare 403 on desktop Chrome/curl/bot UAs AND SiteGround sgcaptcha persistently triggering on rapid /wp-json/* calls, requiring `needsPlaywright: true` + iPhone UA.
2. **adapterType**: DB has `generic-retail`; per SKILL.md Stage 3 platform→adapterType mapping, `woocommerce` should map to `woocommerce` (a registered adapter file exists at `scraper/adapters/woocommerce.ts`).

## Divergent fields

| Field | Candidate | DB | One-line WHY |
|---|---|---|---|
| `adapterType` | `woocommerce` | `generic-retail` | SKILL.md table maps platform `woocommerce` -> adapterType `woocommerce`; DB used the generic fallback at audit time, likely a policy choice not a discovery error. |
| `wafType` | `cloudflare-active` | `cloudflare-passive` | DB 2026-04-07 audit saw HTTP 200 on every UA. Candidate 2026-05-15 saw 403 on desktop Chrome/curl/bot UAs + 10/10 rapid burst 403s + SQLi/XSS rule fires - WAF posture has tightened OR audit IP reputation differs (per SKILL.md Rule "WAF results are IP-dependent"). |
| `needsPlaywright` | `true` | `false` | DB ran http-direct successfully. Candidate hit persistent SiteGround sgcaptcha (Mistake 30) and Cloudflare 403 on non-iPhone UAs -> Playwright cookie-cache needed at runtime. |
| `userAgentOverride` | `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 ...)` | absent | DB run worked without UA override; candidate needs iPhone Safari to pass CF + handle sgcaptcha (Mistake 30 Fix B). |
| `wafWorkaround.method` | absent | `http-direct` | DB explicitly noted "no workaround needed". Candidate cannot ship http-direct because of cloudflare-active + sgcaptcha. |
| `expectedProductCount` | 5848 | 5741 | Both same probe (`x-wp-total` on `/wp-json/wp/v2/product?per_page=1`); +107 catalog growth between 2026-04-07 and 2026-05-15 (normal merchant growth, not a divergence in method). |
| `catalogUrls` (count) | 22 (all parent=0 cats) | 6 (operator-pruned minimum-cover set) | DB completed Stage 4d walk+dedup in 2026-04-07; candidate's walk was BLOCKED by sgcaptcha so kept ALL 22 parent=0 categories per Rule C ("never drop empty-today or seemingly-redundant categories without proof"). DB's curated 6 is the more correct shape. |
| `catalogUrls` (membership) | missing `/product-category/sights-optics/` | includes `/product-category/sights-optics/` (587 prods) | Candidate's taxonomy-API page 1 returned 100 cats; the `sights-optics` parent=0 category lives on page 2 of `/wp-json/wp/v2/product_cat` and page 2 was sgcaptcha'd. Real gap in candidate coverage. |
| `sortParam` | `?orderby=date` | `?orderby=date&order=desc` | DB includes explicit `&order=desc`; candidate read raw `<option value="date">` from `<select>`. WC "date" option defaults to desc anyway, but DB form is more explicit/correct. |
| `sortVerified` | `false` | implicit-true (DB confirmed `?after=DATE` returns 271) | Candidate's 3-outcome counter-control BLOCKED by sgcaptcha. |
| `crawlers.maintain.verifyMethod` | `store-api` | `wp-rest` | SKILL.md Stage 3 default table says woocommerce -> `store-api`. DB explicitly chose `wp-rest` because `/wp-json/wc/store/v1/products` returns 403 (verified AGAIN in candidate audit - same 403). DB is correct; SKILL.md default does not require a live-reachability check of the store-api endpoint. |
| `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wp/v2/product` | Same root cause as verifyMethod above - store-api blocked at CF edge for this site, must fall back to WP REST. |
| `searchUrl` | `/?s={keyword}&post_type=product&product_cat=0` | `/?s={keyword}&post_type=product` | Candidate included `&product_cat=0` from the homepage search anchors. `product_cat=0` is a no-op default; DB form is cleaner. |

## Non-divergent (sanity verification)
- `platform`: both `woocommerce` ✓
- `hasWaf`: both `true` ✓
- `hasCaptcha`: both `false` ✓
- `paginationPattern.type`: both `path` ✓ template `/page/{N}/` (candidate adds trailing `/`, DB has `/page/{N}` — cosmetic)
- `perPage`: both `24` ✓
- `productCountMethod.method`: both `wp-rest-header` on `/wp-json/wp/v2/product` ✓
- `crawlers.watermark.method`: both `api-date-since-watermark` ✓
- `crawlers.bootstrap.apiEndpoints`: both point to `/wp-json/wp/v2/product` ✓

## SKILL.md harness gaps surfaced

1. **WAF severity drift between audits is a known phenomenon (per SKILL.md Stage 2 "WAF results are IP-dependent") but the skill has no mechanical reconciliation step against prior DB state on a calibration run.** A skill running today on this site as if NEW saw cloudflare-active; the prior 2026-04-07 audit saw cloudflare-passive from a different IP. SKILL.md should require: on calibration runs (existing site), DIFF the candidate's `wafType`/`needsPlaywright` against the DB row's same fields and emit a "WAF severity change detected" annotation so the operator can decide which IP/reputation to trust.

2. **`crawlers.maintain.verifyEndpoint` defaulting from a platform table can silently ship a broken endpoint.** SKILL.md Stage 3 defaults `woocommerce` -> `verifyMethod: store-api` + `verifyEndpoint: /wp-json/wc/store/v1/products`. For this site that endpoint returns Cloudflare 403 (since at least 2026-04-07). The candidate shipped the broken default because the harness does not require a live-fetch verification of the chosen `verifyEndpoint` before recording it. Stage 3 should add: "After choosing `verifyMethod`/`verifyEndpoint`, fetch `<endpoint>?per_page=1` and confirm 200. If 4xx/5xx, fall back to `verifyMethod: wp-rest` on `/wp-json/wp/v2/product`."

3. **Taxonomy-API paginated discovery is fragile when the site rate-limits.** SKILL.md Stage 4a says `GET /wp-json/wp/v2/product_cat?per_page=100&hide_empty=false` -> "array". For sites with >100 categories (this one has 158), the harness must page through the API. When page 2 gets sgcaptcha'd (this audit) the candidate silently misses parent=0 cats that live on later pages — `sights-optics` with 587 products is exactly such a gap. Stage 4a should require: (a) read `x-wp-total` first to know if pagination is needed, (b) if rate-limited mid-pagination, mark catalog discovery as inconclusive rather than ship a partial list, (c) optionally cross-reference homepage nav links as fallback when API pagination fails.
