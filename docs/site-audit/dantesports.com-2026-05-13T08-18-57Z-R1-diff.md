# dantesports.com R1 candidate vs DB siteProfile (read-only diff)

Run: `dantesports.com-2026-05-13T08-18-57Z-R1`. DB snapshot age: 2026-04-11 (32 days). All values read-only; no DB write.

## Field-by-field divergence

| # | Field | DB (2026-04-11) | R1 candidate (2026-05-13) | Why divergent (one line) |
|---|-------|-----------------|---------------------------|--------------------------|
| 1 | `wafType` | `cloudflare-passive` | `cloudflare-active` | R1 8-batch saw XSS-payload 403 + bot-UA 403 (rule-selective); DB recorded same XSS-403 but tagged passive - SKILL Stage 2 says any 4xx on a payload = active. |
| 2 | `expectedProductCount` | `2086` | `2117` | DB used `/en/` x-wp-total (English mirror; one product untranslated). R1 used `/fr/` (default redirect target) which has 2117. |
| 3 | `productCountMethod` | `"wp-rest-api"` (bare string) | `{method:"wp-rest-header", endpoint:"/fr/wp-json/wc/store/v1/products", header:"x-wp-total"}` | DB value is a bare string NOT in the `product-count-probe.ts:149` switch - falls through to `default: return null` (count probe silently disabled). R1 uses canonical object shape. |
| 4 | `perPage` | `12` | `48` | DB recorded WC default (page-1 floor). R1 bracket-probed: ?per_page=48 returns 48; >48 silently drops to 12. SKILL Stage 5 mandates probing the max verifiable. |
| 5 | `paginationPattern.template` | `"page/{N}/"` | `"/page/{N}/"` | Leading slash difference. WC adapter consumes both, but the canonical URL form is `/page/{N}/`. |
| 6 | `paginationPattern` (extra fields) | `{type, template}` only | `+perPage, firstPageHasParam:false, startPage:1, zeroIndexed:false` | DB missing 4 of 6 fields the SKILL requires. |
| 7 | `catalogUrls` | 16 entries under `/en/product-category/` | 19 entries under `/fr/categorie-produit/` | (a) language side switched FR vs EN (canonical default-redirect is /fr/). (b) DB list is missing 3 subcat URLs holding 32 orphan products (`vetements`, `entretien-d-arme-a-feu-2`, `lance-pigeon`) - confirmed by 22-page Store API walk + cat-id cross-reference. |
| 8 | `crawlers.watermark.apiEndpoint` | `/en/wp-json/wp/v2/product` | `/fr/wp-json/wc/store/v1/products` | DB uses admin REST on /en/; R1 uses customer-visible Store API on /fr/. Both work; Store API excludes drafts. |
| 9 | `crawlers.watermark` (extra keys) | `+apiOrder, apiOrderBy, apiPerPage, apiDateFilterField, notes` | same set (verified) | R1 reproduces every DB key on the /fr/ endpoint. |
| 10 | `crawlers.bootstrap` | absent | present (`apiEndpoints` map) | SKILL recommends `crawlers.bootstrap.apiEndpoints`. |
| 11 | `crawlers.maintain` | absent | `{verifyMethod:"store-api", verifyEndpoint:"/fr/wp-json/wc/store/v1/products"}` | SKILL Stage 3 mandates this for WC; without it `worker.ts:tryStoreApiVerify` skips the fast batch verify path. |
| 12 | `searchUrl` | absent | `/fr/?s={keyword}&post_type=product` | SKILL conditional output for the user-search workflow. |
| 13 | `wafProbeMethod` / `wafProbeResult` / `wafProbeEvidence` | present (2026-04-11) | re-derived (2026-05-13) | Same probe method, fresh values. Re-derivation per SKILL anti-pattern "don't trust stored WAF tags". |
| 14 | `wafLastProbedAt` | `2026-04-11T15:19:26Z` | `2026-05-13T08:19:34Z` | New probe timestamp. |
| 15 | `extractionTested` / `extractionSample` | absent | `true` + 3 samples | SKILL Stage 4g spot-check (DB has no record of it). |
| 16 | `ageGate` | absent | `{detected:false, type:null, bypassCookie:null}` | Explicitly recorded; site has no age gate. DB omitted the field. |
| 17 | `topLevelCategories` | absent (DB has `categoryStats` instead) | `{source, totalsSumCheck, categories[]}` | SKILL recommends `topLevelCategories`; DB has same data in different shape (`categoryStats` keyed by English slug with `{count, pages}`). |
| 18 | `multilingual` | inside `siteProfile.multilingual` with crawlLanguage `en` | inside `auditNotes.multilingual` with default `fr` | DB chose to crawl English mirror; R1 reports both sides + notes which is default-redirect. |
| 19 | `notes` (top-level) | long DB note string with FR/EN explanation | absent | SKILL Rule B: freeform `notes` is operator audit-trail residue, not a runtime field. R1 moves equivalent info to `auditNotes.multilingual`. |
| 20 | `sortDefault` | `"date"` | omitted (captured in `auditNotes.sortVerification.verdict: "honored-default-is-newest"`) | DB has it as a custom runtime hint; SKILL doesn't define this field. |
| 21 | `apiPerPage` (top-level) | `100` | omitted (lives inside `crawlers.watermark.apiPerPage`) | DB duplicated at top-level; SKILL has only the nested form. |
| 22 | `sortVerified` | absent | `true` | DB missing the SKILL Stage 6 verification flag. |
| 23 | `auditNotes` | absent | rich block (runId, fieldConfidence, stageNotes, coverageVerification, watermarkApiProbe, paginationVerification, perPageCap, sortVerification) | SKILL Stage 9 optional but recommended provenance block. |

## Convergent fields (same in both)

`profileVersion=1`, `platform="woocommerce"`, `adapterType="woocommerce"`, `hasWaf=true`, `hasCaptcha=false`, `sortParam="?orderby=date"`, `paginationPattern.type="path"`, `crawlers.watermark.method="api-date-since-watermark"`.

## Divergent field count: **23**

## Three most surprising divergences

1. **`productCountMethod` is a bare string in DB.** Value `"wp-rest-api"` is not in the `product-count-probe.ts` switch (canonical names are `wp-rest-header`, `json-api-count`, etc.). The runtime `switch (cfg.method)` falls through to `default: return null` - the count probe has been silently disabled for this site since 2026-04-11. This is exactly the Mistake-pattern called out in SKILL Stage 8 ("Don't write a bare string for `productCountMethod`").

2. **3 orphan subcats missing from DB catalogUrls - 32 products unreachable via the 16 top-level URLs alone.** WC parent category pages do NOT include subcategory products (theme-dependent). `vetements` (17 orphans), `entretien-d-arme-a-feu-2` (1), `lance-pigeon` (1) need explicit entries. Proof: 22-page Store API walk -> 2117 unique IDs; intersect each product's `categories[].id` with the DB's 16 top-level IDs -> 32 misses. Real coverage gap.

3. **Language-side switch (FR vs EN).** DB chose `/en/` crawlLanguage; the canonical `/` redirects to `/fr/`. Both work, but the choice is silent - the operator should pick consciously. Cost: every catalogUrl, API endpoint, and product count differs by 1 product (EN has 2116 vs FR 2117 - one product is untranslated).

## SKILL.md harness gaps surfaced by this calibration

1. **Stage 4d "minimum URL count" doesn't address parent vs subcat coverage on WC.** The rule "use the smallest URL set covering 100%" assumes each candidate is independent. On WC, a parent category does NOT include subcat products, so the algorithm needs an explicit "for each product not under any chosen URL, add the most-specific subcat URL". The SKILL says "Walk-test: page 1 of parent vs page 1 of one child" but a page-1 sample under-covers - full-walk + cat-id cross-reference is the correct method (the only way I found the 32 orphans). SKILL should be updated to make the cat-id cross-reference the canonical Stage 4d test for WC sites with subcats.

2. **No guidance on WPML / multilingual sites.** SKILL Stage 1 picks canonical-origin from redirect/canonical-link but doesn't say "if the site is WPML with two language sides, which side do we crawl?" The DB chose EN; the canonical redirect chose FR. Without a rule, every R1 against a WPML site will diverge from DB on language. Recommended rule: crawl the language matching the default-redirect target (FR here) - that's what unauthenticated visitors see.

3. **Stage 2 ambiguity: rule-selective edge filter vs `cloudflare-passive`.** When the only "active" signal is an XSS-payload 403 and a bot-UA 403, but normal browser traffic is 200, current SKILL text says "Cloudflare-passive (cf-ray + all 200 in every probe) does NOT need it" - but our probe wasn't "all 200 in every probe". The threshold for `cloudflare-active` vs `cloudflare-passive` needs a clearer rule: does any rule-fired 403 in probe -> active, or only when the runtime crawler's actual path is blocked? DB and R1 disagreed because the SKILL is ambiguous here.
