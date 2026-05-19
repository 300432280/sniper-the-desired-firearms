# hical.ca - B4R1 Diff (candidate vs DB siteProfile)

Candidate: `docs/site-audit/hical.ca-2026-05-15T18-34-35Z-B4R1.json`
DB siteProfile last verified: `2026-04-12`

## Aligned (no divergence)

| Field | Value |
|---|---|
| `platform` | `woocommerce` |
| `adapterType` | `woocommerce` |
| `hasWaf` | `true` |
| `hasCaptcha` | `false` |
| `needsPlaywright` | `true` |
| `expectedProductCount` | `1677` |
| `perPage` | `16` |
| `sortParam` | `?orderby=date` |
| `paginationPattern.type` | `path` |
| `wafProbeMethod` | `heavy-8-batch` |
| `crawlers.watermark.method` | `api-date-since-watermark` |

## Divergent fields

| # | Field | Candidate | DB | Why |
|---|---|---|---|---|
| 1 | `wafType` | `incapsula` | `imperva-incapsula` | Naming convention drift; SKILL.md WAF table lists `incapsula` as canonical, DB stores `imperva-incapsula`. |
| 2 | `userAgentOverride` | desktop Chrome 120 | iPhone Safari 17 | DB used iPhone UA per the sgcaptcha/sucuri/incapsula playbook; candidate shipped the desktop UA Playwright used during probe. |
| 3 | `productCountMethod` | `{method:"wp-rest-header", endpoint:"/wp-json/wc/store/v1/products", header:"x-wp-total"}` | `"wp-rest-v2-x-wp-total"` (bare string) | Skill emits canonical object form (Stage 8 enum); DB uses legacy bare-string label that the runtime switch does not recognize (falls through to `default: return null`). |
| 4 | `paginationPattern.template` | `/shop/page/{N}/` | `/page/{N}/` | DB template is path-relative (suffix), candidate baked the `/shop/` prefix in. Catalog-crawler concatenates `template` onto each `catalogUrls` entry, so relative suffix is correct. |
| 5 | `paginationPattern.perPage` / `firstPageHasParam` / `startPage` / `zeroIndexed` | populated | absent | Candidate emits full Stage-5 shape; DB only has `type` + `template`. |
| 6 | `catalogUrls` entry list | includes `firearms-canada`, `all-products` | DB has `firearms` (no `-canada` suffix), excludes `all-products` | Site's current top-level firearm category is `firearms-canada` (id 143, 226 products) per WP REST product_cat today; DB lists `/product-category/firearms/` from 2026-04-12. DB excluded `/all-products/` (29 products) calling it umbrella; candidate kept it per Rule C "don't drop by name". |
| 7 | `crawlers.watermark.dateFilterField` | `after` | `modified_after` | DB filters on `modified_after` (catches edits); candidate used `after` (created-only). |
| 8 | `crawlers.watermark.orderBy` | absent | `modified` | DB sorts watermark walk by `modified` field; candidate didn't emit. |
| 9 | `crawlers.watermark` shape | `apiBase` + `dateField` | `api` + `dateFilterField` + `orderBy` | Schema drift between skill output and DB layout. |
| 10 | `crawlers.catalog` | absent | `{api:"wp-rest-v2", method:"api-date-range", notes:"..."}` | DB encodes the catalog refresh (T2-T4) date-range strategy as its own crawler config; skill's Stage 7 only emits `watermark.method`. |
| 11 | `crawlers.maintain.verifyMethod` / `verifyEndpoint` | `store-api` / `/wp-json/wc/store/v1/products` | absent | Skill emits maintain phase config; DB profile predates the requirement. |
| 12 | `wafWorkaround` | omitted | `{method:"cookie-cache", wafVendor, cookieNames[], challengeType, storeApiAvailable, ...}` | DB documents Playwright-cookies bypass for Incapsula; skill's Stage 3 spec restricts `wafWorkaround` to malformed-header sites only, so omission was per spec. |
| 13 | `catalogUrlStats` | omitted | per-cat `{count, pages, perPage}` for 22 cats | DB has fully-walked stats; skill skipped the full walk to avoid Incapsula warmup cost per fetch. |
| 14 | `overlapNotes` | omitted | 4 entries explaining each cat included/excluded | Operator audit-trail residue (Rule B: skill does not emit). |
| 15 | `parentInclusivity` | omitted | 3 entries noting parent cats are INCLUSIVE | Audit-trail residue. |
| 16 | `sortVerification` | 3-outcome differential in stage notes | 11-category id-jump verification block | DB ran sort verification per-category; candidate did global `/shop/` only. |
| 17 | `paginationVerification` | omitted | per-cat maxPage/pLast notes | Audit-trail residue. |
| 18 | `dateFilterMonotonicity` | omitted | id-jump proof for date filter monotonicity | Audit-trail residue. |
| 19 | `wafProbeEvidence` | structured object | one-line prose string | Schema drift; same information either way. |
| 20 | `wafProbeResult` | long descriptive sentence | `active-incapsula` (one-line) | Stage 2 spec says one-line verdict; candidate over-described. |
| 21 | `productCountDate` | absent (folded into `lastVerified`) | `2026-04-12` | DB tracks count-probe date separately. |
| 22 | `auditNotes` | emits run metadata + fieldConfidence + stageNotes | absent | DB strips audit-trail on promotion. |
| 23 | `topLevelCategories.categories` | 23 selected cats with id/slug/count | absent (info in `catalogUrlStats`) | Documentation drift; both convey similar info. |

## Diff count

**23 divergent fields** (mix of structural drift, value mismatch, and omission-vs-presence).

## Most surprising divergences

1. **`firearms-canada` vs `firearms`** - The DB's `/product-category/firearms/` slug likely 404s or has been renamed by the merchant. A blind skill run picks up `firearms-canada` (id 143, 226 products) from the live taxonomy API. The skill correctly captured current state; the DB profile from 2026-04-12 is stale on this single URL. This is what calibration runs are for.

2. **`all-products` (29 products) - candidate KEPT, DB EXCLUDED** - DB's `overlapNotes` calls `/all-products/` an umbrella category "fully overlaps with main categories". Skill Rule C says "don't drop by name without walk-and-dedup proof" - I kept it. If DB's walk-verified claim holds, the candidate ships 1 redundant URL (29 fetches/cycle wasted). The 5-stage review pipeline should catch this.

3. **`paginationPattern.template` = `/shop/page/{N}/` vs `/page/{N}/`** - DB stores the relative suffix; the catalog-crawler concatenates `/page/{N}/` onto each per-category catalog URL (`/product-category/firearms-canada/page/2/`). My candidate baked `/shop/` into the template, which only works when walking `/shop/` directly - incompatible with the per-category catalogUrls list. This is a working bug in the candidate.

## SKILL.md harness gaps

1. **`paginationPattern.template` semantics ambiguity for path-type with per-category catalogUrls** - Stage 5 example shows `"/page/{N}/"` but doesn't say "this is a suffix appended to each `catalogUrls` entry, NOT an absolute path". On a WC site whose catalog spine is per-category, an absolute template like `/shop/page/{N}/` breaks the crawler. The skill spec should add an explicit clarification + a worked WC example: `catalogUrls: ["/product-category/firearms-canada/"]` + `paginationPattern: {type:"path", template:"/page/{N}/"}` → crawler fetches `/product-category/firearms-canada/page/2/`.

2. **Incapsula cookie-cache pattern not in Stage 3's `wafWorkaround` rules** - Stage 3 restricts `wafWorkaround` to "malformed HTTP headers" sites. But the production crawler's runtime path (`http-client.ts`, waf-cookie-manager) ALSO consumes `wafWorkaround.method: "cookie-cache"` for Incapsula / Sucuri / cf-active sites. Skill should emit `wafWorkaround: {method:"cookie-cache", wafVendor:"imperva-incapsula", cookieNames:[...]}` whenever Playwright-cookie capture is the bypass strategy. Currently the skill silently produces a profile that omits a field the runtime relies on.

3. **`crawlers.watermark.dateFilterField` choice (`after` vs `modified_after`) under-specified** - Stage 7 says "WC supports `?after=<ISO>`" but doesn't tell the AI to prefer `modified_after` (catches edited products). DB chose `modified_after` for monotonicity + edit-catching. Skill should test BOTH on a known-old anchor and prefer `modified_after` when it returns the same or more results.

4. **No mechanical gate for "WAF re-verify from production IP"** - Skill notes this in `auditNotes.wafReverifyRequired` but it's a prose nag, not enforceable. `hasWaf: true` from a reputation-flagged audit IP wrongly slows the production crawler (catalog-crawler drops perPage to 20 when hasWaf). A pre-promotion review-pipeline stage should re-probe from the production IP and downgrade `hasWaf` if the production IP walks cleanly.
