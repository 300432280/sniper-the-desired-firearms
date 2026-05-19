# R1 Candidate vs DB siteProfile — shooterschoice.com (2026-05-15)

Candidate: `docs/site-audit/shooterschoice.com-2026-05-15T08-53-56Z-R1.json`
DB read: today, MonitoredSite + siteProfile (last operator-edited 2026-04-12).
Validator: candidate passed 16/16 (score 100).

## Divergent fields (field-by-field)

| # | Field | Candidate (R1) | DB | One-line WHY |
|---|---|---|---|---|
| 1 | `hasWaf` | `false` (cloudflare-passive, operational) | `true` | Operator defensively flipped false->true on 2026-04-12 (DB notes: "CF passive with XSS rule"); SKILL.md operational rule says CF-passive should be false, but operator chose defensive baseline. |
| 2 | `expectedProductCount` | `4493` (customer-visible from WC Store API `x-wp-total`) | `11411` (admin `/wp-json/wp/v2/product` total, includes drafts/private) | DB uses admin REST endpoint as count source (matches its `productDiscovery` step); candidate followed SKILL.md table preference for customer-visible Store API total. Different sources, both valid; DB has `expectedInStockCount: 4311` for the Store-API side. |
| 3 | `productCountMethod.endpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wp/v2/product` | Same root cause as #2; DB chose admin REST as count source to match its discovery endpoint. |
| 4 | `catalogUrls` | `["https://shooterschoice.com/shop/"]` (1 URL, 100% coverage spine) | 30 `/category/...` URLs (explicit per-category list incl. typo-duplicates `4027-accessoires`, `tbsarrows-componets`) | DB built per-category list (Rule C "one URL per top-level category"); candidate picked single `/shop/` because it returns 4493 = exact Store API total. DB list includes `uncategorized` (operator kept catch-all). |
| 5 | `crawlers.maintain.verifyMethod` | `store-api` (SKILL.md Stage 3 derived-rule for WC) | `json-ld` | DB operator chose JSON-LD detail-page parsing over the Store API batch verify; both are valid for WC, but SKILL.md derived-rules table says `store-api` is WC default. |
| 6 | `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | absent (DB uses `json-ld` method, no endpoint) | Follows from #5. |
| 7 | `crawlers.bootstrap.apiEndpoints` | `{products:"/wp-json/wc/store/v1/products", taxonomy:"/wp-json/wp/v2/product_cat", maxPerPage:100}` | `{productDiscovery:"/wp-json/wp/v2/product", priceEnrichment:"/wp-json/wc/store/v1/products"}` | DB has a 2-step `dataFlow`: discover via admin REST (cheaper, includes drafts -> filtered later), enrich price/stock via Store API. SKILL.md doesn't prescribe this pattern; operator built it. |
| 8 | `wafProbeEvidence` field names | `sqliRuleFired`/`xssRuleFired` (R1) | `xssBlocked`/`uaFilter`/`rateLimit` (DB) | Same findings, different field-name conventions. R1 follows SKILL.md example-output.json shape; DB has its own shorter set. Cosmetic. |
| 9 | `wafLastProbedAt` | `2026-05-15T08:44:58Z` | `2026-04-12` (date-only) | Different timestamps (~33 days apart) and different precision. Expected on calibration runs. |
| 10 | `lastVerified` | `2026-05-15` | `2026-04-12` | Same as #9. |

## Fields candidate adds that DB lacks

| Field | Candidate value | Note |
|---|---|---|
| `captchaType` | `recaptcha-v3` (informational; hasCaptcha=false) | DB has no `captchaType` field. Candidate identified site-wide reCAPTCHA v3 (Contact Form 7) but classified hasCaptcha=false operationally. Net-new info. |
| `ageGate` | `{detected:false, type:null, bypassCookie:null}` | DB has no `ageGate` field. SKILL.md Stage 3 mandate. |
| `topLevelCategories` | 15 firearm-relevant categories with counts + totalsSumCheck prose | DB has no `topLevelCategories` structure. Candidate adds operator-reference documentation per SKILL.md Stage 4f. |
| `extractionSample` + `extractionTested` | 3 random products, all 4 fields valid | DB has no `extractionSample` field. SKILL.md Stage 4g mandate. |
| `auditNotes` (with fieldConfidence + 10 stageNotes + probeIp) | structured audit trail | DB has free-form `notes` string instead. Different shape, same intent. |
| `wafProbeResult` (full prose verdict) | long-form one-line summary | DB has short `wafProbeResult: "cloudflare-passive with active XSS rule"`. Both present; candidate is more verbose. |
| `crawlers.watermark.reason` | full evidence prose | DB omits the reason field. SKILL.md says required only when `full-catalog-sweep`; candidate added it as defensive documentation for `api-date-since-watermark`. |

## Fields DB has that candidate omits

| Field | DB value | Why candidate omitted |
|---|---|---|
| `siteProfile.notes` (free-form operator log) | Multi-line audit history | Per SKILL.md Rule B — operator audit-trail residue is not a target field. Candidate puts equivalent info in `auditNotes.stageNotes`. |
| `crawlPhase` | `"bootstrap"` | Runtime crawler state, not a pre-bootstrap output (changes after onboarding). |
| `dataFlow` | 2-step pipeline doc (WP REST -> Store API enrichment) | Operator-built optimization specific to this site; SKILL.md candidate shape doesn't include it. |
| `crawlers.maintain.cooldowns/tierShares/tierWindows` | Operator-tuned runtime ints | Per-site runtime tuning post-onboarding; not a pre-bootstrap target. |
| `crawlers.maintain.method` `"db-verification"` | runtime cycle flag | Same as above. |
| `crawlers.bootstrap.method` `"single-continuous"` | runtime flag | Same as above. |
| `crawlers.bootstrap.htmlFallback` | `true` | Same. |
| `productCountMethod.wpRestTotal` / `storeApiTotal` / `dateFilterEvidence` / `dateFilterVerified` | embedded evidence sub-object | Operator-added audit trail (Rule B residue). |
| `expectedInStockCount` | `4311` | Snapshot of in-stock count from 2026-04-12; runtime field, not a discovery output. (My candidate's `expectedProductCount: 4493` is conceptually closest.) |
| `hasRateLimit` | `false` | DB-only runtime flag. |
| `t1IntervalMin` | `17` | Runtime tier scheduling. |
| `budget` | `90` | Per-site token budget; runtime. |
| `siteCategory` | `"retailer"` | DB-only taxonomy field. |
| `timeout` | `15000` | Runtime HTTP timeout. |

## Fields that match (no divergence)

`platform` (`woocommerce`), `adapterType` (`woocommerce`), `hasCaptcha` (`false`), `wafType` (`cloudflare-passive`), `wafProbeMethod` (`heavy-8-batch`), `needsPlaywright` (`false`), `sortParam` (`?orderby=date`), `sortVerified` (`true`), `perPage` (`40`), `paginationPattern.type` (`path`), `paginationPattern.template` (`/page/{N}/`), `crawlers.watermark.method` (`api-date-since-watermark`), `searchUrl` (`/?s={keyword}&post_type=product`).

## Top-line summary

**10 substantive divergent fields** (per the WHY table above). Three structural patterns drive most of them:

1. **`hasWaf` operational vs defensive** (1 field): SKILL.md says CF-passive => `false` (operational rule); operator chose `true` defensively. Doctrinal disagreement.
2. **Customer-visible vs admin REST as count source** (3 fields: #2, #3, #7): DB uses admin REST `/wp-json/wp/v2/product` (11411, includes drafts/private/trashed) for discovery + counts; candidate uses Store API (4493 customer-visible). DB pattern is more thorough but requires the 2-step `dataFlow` to filter drafts. Sub-question: SKILL.md Stage 7 spec mentions BOTH endpoints; admin REST is presumably better for newest-first walking (drafts and private have valid `modified` dates and surface modifications faster) but customer-visible is what the buyer sees.
3. **`catalogUrls` shape: single spine vs per-category** (1 field): DB has 30 URLs (explicit per-category, includes typo-duplicates and `uncategorized`); candidate picked `/shop/` (1 URL, 100% coverage proven). SKILL.md Rule C accepts both. DB shape is more granular for operator-side filtering; candidate is simpler and harder to drift.

Plus minor: maintain `verifyMethod` (`store-api` vs `json-ld`), `wafProbeEvidence` field-name mismatch, dates.

No field would block validator (candidate scored 16/16). The DB's `expectedProductCount: 11411` is the admin REST endpoint's total — promoting the candidate as-is would shift the count source from admin to customer-visible without explicit operator review.
