# Wave 2 — Round 1 (blind) Ledger — 2026-06-03

7 parked "giant/0%" sites. R1 = testing-api-tester blind, GENTLE WAF detection only (L3 lesson:
heavy 8-batch banned us on pavillon). All read-only. Candidates in docs/site-audit/<domain>-*.json.

## HEADLINE: every Wave-2 site is DISABLED/PARKED, not hard-blocked
None is a WAF wall. The 0%/low-coverage symptom is operational: auto-disabled after failures, or
manually disabled, or bootstrap never ran. Most are re-enable + count-fix + minor catalogUrls.

## PER-SITE R1 FINDINGS (-> carry to R2)

| Site | Platform | True count (R1) | DB count | Blocker | Key fixes for R2/Phase B |
|---|---|---|---|---|---|
| store.theshootingcentre.com | bigcommerce-stencil | 17305 | 16985 (+1.9% drift) | `bc-xmlsitemap` bare-string count method -> silent null (disables gate) | fix count method (sitemap-index/sitemap); hasWaf true->false (invalid combo); perPage 50->100; +/clearance/ catalogUrl |
| thegundealer.ca | woocommerce | 11279 | 11230 | manual disable after domain change ("search 404"); 49 fails. WP REST 200/reachable now | re-enable + reset fails; perPage 24->100; count basis = WP REST full corpus |
| store.prophetriver.com | bigcommerce-stencil (no GraphQL) | ~5414 | 13974 (**2.6x INFLATED**) | auto-disabled 40 fails; **root failure cause INCONCLUSIVE** (extraction+pagination work today) | R2 MUST trace the crawl-job failure (crawlEvents/dry-run) before re-enable; correct count DOWN to ~5414 (browsable union per L1) |
| rdsc.ca | magento2 | 9521 | 9343 (+1.9%) | bootstrap never ran (disabled, bootstrapStartedAt=null) | DB profile correct; enable + crawl. count method: sitemap-index over BOTH child sitemaps (SM1+SM2) or keep html-pagination |
| www.gagnonsports.com | lightspeed-ecom | 2707 (firearm subset) | 2706 | stalled bootstrap (disabled) | **ADD missing /firearms/* tree (~239 products, DB note "no firearms cat" now STALE)**; perPage 100->24; archery scope = operator choice |
| sail.ca | magento2 + Searchspring SPA | **3223 (firearm/Hunting)** | 18944 (**WHOLE-STORE, wrong scope**) | unscoped whole-store Playwright walk (~780pg) stalls at 33% | RE-SCOPE: catalogUrls -> ["/en/hunting"] (one URL = all 3223; DB's 7 leaves cover only ~55%); count->3223; perPage->24; needsPlaywright |
| www.gobles.ca | lightspeed-ecom | 3876 | 3770 (+2.8%) | parked, never enabled. needsPlaywright=false (static HTML works) | enable; fix 2 dead-404 knives catalogUrls (numeric-ID->brand slug); bake ?limit=100 + firstPageHasParam=true |

## CROSS-CUTTING (extends Wave-1 lessons)
- **L1 count-surface carries to ALL Wave-2 BC/Lightspeed sites**: confirm which surface the runtime crawls before fixing count. BC-no-GraphQL (prophetriver, gobles, gagnon, theshootingcentre?) -> HTML/sitemap browsable; magento2 (rdsc, sail) -> HTML walk; woocommerce (thegundealer) -> WP REST full corpus.
- **bc-xmlsitemap silent-null** recurs (theshootingcentre — same as oleys in Wave 1).
- **hasWaf=true + cloudflare-passive invalid combo** recurs (theshootingcentre; gobles per prior B6).
- **catalogUrls gaps** recur: gagnon missing /firearms/ tree; sail hunting-leaves cover 55%; gobles 2 dead URLs.
- **NEW — scope enforcement**: sail crawls whole-store (18944) on a firearms monitor; needs firearm-relevant scoping. Possible fleet-wide concern (general retailers).
- **NEW — harness gap (sail)**: product-count-probe.ts:265 `json-api-count` lacks the `startsWith('http')` absolute-URL guard that sitemap-index:312 has -> can't count foreign-origin search APIs (Searchspring/Algolia). Runtime-code fix candidate.
- **prophetriver count 2.6x inflated** — DB counts can be wrong HIGH, not just stale-low. Always re-derive.

## OPEN FOR R2 (live investigation)
- Per-site count-SURFACE resolution (L1) + evidence-backed true count.
- prophetriver: trace the 40-failure root cause (the only unexplained blocker).
- catalogUrls coverage proofs: gagnon firearms tree, sail hunting (1 URL vs leaves), gobles type-vs-brand leaves, theshootingcentre 8-cat + /clearance.
- All hasWaf=false verdicts are gentle/audit-IP only — production-IP reconfirm.
