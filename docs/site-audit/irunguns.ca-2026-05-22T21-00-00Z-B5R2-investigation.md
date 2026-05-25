# B5R2 Adversarial Investigation — irunguns.ca

**Round:** R2 (LIVE INVESTIGATION, different method per R1 divergence)
**Date:** 2026-05-22T21:00:00Z
**R1 candidate:** `docs/site-audit/irunguns.ca-2026-05-22T20-00-00Z-B5R1.json`
**DB snapshot:** `_audit_tmp/batch5-2026-05-22/irunguns.ca-DB-snapshot.json`
**Runtime cross-ref:** `backend/src/services/product-count-probe.ts:110-122` (VALID_METHOD_NAMES allowlist)

## Method differences vs R1

R1 audit decided fields by reading the homepage and applying heuristics. R2 LIVE-WALKS each divergent field with a fresh GET, then cross-references runtime code where the field name itself is in dispute. Specifically:

| Divergence | R1 method | R2 method |
|---|---|---|
| `catalogUrls` (1 bare vs 11 per-dept) | Read homepage nav + single-walk bare URL | Walk bare URL AND all 11 per-dept URLs, compute set-diff of slugs |
| `productCountMethod` (`html-pagination` vs `sum-showing-result-markers`) | Persona Mistake 18 echo | Grep `VALID_METHOD_NAMES` runtime allowlist + simulate `parseHtmlPaginationCount` against live `.showing_result` text |
| `hasWaf` / `wafType` (true/sucuri vs true/sucuri-passive vs flipped-false) | Heavy-8-batch probe, R1 kept hasWaf=true | Add sustained no-delay 10x burst against crawl path |
| `expectedProductCount` (R1 104 vs DB-stale 84) | Read "Showing N result" | Re-read + per-dept walk to cross-check |
| `searchUrl` (R1 absent vs DB `/product.php?product_name={kw}`) | Not probed | Live test 7 search-param variants vs no-match keyword |

## Live evidence (one block per divergence)

### 1. catalogUrls — R1 WINS (Rule C: smallest URL set)

```
bare /product.php           -> 104 product slugs
union of 11 dept URLs       ->  99 product slugs
in bare but NOT in any dept ->   5 orphans
in some dept but NOT bare   ->   0
```

The 5 dept-less orphans:
- `nextlevel-training-sirt-training-magazine-weighted-plastic-black-finish`
- `atf-permit-application-pre-filing-fee`
- `colt-9mm-bcg-new-3738`
- `colt-hydr-buffer-w-buffer-spring`
- `xpedition-crossbow-kit-viking-x-380-rt-edge-380fps`

DB's 11-URL per-dept layout would silently miss these 5 products forever. R1's single bare URL covers 104/104 with 1 URL — strictly larger coverage AND smaller URL set. Skill Rule C says smallest URL set wins on tied (or larger) coverage. **Verdict: R1 wins; DB siteProfile needs update.**

Department per-dept counts changed since DB (2026-04-07): Rifles 11->26, Shotgun 12->13, Parts_AND_Gear 24->23, Magazines 22->23. Inventory drift, not a structural change.

### 2. productCountMethod — R1 WINS (canonical name)

`backend/src/services/product-count-probe.ts:110-122` defines exactly 11 canonical method names:
```
wp-rest-header, json-api-count, json-api-length, html-pagination,
sitemap, sitemap-index, generic-product-sitemap, ecwid-storefront-search,
shopify-products-walk, klevu-api-count, stream-page-count
```

`sum-showing-result-markers` (DB) is NOT in this list. At runtime `validateMethod()` (line 129) throws on unknown names; the outer try/catch swallows the throw and returns `null` (line 484). **DB method is silently broken.**

R1's `html-pagination` IS canonical. Live simulation of the runtime probe path:
```
selector=.showing_result   ->  ".last()" element text = "Showing 104 result"
default regex (\d+)         ->  N = 104
N * perPage (perPage=1)     ->  104
```
Matches the live "Showing 104 result" string. **R1 shape works exactly as the runtime expects.**

### 3. hasWaf — R2 FLIPS to false (Rule B10)

Sustained no-delay burst against the actual crawl path:
```
rapid-burst statuses (10 GETs, no delay): 200,200,200,200,200,200,200,200,200,200
```

Combined with R1's heavy-8-batch evidence: Sucuri triggers 403 only on SQLi/XSS/honeypot — rule-selective, not crawl-path-blocking. Per skill Rule B10, `hasWaf` flips to **false** because the WAF does not gate crawler traffic. `wafType` stays `sucuri-passive` (informational). DB had wafType right but hasWaf inconsistent; R1 kept hasWaf=true without applying B10.

### 4. searchUrl — BOTH WRONG (DB had a fake searchUrl)

Live test of 7 search-param variants:
```
?product_name=henry          -> 200, "Showing 104 result", 104 products (HENRY first)
?product_name=glock          -> 200, "Showing 104 result", 104 products (HENRY first)
?product_name=zzz_no_match   -> 200, "Showing 104 result", 104 products (HENRY first)
?search=henry                -> 200, "Showing 104 result", 104 products
?q=henry                     -> 200, "Showing 104 result", 104 products
?keyword=henry               -> 200, "Showing 104 result", 104 products
/search.php?product_name=henry -> 404
```

The `product_name` GET parameter is **inert** server-side. The same 104 products come back regardless of value. Search on irunguns.ca runs client-side via JS over the already-rendered DOM. DB's `searchUrl: "/product.php?product_name={keyword}"` would return false positives for every query (every keyword "matches" all 104 products). **R1 was right to omit; R2 explicitly sets `searchUrl: null`.**

### 5. Other DB-vs-R1 calls

- `platform`: DB `custom-php` wins (no `-irunguns` qualifier; matches DB convention)
- `wafType`: DB `sucuri-passive` wins (more precise than R1 `sucuri`)
- `sortParam`: DB `null` wins (no URL form at all; R1's `""` confuses absent vs empty)
- `paginationPattern`: DB top-level `null` wins (R1's filled object with `type:null` is shape drift)
- `userAgentOverride`: DB `null` wins (R1's iPhone UA is defensive over-application; default UA returns 200)
- `perPage`: DB `100` wins (irrelevant when paginationPattern=null but matches convention)

## Final R2 verdict per field

| Field | Wins | R2 emits |
|---|---|---|
| `platform` | DB | `custom-php` |
| `hasWaf` | R2 FLIPS | `false` |
| `wafType` | DB | `sucuri-passive` |
| `expectedProductCount` | R1 | `104` (live) |
| `productCountMethod` | R1 | `html-pagination` (canonical) |
| `catalogUrls` | R1 | `["/product.php"]` |
| `searchUrl` | Neither | `null` |
| `sortParam` | DB | `null` |
| `paginationPattern` | DB | `null` |
| `userAgentOverride` | DB | `null` |
| `perPage` | DB | `100` |

## Score for R3

R1 candidate: **5 substantive wins** (catalogUrls, expectedProductCount, productCountMethod canonical, hasWaf-pre-B10-flip-debatable, omitting fake DB searchUrl), **4 substantive losses** (sucuri vs sucuri-passive, sortParam shape, paginationPattern shape, userAgentOverride over-application).

DB siteProfile: **1 broken field** (sum-showing-result-markers silently disables count probe), **1 fake field** (searchUrl product_name doesn't filter), **1 stale count** (84 vs live 104), **catalogUrls miss 5 products** (dept-less orphans), but **correct on shape/convention** for sortParam/paginationPattern/userAgentOverride/wafType/platform/perPage.

R3 should focus on: (a) verifying the runtime branch that consumes `searchUrl` to confirm DB's broken value is currently inert (no harm done) or actively poisoning search results; (b) checking whether any persona/skill doc still references the non-canonical `sum-showing-result-markers` name and needs updating; (c) confirming whether the 5 dept-less orphans appear in the production DB for irunguns.ca today.
