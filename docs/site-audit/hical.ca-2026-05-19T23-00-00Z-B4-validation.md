# hical.ca — Batch-4 Validation (single round)

Date: 2026-05-19T23:00:00Z
Snapshot: `_audit_tmp/batch4-validation-2026-05-19/hical.ca-POSTFIX.json`

## Per-fix verdicts

| # | Fix | Verdict | Evidence |
|---|-----|---------|----------|
| 1 | catalogUrls replaced dead /firearms/ with /firearms-canada/ | PASS | DB: 23 URLs, has firearms-canada=true, has /firearms/=false. |
| 2 | expectedProductCount = 1676 | PASS | WP REST ?per_page=1 -> X-WP-Total: 1676; Store API ?per_page=1 -> X-WP-Total: 1676 (live, both endpoints). |
| 3 | productCountMethod = { method:'wp-rest-header', endpoint:'/wp-json/wp/v2/product', header:'x-wp-total' } | PASS | 'wp-rest-header' is in VALID_METHOD_NAMES (product-count-probe.ts:110-122). Bare-string form would have thrown in validateMethod. |
| 4 | crawlers.watermark.method = 'api-date-since-watermark' | PASS | In VALID_WATERMARK_METHODS; sortParam=?orderby=date set; dateFilterField='modified_after' (scoped to WP REST v2 primary; Store API fallback path in woocommerce.ts:419 correctly uses 'after='). |

## Adversarial

- **HTML category fetch (curl):** all /product-category/*/ requests return Incapsula 212-byte challenge page uniformly — old /firearms/ AND new /firearms-canada/ both. This is WAF behavior, not URL validity. wafWorkaround.method='cookie-cache' (Playwright, 13 cookies) is the canonical fetch path; curl is not authoritative for category existence. WP REST + Store API both reporting 1676 is the authoritative count proof.
- **Store API modified_after (R3 finding):** Runtime safe. woocommerce.ts:419 sets storeParams.after = options.dateAfter (NOT modified_after). Profile's dateFilterField applies to WP REST v2 (primary path), which honors modified_after. No mismatch.
- **profile-validator.ts Phase 3b (read 128-157):** C5 (productCountMethod.method in VALID_METHOD_NAMES) present at line 130 severity=required; C6 (crawlers.maintain.verifyMethod non-empty) present at line 150 severity=required.

## Regression found

**crawlers.maintain is undefined in DB.** With C6 required, validateSiteProfile() would REJECT this profile on re-promote. The four batch-4 fixes do not address it. Restock detection (worker.ts:769-772 path) is currently no-op for hical.ca. Recommend adding crawlers.maintain.verifyMethod = 'store-api' (storeApiAvailable=true per wafWorkaround).

## Overall

4/4 declared fixes verified. One latent gap (maintain.verifyMethod) surfaced.
