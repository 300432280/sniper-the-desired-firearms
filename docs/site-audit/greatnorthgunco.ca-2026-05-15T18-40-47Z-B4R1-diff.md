# Diff — greatnorthgunco.ca candidate (B4R1) vs DB siteProfile

Candidate: `docs/site-audit/greatnorthgunco.ca-2026-05-15T18-40-47Z-B4R1.json`
DB siteProfile: `MonitoredSite.siteProfile` (lastVerified 2026-04-07).

## Field-by-field

| field | DB | Candidate | divergent? | one-line WHY |
|---|---|---|---|---|
| `platform` | `"woocommerce"` | `"woocommerce"` | match | — |
| `adapterType` | `"woocommerce"` | `"woocommerce"` | match | — |
| `hasWaf` (DB column) | `false` | `true` | **DIVERGENT** | Live probe today shows Imunify360 challenge gates `/shop/`, `/wp-json/*`, `/product*/*`; DB 2026-04-07 audit captured no challenge — either Imunify deployed since, or prior probe IP was unblocked (skill WAF-IP-dependence). |
| `siteProfile.hasWaf` | `false` | `true` | **DIVERGENT** | Same as above. |
| `siteProfile.wafType` | `"none"` | `"imunify360"` | **DIVERGENT** | Same as above; live challenge is from CloudLinux Imunify360 (openresty/1.29 with `f03s36su46c0` div + JS anti-bot). |
| `hasCaptcha` (DB column) | `false` | `false` | match | — |
| `siteProfile.hasCaptcha` | `false` | `false` | match | reCAPTCHA v3 present site-wide via CF7, but does not gate catalog — both correctly call it false. |
| `needsPlaywright` | `false` | `true` | **DIVERGENT** | Plain axios fetch of `/shop/` today returns 11KB Imunify challenge HTML; only stealth Playwright passes. DB was set when site wasn't challenging. |
| `expectedProductCount` | `4201` | `4292` | divergent (growth) | DB Apr 2026 snapshot = 4201; today's WP v2 admin REST = 4292 (matches sitemap dedup). Site grew by 91 products over ~5 weeks; not a methodology disagreement. |
| `productCountMethod` | `{method:"wp-rest-header", endpoint:"/wp-json/wp/v2/product", header:"x-wp-total"}` | (same) | match | — |
| `catalogUrls` | 14 URLs: `/shop/` + 13 `/product-category/*` entries (incl. typo `/accessoriesparts/`) | `["/shop/"]` | **DIVERGENT** | DB lists `/shop/` plus per-category for redundancy AND a typo entry `/product-category/accessoriesparts/` (real slug is `accessories-parts` with hyphen — taxonomy API confirms). Candidate collapses to single `/shop/` since /shop/ is proven 100%-coverage of customer-visible 516 (sum-of-cat-counts = 516 exact). Per skill Rule C, minimum URL count wins when union is identical. |
| `sortParam` | `"?orderby=date"` | `"?orderby=date"` | match | — |
| `sortVerified` | (not stored) | `true` | new | DB has no explicit `sortVerified` field; candidate adds it per current skill schema. |
| `perPage` | `24` | `24` | match | — |
| `paginationPattern.type` | `"path"` | `"path"` | match | — |
| `paginationPattern.template` | `"/page/{N}"` | `"/page/{N}"` | match | — |
| `paginationPattern.perPage` | `24` | `24` | match | — |
| `paginationPattern.firstPageHasParam` | (not stored) | `false` | new | DB schema didn't include this field; candidate adds per current spec. |
| `paginationPattern.startPage` | (not stored) | `1` | new | Same — DB schema gap. |
| `paginationPattern.zeroIndexed` | (not stored) | `false` | new | Same — DB schema gap. |
| `crawlers.watermark.method` | `"api-date-since-watermark"` | `"api-date-since-watermark"` | match | — |
| `crawlers.bootstrap.apiEndpoints.productDiscovery` | `/wp-json/wp/v2/product` | (same) | match | — |
| `crawlers.bootstrap.apiEndpoints.priceEnrichment` | `/wp-json/wc/store/v1/products` | (same) | match | — |
| `crawlers.maintain.verifyMethod` | `"detail-page"` | `"detail-page"` | match | — |
| `crawlers.maintain.verifyEndpoint` | (not stored) | `null` | new | Schema completion only. |
| `searchUrl` | `"/?s={keyword}&post_type=product"` | (same) | match | — |
| `wafWorkaround` | `null` | `null` | match | — |
| `extractionTested` | (not stored) | `true` | new | DB schema gap; current skill mandates it. |
| `profileVersion` | (not stored) | `1` | new | DB schema gap. |
| `lastVerified` | `"2026-04-07"` | `"2026-05-15"` | divergent (re-audit date) | — |
| `wafLastProbedAt` | (not stored) | `"2026-05-15T18:26:23Z"` | new | DB schema gap. |
| `wafProbeMethod` / `wafProbeResult` / `wafProbeEvidence` | (not stored) | populated | new | Current skill mandates evidence block. |
| `ageGate` | (not stored) | `{detected:false,...}` | new | Schema completion. |
| `topLevelCategories` | (not stored) | populated with 17-entry table | new | Schema completion. |
| `auditNotes.knownGaps` | (not stored) | populated (2 entries) | new | Operator surface for the 2 known runtime gaps. |

## Divergent count: 6 substantive divergences

1. `hasWaf` (DB column) — false → true
2. `siteProfile.hasWaf` — false → true
3. `siteProfile.wafType` — "none" → "imunify360"
4. `needsPlaywright` — false → true
5. `expectedProductCount` — 4201 → 4292 (growth, not methodology change)
6. `catalogUrls` — 14 entries → 1 entry (minimum-coverage collapse + typo fix)

(All other divergences are either matches or "new" fields where DB has nothing to compare.)

## 2-3 most surprising

1. **DB says hasWaf=false but Imunify360 IS actively challenging every catalog endpoint today.** Either it was deployed since April 2026 OR the prior probe IP was on Imunify's allowlist. The skill's WAF-IP-dependence rule applies; operator must re-confirm from production crawler IP.
2. **DB has a typo'd catalog URL `/product-category/accessoriesparts/` (no hyphen) alongside the correct `/product-category/accessories-parts/` (with hyphen).** Taxonomy API (`/wp-json/wp/v2/product_cat`) confirms the slug is `accessories-parts` with hyphen; the typo URL would 404. Collapsing to `/shop/` sidesteps the issue.
3. **`hasCaptcha=false` is correct in both, despite the rendered HTML containing reCAPTCHA v3 site-wide.** Both candidate and DB call it correctly: the script tag is loaded by Contact Form 7 across every page, but the catalog crawler never hits a form → does not gate the crawl path. Operationally `false`, even though informationally `captchaType="recaptcha-v3"`.

## 1-3 SKILL.md harness gaps observed

1. **Imunify360 is not in the `wafType` enum.** The skill's table covers `cloudflare-passive|cloudflare-active|sucuri|sgcaptcha|incapsula|akamai|malcare|null` but not `imunify360`. The validator allows any string when `hasWaf=true`, but the skill's enum + detection table miss a common CloudLinux-shared-host WAF. Recommend adding an Imunify360 row: marker = `openresty/1.29.*` server header + `<title>One moment, please...</title>` + form action matching `/z[0-9a-f]{40}` + JS function checking `webdriver`/`PluginArray.prototype`. Bypass = stealth Playwright init scripts (NOT a UA swap — UA doesn't matter; the prototype shims do).
2. **`needsPlaywright=true` is not enough on its own when the runtime `product-count-probe.ts` `wp-rest-header` arm uses plain axios.** The skill picks the productCountMethod based on what works at audit-time (WP REST), but at runtime the `wp-rest-header` arm has no `hasWaf → Playwright` fallback (only the `catalog-walk-only` path does, at line 363+). SKILL.md Stage 8 should add an explicit anti-pattern: "If `hasWaf=true` AND chosen `productCountMethod.method` is one of `wp-rest-header`, `json-api-count`, `json-api-length`, `html-pagination`, `sitemap`, `sitemap-index`, `generic-product-sitemap`, `ecwid-storefront-search`, `klevu-api-count`: WARN that runtime requires a code patch to propagate `hasWaf` into the probe's HTTP call. Only `shopify-products-walk` (which uses pure fetch+JSON-walk) and `catalog-walk-only`/walk paths currently honor `hasWaf → Playwright`."
3. **Stage 2's "INTERPRETATION GUIDE" matches only CDN-fronted WAFs and origin-rule WAFs, missing interstitial JS challenges that pass BATCH 1 but fail at BATCH 4-equivalent paths.** The 8-batch probe scans `/`, `/robots.txt`, `/sitemap.xml` in BATCH 1 — all NOT challenged on this site (homepage + sitemaps pass-through, only catalog paths challenge). The probe never visited `/shop/` or `/wp-json/`, so the verdict-from-BATCH-1 would have been "no WAF" — wrong. SKILL.md should add a BATCH 1-bis: "Always also fetch a known product-listing path (e.g. the first nav-discovered category) BEFORE concluding `hasWaf=false`. Some WAFs gate catalog endpoints ONLY, leaving home/sitemap clean."
