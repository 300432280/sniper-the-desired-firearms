# R1 Candidate vs DB siteProfile — alsimmonsgunshop.com

Candidate: `docs/site-audit/alsimmonsgunshop.com-2026-05-13T08-25-28Z-R1.json`
DB siteProfile: read from `monitored_sites` where `domain='alsimmonsgunshop.com'` (lastVerified 2026-04-11)

---

## Divergent fields

| Field | DB value | Candidate value | One-line why |
|---|---|---|---|
| `hasWaf` (column) | `true` | `false` | DB set during 2026-04-11 audit; SKILL.md Stage 2 rule ("hasWaf is operational, not literal") says cloudflare-passive (all 8 batches 200) should be `false` to avoid the runtime perPage=20 throttle + cookie-manager overhead. |
| `expectedProductCount` | `1638` | `161` | DB uses wp/v2 admin total (1638→1661 today, includes 1500 OOS/sold consignment hidden from /shop); candidate uses customer-visible store-api in-stock count, which matches /shop's `Showing 1-9 of 161 results`. DB's own `expectedInStockCount: 168` is the closest match but stale. |
| `productCountMethod` | `{method:"dual-api", wpRestCount, storeApiCount, ...}` | `{method:"wp-rest-header", endpoint:"/wp-json/wc/store/v1/products", header:"x-wp-total"}` | `dual-api` is not in the runtime switch at `product-count-probe.ts:149-333` — falls to `default: return null`, silently disabling count probe. Candidate uses canonical `wp-rest-header` per SKILL.md Stage 8 table. |
| `catalogUrls` | 6 URLs (5 product-category + /shop/) | `["/shop/"]` | Rule C: minimum URL set with 100% coverage. /shop alone covers 161 (matches storefront total); per-category sum is 164 with consignment overlap. Per-category breakdown documented in `topLevelCategories.categories[]`. |
| `paginationPattern.perPage` | absent inside pattern object | `9` | DB has `perPage: 9` at top level but missing from pattern object; SKILL.md schema requires `perPage` inside the pattern. |
| `paginationPattern.startPage` / `zeroIndexed` | absent | `1` / `false` | DB pattern only has type/template/firstPageHasParam; SKILL.md schema requires startPage + zeroIndexed. |
| `crawlers.maintain.method` + `tierShares` + `tierWindows` + `cooldowns` + `verifyBehavior` | present | absent | Scheduler-tier fields managed outside pre-bootstrap; SKILL.md scope is `verifyMethod` + `verifyEndpoint` only. |
| `dataFlow` (2-step) | present | absent | Not a SKILL.md target field; operator audit-trail residue per Rule B. |
| `categoryTree` (full taxonomy w/ wpRestTotal) | present | replaced by `topLevelCategories.categories[]` | Skill emits operator-curated `{slug, allOption}` shape; DB includes raw wpRestTotal. Candidate matches the new harness's canonical shape. |
| `catalogUrlStats` | present | absent | Operator audit-trail residue (Rule B). |
| `paginationVerified` / `paginationVerifiedAt` / `paginationVerifiedEvidence` | present | absent | Rule B residue. SKILL.md only emits `sortVerified` boolean; pagination verification is implicit in pattern presence. |
| `sortVerifiedAt` / `sortVerifiedEvidence` / `sortVerifiedMethod` | present | absent | Rule B residue. |
| `lastVerifiedMethod` | `"full-7-phase-audit"` | absent | Rule B residue. |
| `wafProbeEvidence` shape | freeform string | structured `{cfHeaders, rapidBurstStatus, sqliRuleFired, ...}` | Skill emits structured object per Stage 2 spec. |
| `notes` (long operator memo) | present | absent | Operator audit-trail residue. |
| `wafProbeResult` | `"cloudflare-passive"` (bare label) | one-line verdict sentence | Both valid; skill prefers descriptive verdict over bare label. |
| `budget` / `t1IntervalMin` / `siteCategory` / `hasRateLimit` / `crawlPhase` | present | absent | Operator scheduler config, not pre-bootstrap output. |
| `searchUrl` | `"/?s={keyword}&post_type=product"` | same | Not divergent — kept identical. |
| `auditNotes.runId` / `fieldConfidence` / `stageNotes` | absent | present | Skill's audit-trail block per SKILL.md Output target. |

**Divergent field count: 17** (counting groupings where the value differs or one side is absent; reorganization of audit-trail residue from many fields into auditNotes counted as 1).

---

## Most surprising divergences

1. **`expectedProductCount` 1638 vs 161 (10× delta).** DB's stored value comes from wp/v2/product admin REST which surfaces sold/OOS consignment listings hidden from the public storefront. /shop and every customer-visible path returns 161. The DB's own `notes` field says "1,444 products wrongly discontinued by Store API verify" — this was the operational mistake that resulted from picking the wrong count source. Candidate prefers customer-visible 161 to avoid the same trap.

2. **`hasWaf: true` (DB column) vs `false` (candidate).** DB column was set true defensively on 2026-04-11 against the cloudflare-passive verdict. SKILL.md Stage 2's "operational, not literal" rule says passive Cloudflare with all-200 probes should be `false` to avoid the perPage=20 throttle and WAF-cookie-manager overhead the production crawler imposes. The DB's own siteProfile.wafType `"cloudflare-passive"` agrees with the verdict — only the column was set defensively.

3. **`productCountMethod.method: "dual-api"` is not a runtime-recognized method.** DB stored a freeform `{method: "dual-api", ...}` shape; the runtime switch in `product-count-probe.ts:149-333` has no `dual-api` case, so the count probe falls to `default: return null` and is silently disabled for this site. Candidate uses canonical `wp-rest-header` that matches the switch.

---

## SKILL.md harness gaps

1. **No guidance for WooCommerce sites with hidden OOS / sold consignment listings.** SKILL.md Stage 8 lists `wp-rest-header` against both `/wp-json/wc/store/v1/products` and `/wp-json/wp/v2/product` but doesn't tell the auditor which to prefer when they differ by 10×. A worked-example rule — "for consignment/used firearm shops where wp/v2 admin total >> store-api in-stock total, prefer the store-api total because the admin total includes sold listings hidden from /shop" — would prevent the trap the DB fell into. Stage 8's `notes` reference to "customer-visible total first" needs to be promoted to an explicit rule with this example.

2. **Rule C catalogUrls vs DB's pre-existing per-category list.** SKILL.md Rule C says "minimum URL count with 100% coverage" — for this site `/shop` alone suffices. But DB's existing list keeps per-category URLs that gave the prior operator richer signals (per-cat token budget, per-cat tier scheduling, easier category-restricted alerts). The skill doesn't address how to handle sites where the operator wants per-category granularity even when /shop covers 100%. A note like "if the runtime crawler uses per-category token budgets or category-filtered user alerts, prefer per-category catalogUrls even when /shop is a single-URL cover" would clarify the choice rather than mechanically minimizing.

3. **`hasWaf` column-vs-JSON-field promotion ambiguity.** Stage 2 mentions `hasWaf` is a DB column read by `crawl-scheduler.ts:209,282,576`, but the candidate JSON only contains the JSON field. When the candidate value differs from the existing DB column (as here: false vs true), the diff/review process should flag the column for re-promotion — otherwise R2 calibration may carry forward the stale column. SKILL.md should add an explicit note: "when re-auditing an existing site and the new `hasWaf` value differs from the DB column, flag the column in the diff for operator attention."
