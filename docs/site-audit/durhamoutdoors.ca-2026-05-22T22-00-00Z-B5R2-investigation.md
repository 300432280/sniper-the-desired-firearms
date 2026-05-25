# B5R2 Investigation - durhamoutdoors.ca (2026-05-22T22:00:00Z)

Round 2 of 4. Live-probe each R1 divergence with a method DIFFERENT from R1's (B9 sustained walk for WAF call, full keyword-probe matrix for searchUrl, re-derive twice for count). 18-minute wall budget.

## Method per divergence

### 1. wafType: cloudflare-active vs cloudflare-passive

**Method:** B9 sustained 30-page walk with 4 rotating production UAs from `backend/src/services/scraper/http-client.ts:9-14` (Chrome 120 / Safari 17 / Firefox 121 / Edge 120), 800ms delay, across multiple categories.

**Result:** 30/30 returned HTTP 200, ~60KB bodies each (real product listings; verified `_p_NNN.html` links present in each body). No challenge interstitial, no `_cf_chl_opt` token in any body, no escalation to 403 at any depth. Wall: 26.7s.

```
[01] Chrome  200  59846B /Rifles_c_17.html
[02] Safari  200  59825B /Rifles_c_17-2.html
[03] Firefox 200  59362B /Rifles_c_17-3.html
... 30 lines, all 200 ...
[30] Safari  200  59652B /NON-RESTRICTED_c_16-2.html
Status distribution: {"200":30}
```

**Verdict: DB wins.** The R1 4-class signal (bot-UA blocked, SQLi blocked, XSS blocked, honeypot paths blocked) is real but operationally irrelevant — those rules NEVER fire on the catalog crawl path. Per SKILL.md rule on "operationally meaningful classification", Cloudflare is `passive` for our use case + `rule-selective` for honeypot/attack surfaces. DB's call is correct.

Coupled flips on R1's iPhone UA override → DB wins (no override needed) and `needsPlaywright: false` → R1 wins anyway (plain HTTP returns products).

### 2. searchUrl: /search.asp?keyword= vs /search?q= vs OMIT

**Method:** Live-probe both forms with 6 keywords (glock, rifle, 22lr, ammo, chiappa, test, mossberg) AND 9 different param-name variants AND with `__cf_bm` cookie + Referer header from a prior homepage visit.

**Results:**

| URL | Status | Body | Products |
|---|---|---|---|
| `/search.asp?keyword=glock` (R1) | **403** | 4550B Cloudflare "Attention Required!" | 0 |
| `/search.asp?keyword=rifle` | **403** | 4550B (identical) | 0 |
| `/search.asp?q=glock` | 403 | 4550B (identical) | 0 |
| `/search.asp?search=glock` | 403 | 4550B | 0 |
| `/search.asp?searchquery=glock` | 403 | 4550B | 0 |
| `/search.asp?searchfor=glock` | 403 | 4550B | 0 |
| `/search-results.asp?keyword=glock` | 404 | 1201B | 0 |
| `/search?q=glock` (DB) | **404** | 1201B | 0 |
| `/Search?keyword=glock` | 404 | 1201B | 0 |
| `/search.asp?keyword=rifle` WITH `__cf_bm` cookie + Referer | **403** | 4550B | 0 |

Homepage form action confirmed verbatim: `<form method="get" name="searchForm" action="search.asp"><input type="text" name="keyword" ...></form>`. So the FORM shape is /search.asp?keyword=, but Cloudflare WAF has a rule on `/search.asp` that blocks plain axios fingerprints (even with the bot-mitigation cookie).

**Verdict: BOTH WRONG — omit.** Per Skill rule B4: "Omit the field entirely — don't ship an unverified URL." R1 read the form action and inferred the URL but skipped the mandatory live-probe (skill rule violation). DB's `/search?q=` is a generic default that doesn't match the platform.

This is a real R3-promotable finding: every DB `searchUrl` should be live-probed; we now have an example where the form-action inference also fails live (rule-selective WAF).

### 3. expectedProductCount: 389 vs 388

**Method:** Walk all 9 catalogUrls page-by-page, extract every `_p_NNN.html` link, dedupe to unique product IDs, union across categories.

**Result:**
```
/Accessories_c_11.html             63 unique
/Shotgun_c_14.html                103 unique
/NON-RESTRICTED_c_16.html         281 unique
/Rifles_c_17.html                 218 unique
/Pistols_c_18.html                  1 unique
/Optics_c_19.html                   2 unique
/Used-Consignment_c_20.html         1 unique
/RESTRICTED_c_21.html               0 unique (200 status, 0 products — keep per Rule C)
/Surplus-and-collection_c_33.html   1 unique
--- UNION ---
Walked union: 389 unique product IDs
Per-cat sum (with overlap): 670
```

**Verdict: R1 wins (389).** DB 388 is from 2026-04-06 (47 days stale); 1 SKU added in interim is normal drift. R1's count is canonically correct as of audit time.

### 4. paginationPattern.template: '{slug}-{N}.html' vs '-{N}.html'

**Method:** Read runtime code at `backend/src/services/scraper/adapters/generic-retail.ts:85-129`.

**Result:** Line 97 docstring: `For type='suffix-replace': replacement template with {N} (default '-{N}.html')`. Line 127-129 implementation: `const template = pattern.template || '-{N}.html'; ... <match-replace logic>`. The template is the REPLACEMENT-ONLY form ("-{N}.html"), not the full URL form ("{slug}-{N}.html").

**Verdict: DB wins.** R1's `{slug}-{N}.html` does not match the runtime contract. R1 hand-formatted a "more readable" form that would fail at runtime.

### 5. platform: shift4shop-3dcart vs custom

**Method:** Cross-reference R1's fingerprints (vcart=26.19.0, _3d_cart JS var, 3dcartGoogleAnalytics, .asp URLs, assets/templates/common-html5/) against SKILL.md platform table (lines 293-314).

**Result:** Fingerprints are unambiguous Shift4Shop/3dcart. Table does NOT list shift4shop or 3dcart explicitly — they fall under "anything else → generic-retail". The tag name `shift4shop-3dcart` follows the canonical hyphen-separator rule (SKILL.md:408).

**Verdict: R1 wins (with caveat that the platform tag isn't yet in the skill's reference table — promote in next skill update).**

### 6. wafWorkaround: null vs {method:"none-required"}

**Verdict: both valid.** Semantic disagreement only. R1's null follows the skill rule "emit null to signal clear stale workaround"; DB's `method:"none-required"` is a defensive audit-trail marker.

### 7. catalogUrls count: 9 vs 8

**Verdict: R1 wins.** Live-walk of `/RESTRICTED_c_21.html` returned 200 (not 404) with 0 products. Per Skill Rule C ("empty != dead — preserve until 404"), keep all 9.

### 8. productCountMethod

**Verdict: both valid.** Both `html-pagination` (R1) and `stream-page-count` (DB) are in `VALID_METHOD_NAMES` at `product-count-probe.ts:110-122`. R1's choice is the re-derivable probe form preferred during pre-bootstrap; DB's is the post-bootstrap state once streams are populated.

## Verdict summary

- **R1 wins (4):** needsPlaywright=false, expectedProductCount=389, platform=shift4shop-3dcart, catalogUrls count=9.
- **DB wins (3):** wafType=cloudflare-passive, userAgentOverride omitted, paginationPattern.template='-{N}.html'.
- **Both wrong (1):** searchUrl — OMIT per skill B4 rule.
- **Both valid (2):** productCountMethod (operator-policy choice), wafWorkaround (semantic).

## Blockers

None. Coverage 389/389 verified. Sort verified at R1. Pagination zero-overlap verified at R1.

## Notes for R3/R4

- **R3 attack surface:** Audit ALL Batch 5 sites' DB `searchUrl` values — durhamoutdoors's `/search?q=` is a copy-paste default that 404s. Likely other sites have the same bug.
- **R3 attack surface:** The form-action heuristic (B5R1 derived `/search.asp?keyword=` from `<form action="search.asp">`) is NOT sufficient on its own — the path can be WAF-blocked. Live-probe is mandatory.
- **Skill suggestion:** Add `shift4shop-3dcart` to SKILL.md platform table (line 293-314) with signals: `vcart=` JS var, `_3d_cart` JS var, `3dcartGoogleAnalytics` template comment, `.asp` URL pattern, `assets/templates/common-html5/`.
