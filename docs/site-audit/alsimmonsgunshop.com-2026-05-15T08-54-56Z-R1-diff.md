# Pre-Bootstrap R1 Diff — alsimmonsgunshop.com

**Run:** R1 blind skill execution, 2026-05-15T08-54-56Z
**Candidate:** `docs/site-audit/alsimmonsgunshop.com-2026-05-15T08-54-56Z-R1.json`
**DB ref:** `MonitoredSite` row for `alsimmonsgunshop.com` (live read at run time)

## Divergent fields

| Field | Candidate (R1) | DB | One-line WHY |
|---|---|---|---|
| `hasWaf` (DB column + JSON) | `false` | `true` | SKILL.md Stage 2 rule: cf-ray + all-200 + no plugin markers = operational `false`; setting `true` slows the WC crawler for no operational benefit. DB has `wafType: cloudflare-passive` so the two flags contradict each other inside the same DB row. |
| `expectedProductCount` | `160` | `1638` | DB stores the WP REST admin-REST count (includes drafts/private); candidate uses Store API X-WP-Total (160, customer-visible inventory) because that matches what the catalog crawler actually walks. |
| `productCountMethod.method` | `wp-rest-header` | `dual-api` (non-canonical) | DB uses a non-canonical `method` string that does NOT exist in `product-count-probe.ts` switch — silently falls through to `default: return null`. Candidate uses the canonical `wp-rest-header` listed in SKILL.md Stage 8 table. |
| `catalogUrls` | `["/shop/"]` (1 URL) | 6 URLs (all 5 productive categories + /shop/) | Rule C minimum-cover: walked /shop/ = 160 dedup, category union = 163 (3 cross-tagged) all subsets of /shop/. Single URL achieves 100% coverage; per-category URLs are redundant. |
| `perPage` (top-level) | `100` | `9` | DB stores the HTML page default (9). Candidate stores the verified Store API max (100; the API rejects 250 with HTTP 400 `per_page must be between 1 and 100`). `paginationPattern.perPage` keeps the HTML value 9 in both. |
| `paginationPattern.perPage` | `9` | (absent) | DB profile omits `perPage` inside `paginationPattern` — SKILL.md Stage 5 now requires it inside the object. |
| `paginationPattern.startPage` | `1` | (absent) | DB profile omits — SKILL.md Stage 5 requires this for the path-based pagination URL builder. |
| `paginationPattern.zeroIndexed` | `false` | (absent) | DB profile omits — SKILL.md Stage 5 requires. |
| `extractionTested` / `extractionSample` | present (3 samples) | absent | New SKILL.md Stage 4g requirement; DB profile predates the spot-check. |
| `lastVerified` | `2026-05-15` | `2026-04-11` | 34 days stale in DB; today's audit re-derived everything live. |
| `wafLastProbedAt` | `2026-05-15T08:47:04Z` | `2026-04-11` (date-only) | Candidate stores full ISO timestamp; DB uses date-only. |
| `wafProbeEvidence` shape | structured object | freeform string | SKILL.md Stage 2 requires the small structured-object shape; DB stores a freeform sentence — runtime cannot key off DB form. |
| `auditNotes.fieldConfidence` + `stageNotes` | present (12 confidence keys + 9 stage notes) | absent | New required scaffold; DB has freeform `notes` field. |

## Same / equivalent fields

`platform=woocommerce`, `adapterType=woocommerce`, `wafType=cloudflare-passive`, `hasCaptcha=false`, `needsPlaywright=false`, `sortParam=?orderby=date`, `sortVerified=true`, `paginationPattern.type=path`, `paginationPattern.template=/page/{N}/`, `crawlers.watermark.method=api-date-since-watermark`, `crawlers.bootstrap.apiEndpoints` (both endpoints match), `crawlers.maintain.verifyMethod=store-api`, `crawlers.maintain.verifyEndpoint=/wp-json/wc/store/v1/products`, `searchUrl=/?s={keyword}&post_type=product`.

## DB has, candidate omits (intentional — Rule B audit-trail residue)

`paginationVerified`, `paginationVerifiedAt`, `paginationVerifiedEvidence`, `sortVerifiedAt`, `sortVerifiedMethod`, `sortVerifiedEvidence`, `dateFilterVerified`, `dateFilterVerifiedAt`, `dateFilterEvidence`, `categoryTree`, `catalogUrlStats`, `dataFlow.steps`, `crawlers.bootstrap.method=single-continuous`, `crawlers.bootstrap.htmlFallback=true`, `crawlers.maintain.cooldowns/tierShares/tierWindows/verifyBehavior`, `expectedInStockCount=168`, `t1IntervalMin=17`, `hasRateLimit=false`, `lastVerifiedMethod`, `siteCategory=retailer`, `budget=60`, `timeout=15000`, `perPageNote`, `wafProbeMethod=heavy-8-batch` (both have same value).

Per SKILL.md Rule B, these are operator audit-trail residue (`*Verified`/`*Evidence`/operator cooldown/budget tuning), not pre-bootstrap targets. Excluded from R1 candidate intentionally; operator will re-add tier windows / cooldowns at promotion time.
