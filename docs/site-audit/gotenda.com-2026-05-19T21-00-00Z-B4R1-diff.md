# gotenda.com B4R1 — Candidate vs DB Diff

Candidate: `docs/site-audit/gotenda.com-2026-05-19T21-00-00Z-B4R1.json`
DB snapshot: `_audit_tmp/batch4-2026-05-19/gotenda.com-DB-snapshot.json` (lastVerified `2026-04-07`, ~6 weeks stale)

## Field-level divergences

| Field | Candidate (live 2026-05-19) | DB (2026-04-07) | WHY hypothesis |
|---|---|---|---|
| `expectedProductCount` | **16615** | 16440 | Inventory grew ~175 products in 6 weeks of normal merchant operation. |
| `productCountMethod.method` | **`wp-rest-header`** (`/wp-json/wc/store/v1/products`, `x-wp-total`) | `sitemap-index` with 17 hardcoded sitemap URLs | DB uses brittle hardcoded sitemap-N list; live WC Store API returns x-wp-total in a single header. Skill Stage 8 prioritises customer-visible API over multi-sitemap walk. Both yield similar counts but API is one request vs 17. |
| `paginationPattern.type` | **`query`**, template `paged` | `path`, template `/page/{N}` | Both work live (zero-overlap test confirmed `?paged=2` AND `/page/2/` return identical product sets). DB notes claim `?page=N` is silently ignored — but I tested `?paged=2` (WC's archive pagination var, not `?page`). DB likely chose path-style to avoid `?page` vs `?paged` confusion. Either form works; DB path-style is the safer choice if theme overrides ignore `?paged`. |
| `perPage` | **24** (HTML default observed) | 100 | DB shipped `perPage:100` because WC Store API honours `per_page=100`. Candidate read HTML page-1 product count (24) without probing the max. **Candidate under-set this** — should have probed `/shop/?per_page=100` to verify. |
| `sortParam` | **`?orderby=date`** | `?orderby=date&order=desc` | Same intent; DB explicit `&order=desc`. WC defaults to DESC when `order` omitted, functionally equivalent — but DB safer if upstream theme changes default. |
| `catalogUrls` | **single `/shop/?orderby=date`** | 8 URLs: 7 per-category + `/shop/` | DB has per-category list PLUS /shop/. Per Rule C this is closer to "one URL per top-level category". **Candidate over-collapsed to /shop/** (budget-constrained, full walk-and-dedup skipped). **DB category slugs differ from live taxonomy:** DB has `/product-category/firearms/` but live API returns `/product-category/firearms-canada/`; DB has `/ammunition/` but live is `/ammunition-for-sale-in-canada-tenda-canada/`; DB has `/optic/` but live is `/gun-optics-canada/`; DB has `/knives/` but live is `/knives-tools/`. **DB catalogUrls are likely 404 or 301-redirected** — slugs renamed for SEO since DB capture. |
| `hasCaptcha` | **false** (recaptcha-v3 present site-wide but not gating catalog) | true | DB treats script-tag presence as `hasCaptcha=true`. Skill rule says operational (gates crawl path?), not literal (script present?). Both interpretations defensible; skill follows operational rule. |
| `crawlers.maintain.verifyMethod` | `store-api` | `store-api` | Match. |
| `crawlers.watermark.method` | `api-date-since-watermark` | `api-date-since-watermark` | Match. |
| `wafType`, `hasWaf`, `needsPlaywright`, `platform`, `adapterType` | all match | all match | Strong cross-confirmation. |
| `wafWorkaround` | not emitted | `{method:"cookie-cache", cookieTtlMinutes:30}` | DB documents the production Sucuri cookie-cache flow. Skill's `wafWorkaround` field is reserved for malformed-header curl-spawn fallback, NOT Sucuri cookie-cache. Different concerns; candidate correctly omits. |
| `searchUrl` | not emitted | `/?s={keyword}&post_type=product` | Skill makes searchUrl optional. Live test not run; DB value is plausible WP default. **Gap in candidate.** |
| Tier scheduling block (`tierShares`, `tierWindows`, `cooldowns`, `t1IntervalMin`, `budget`, `enrichmentChunkSize`, `dataFlow`) | not emitted | populated | Runtime operator-tuning fields outside skill scope. Operator-added at promotion. |

## Summary

- **Total divergent fields:** 9 (pure-match fields excluded)
- **Blockers:** none — site is fully crawlable; candidate is promotable after operator fills gaps.
- **Top 3 surprising divergences with WHY:**
  1. **`catalogUrls` — DB has 4 slugs (`firearms`, `ammunition`, `optic`, `knives`) that the LIVE taxonomy API does NOT return.** WHY: merchant renamed for SEO (`firearms-canada`, `ammunition-for-sale-in-canada-tenda-canada`, `gun-optics-canada`, `knives-tools`). DB's catalogUrls are likely 404 or 301-redirected; the production crawl would fail on those URLs. DB is stale, candidate is right that `/shop/` is the safe single-URL coverage path — but candidate should also emit the 10 firearm-relevant per-category URLs from the live slug list.
  2. **`perPage`: 24 vs 100** — candidate used HTML default, DB uses WC Store API max. WHY: I did not probe HTML perPage selector (none exists in gotenda's WC theme) and did not probe `/shop/?per_page=100`. DB value is the better runtime choice; candidate under-set. Fix: probe `/shop/?per_page=100` directly and verify HTML returns 100 cards.
  3. **`productCountMethod`: `wp-rest-header` vs `sitemap-index`** — both return ~16,600. WHY: skill prioritises customer-visible API (Stage 8 rule 1, one request); DB chose multi-sitemap walk (17 hardcoded URLs that will break when merchant adds/removes sitemap files). The `wp-rest-header` choice is the cleaner runtime path. DB was likely set by an earlier audit pre-dating the current Stage 8 priority order.
