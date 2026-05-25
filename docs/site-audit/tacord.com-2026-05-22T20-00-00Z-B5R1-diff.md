# B5R1 Diff — tacord.com vs DB snapshot

Run: blind R1 (no DB read before candidate). Date: 2026-05-22.
Candidate: `docs/site-audit/tacord.com-2026-05-22T20-00-00Z-B5R1.json`
DB snapshot: `_audit_tmp/batch5-2026-05-22/tacord.com-DB-snapshot.json`

## Summary

| | candidate B5R1 | DB |
|---|---|---|
| platform | woocommerce | woocommerce |
| adapterType | woocommerce | woocommerce |
| hasWaf / wafType | false / null | false / null |
| hasCaptcha | false | false |
| needsPlaywright | false | false |
| perPage | 12 | 12 |
| sortParam / sortVerified | `?orderby=date` / true | `?orderby=date` / true |
| paginationPattern | `{type:path, template:/page/{N}/}` | `{type:path, template:/page/{N}/}` |
| maintain.verifyMethod | store-api | store-api |
| maintain.verifyEndpoint | /wp-json/wc/store/v1/products | /wp-json/wc/store/v1/products |
| searchUrl | `/?s={keyword}&post_type=product` | `/?s={keyword}&post_type=product` |
| catalogUrls (set equality) | 8 URLs | 8 URLs — identical set |
| **expectedProductCount** | **206** | **203** |
| **watermark.method** | **api-date-since-watermark** | **navigate-from-watermark** |
| **productCountMethod.endpoint** | **/wp-json/wc/store/v1/products** | **/wp-json/wp/v2/product** |

**Total divergences: 3.** Zero divergences on access/identity/pagination/sort/catalog.

## Divergence WHYs (1-line each)

### D1 — expectedProductCount (206 vs 203, +1.5%)
**WHY:** drift between 2026-04-12 audit and 2026-05-22 audit. Both surfaces agree TODAY: WP REST `/wp/v2/product?per_page=1` returns `X-WP-Total: 206` AND Store API `/wc/store/v1/products?per_page=1` also returns `X-WP-Total: 206` (verified both, both customer-visible by current corpus). The DB value 203 is 40 days stale; 3 net new products since.

### D2 — watermark.method (api-date-since-watermark vs navigate-from-watermark)
**WHY:** DB notes field documents the historical reason: "2026-04-12: WP REST wp/v2/product returns 401 (auth-gated) ... Watermark downgraded api-date-since→navigate-from-watermark." But TODAY (2026-05-22) WP REST is NOT 401-gated — `GET /wp-json/wp/v2/product?per_page=1` returns HTTP 200 with X-WP-Total=206, and both two-probe directions of `?modified_after=` are honored (2099→0, 1999→206). Either the 401 was lifted by the merchant or the prior audit was wrong; candidate upgrades back to api-date-since-watermark since the WC adapter at `woocommerce.ts:337` hardcodes `modified_after` against WP REST core and the field works today.

### D3 — productCountMethod.endpoint (/wc/store/v1/products vs /wp/v2/product)
**WHY:** B8 pairing rule — `expectedProductCount` surface MUST match `crawlers.maintain.verifyMethod`. DB has `verifyMethod: store-api` but `productCountMethod.endpoint: /wp/v2/product` (admin WP REST) — pair-rule violation. Candidate ships them paired: both Store API. Today both surfaces happen to return the same total (206) so the divergence is mechanically invisible, but on shops with drafts/hidden the WP REST core total can exceed Store API customer-visible by 2.5×–10× (greatnorth: 4306 vs 528 = 8×). Pair-rule fix prevents future silent coverage gap if drafts appear.

## Non-divergence observations (for R2/R3 attack)

- **DB `crawlers.bootstrap.apiEndpoints` block (id 57-64)** — the skill explicitly says do not emit a `crawlers.bootstrap` block (Output target note: zero runtime consumers). Candidate respects this. DB has legacy block, harmless but should be cleared on next promotion.
- **DB `crawlers.maintain.method: db-verification`** and `verifyBehavior` — not in the skill's runtime field list. Operator residue.
- **catalogUrls match exactly (same 8 URLs).** Candidate proved coverage via union walk = 206 = global; DB had identical set already. No new categories appeared since 2026-04-12.
- **searchUrl matches exactly** (`/?s={keyword}&post_type=product`).
- **WP REST 401-gating from notes is STALE.** Today both `/wp/v2/product` and `/wc/store/v1/products` return 200 without auth and both X-WP-Total work.

## Blockers / inconclusive

None. All 9 stages completed with HIGH confidence on every field except `searchUrl` (medium — verified status 200 + 12 product cards on `/?s=stock&post_type=product` but did not confirm keyword filters correctly since DB value matches and 'stock' is a hot word that always returns results).

## R3 standing tasks delegated

- **Sustained per-UA walk (B9):** not run in R1 blind. R2 should run 50+ pages with each of the 5 production UAs from `http-client.ts:9-14` to confirm no UA-reputation 200→403 flip.
- **Sitemap/category-count cross-check (B11):** R2 should re-derive `topLevelCategories.categories[].allOption` per-category via Store API `?category=ID&per_page=1` X-WP-Total to confirm sum (now claimed = 239) — broaden 3×.
- **WP REST 401 history check:** R2 should look at `docs/site-audit/` history or git log for any prior tacord audit to confirm WP REST really did 401 at 2026-04-12, or if the prior auditor misread a different failure mode.

