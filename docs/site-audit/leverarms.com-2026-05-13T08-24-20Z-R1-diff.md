# Diff: Candidate vs DB siteProfile — leverarms.com (R1 blind run)

**Candidate:** `docs/site-audit/leverarms.com-2026-05-13T08-24-20Z-R1.json`
**DB read:** `MonitoredSite.findFirst({domain:'leverarms.com'})` at audit time 2026-05-13T08:24Z

## Aligned fields (no divergence)

`platform` `adapterType` `hasCaptcha` `wafType` `wafProbeMethod` `needsPlaywright` `paginationPattern.type` `paginationPattern.template` (semantically same, see below) `perPage` `sortParam` `sortVerified` `crawlers.maintain.verifyMethod` `crawlers.maintain.verifyEndpoint` `crawlers.watermark.method` — values match.

`catalogUrls` — same 6 URLs (different order; DB uses relative paths, candidate uses absolute).

---

## Divergent fields

| # | Field | Candidate | DB | Why divergence |
|---|---|---|---|---|
| 1 | `hasWaf` | `false` | `true` | DB column was set true at onboarding; candidate per SKILL.md "operational hasWaf" rule downgrades cloudflare-passive (rule-selective on attacks only, crawler paths 200) to `false`. DB JSON-field `siteProfile.hasWaf` is also `true`, but `siteProfile.wafType` is `cloudflare-passive` — internal contradiction in the DB row. |
| 2 | `expectedProductCount` | `356` | `965` | DB uses admin `wp/v2/product` REST total (includes drafts/private/trashed). Candidate per SKILL.md priority-1 (customer-visible Store API) uses `x-wp-total: 356`. DB ALSO records `storeApiTotal: 357` and `wpRestTotal: 965` inside `productCountMethod` for transparency. |
| 3 | `productCountMethod.endpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wp/v2/product` | Same root cause as #2 — DB chose admin REST, candidate chose Store API. |
| 4 | `paginationPattern.template` | `/page/{N}/` (leading slash) | `page/{N}/` (no leading slash) | Cosmetic; DB form is what WordPress permalink appender expects when joined to catalogUrl. Both render the same final URL. |
| 5 | `crawlers.bootstrap.apiEndpoints` | `{products, categories}` | `{priceEnrichment, productDiscovery}` (two-step shape) | DB encodes 2-step bootstrap: discovery via `wp/v2/product` (cheap title+url), enrichment via `wc/store/v1/products` (price+stock). Candidate flattened to discovery + categories — missed the enrichment dataflow. |
| 6 | `crawlers.maintain` extras | only `verifyMethod` + `verifyEndpoint` | DB also has `verifyBehavior` (onFound/onNotFound/canDetectDeletion), `method: "db-verification"`, `cooldowns`, `tierShares`, `tierWindows` | DB has operator-tuned scheduling + verification semantics. SKILL.md doesn't surface these — they are runtime crawler scheduler fields, not pre-bootstrap targets per Rule B. |
| 7 | `dataFlow` top-level block | absent | present (2-step API description) | DB documents the discovery+enrichment cascade. SKILL.md output shape doesn't define this field. Runtime field, not residue. |
| 8 | `searchUrl` | omitted | `/?s={keyword}&post_type=product` | Candidate noted as omitted-but-derivable; DB has the canonical WC form. SKILL.md says omit when not derived — but for WC this is deterministic and should be auto-emitted. |
| 9 | `expectedInStockCount` | not in candidate | `357` | DB has a separate in-stock count alongside total. SKILL.md shape doesn't include this field. |
| 10 | `wafProbeEvidence` shape | full object: cfHeaders[], rapidBurstStatus[], sqliRuleFired, xssRuleFired, honeypotPathsBlocked[], botUaBlocked, pluginWafMarkers[] | compact: cfRay, server, xss403, sqli403, noChallenge | Candidate matches SKILL.md "small subset". DB uses shorter operator-curated form. Both pass Rule B. Semantically equivalent. |
| 11 | `siteCategory` `budget` `timeout` `t1IntervalMin` `hasRateLimit` `crawlPhase` `notes` `name` | absent | present | Runtime scheduling/labeling fields outside the SKILL.md candidate shape. SKILL.md correctly excludes — operator-set post-onboarding. |
| 12 | `topLevelCategories` block | present (operator-readable per-cat walked counts) | absent | New SKILL.md recommended doc block; DB row predates the convention. |
| 13 | `extractionSample` / `extractionTested` | present | absent | New SKILL.md Stage 4g requirement; DB row predates it. |
| 14 | `crawlers.watermark` extras | candidate adds `apiEndpoint` + `dateParam` | DB has only `method` | SKILL.md Stage 7 shape says watermark needs `method` + `reason` (when full-catalog-sweep). The extra fields in candidate are not required — should be dropped. |
| 15 | `lastVerified` | `2026-05-13` | `2026-04-12` | Calibration run; DB is 30 days stale. Expected. |
| 16 | `url` (top of MonitoredSite row) | (not a candidate field) | `https://www.leverarms.com` (with www) | DB row has `www.` but candidate resolved canonical to apex (apex returns 200 + `<link rel=canonical>` declares apex). DB `url` may need correction. |

---

## Divergent field count

**16 divergent fields/clusters** (10 substantive + 6 cosmetic/structural).

## Most surprising divergences (3)

1. **`expectedProductCount` 356 vs 965.** Candidate followed SKILL.md priority order (customer-visible Store API first) and got 356. DB stores the admin `wp/v2/product` total of 965 — includes drafts, private, trashed posts. The DB row even contains BOTH (`storeApiTotal: 357`, `wpRestTotal: 965`) — operator chose 965 as primary. **SKILL.md harness gap**: the skill prefers customer-visible totals, but the operator chose full-inventory. Neither is wrong; they answer different questions. The skill should let the operator pick, or at minimum emit both like the DB.

2. **`crawlers.bootstrap.apiEndpoints` flat vs 2-step.** Candidate emits `{products, categories}`. DB emits `{priceEnrichment: store-api, productDiscovery: wp/v2/product}` — a 2-step bootstrap (cheap discovery → expensive enrichment). Real runtime distinction (the bootstrap crawler chains the two), but Stage 3 of SKILL.md only mentions a single `apiEndpoints` dict and gives no per-platform example. Skill emitted the field but missed the WC-specific shape.

3. **`hasWaf: false` vs `true`.** Candidate operationally downgrades cloudflare-passive (per SKILL.md Stage 2 rule), DB keeps `true`. Both `wafType` agree on `cloudflare-passive`. DB row is internally inconsistent (`hasWaf: true` AND `wafType: cloudflare-passive` AND `needsPlaywright: false`) — likely a holdover from the previous "wafType: sucuri" misclassification noted in `siteProfile.notes`. Candidate's downgrade is correct per current SKILL.md.

## SKILL.md harness gaps (3)

1. **No guidance on customer-visible vs full-inventory counts.** Stage 8 picks the first working method but never asks "does the operator track in-stock-only or include-drafts?". For WooCommerce, wp/v2 vs Store API totals can differ by 2-3x. Skill should either emit both (as DB does — `storeApiTotal` + `wpRestTotal` inside `productCountMethod`) or surface the choice in a prompt.

2. **`crawlers.bootstrap.apiEndpoints` shape under-specified for multi-step adapters.** SKILL.md Stage 3 says "adapter-specific" but gives no example. For WC the runtime expects a 2-step shape (`productDiscovery` + `priceEnrichment`); skill emitted a flat `{products, categories}` which the WC bootstrap adapter doesn't read. Add a platform-keyed table mapping platform → required `apiEndpoints` shape.

3. **`searchUrl` always omitted when WC default applies, but it's deterministic.** Stage 3 says "omit if not derived"; for WooCommerce the canonical search URL is universally `/?s={keyword}&post_type=product`. Skill should auto-emit this for `platform=woocommerce` (and Shopify `/search?q={keyword}` etc.) instead of leaving it out.

## Other notes

- Candidate's `extractionSample` titles are placeholder strings (e.g. `post-4152 (bolt-action rifle, guns p1)`) rather than actual product names. The Store API walk had real names (e.g. `RUSSIAN TYPE 45 SKS RIFLE 1950 SPRING LOADED FIRING PIN 18782`) — should have used those. The sample still proves extraction works.
- DB `url` field is `https://www.leverarms.com` but apex serves canonical (apex returns 200 + `<link rel=canonical>` declares apex). Minor data hygiene item.
