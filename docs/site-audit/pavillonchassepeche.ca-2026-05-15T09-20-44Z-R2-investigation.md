# R2 Investigation — pavillonchassepeche.ca

Site: https://pavillonchassepeche.ca
R1 candidate: `docs/site-audit/pavillonchassepeche.ca-2026-05-15T08-53-25Z-R1.json`
R1 diff:      `docs/site-audit/pavillonchassepeche.ca-2026-05-15T08-53-25Z-R1-diff.md`
R2 timestamp: 2026-05-15T09:20:44Z
Method: live curl + DB siteProfile read-only diff + worker.ts:381-400 line-by-line

## REQUIRED VERDICT #1 — `verifyMethod` literal-equality (worker.ts:381-400)

**Prior batch's R2 claim**: "`verifyMethod: 'json-ld'` is UNREACHABLE DEAD CODE because worker.ts:381-400 only routes on `'store-api'`."

**My reading of the actual code**:

`backend/src/services/worker.ts:381-400` is the **fast-path** check inside `tryStoreApiVerify()`:
```
381  async function tryStoreApiVerify(...): Promise<WooVerifyResult | null> {
...
396    const maintainConfig = profile?.crawlers?.maintain;
397    if (!maintainConfig || maintainConfig.verifyMethod !== 'store-api') return null;
...
400    if (!verifyEndpoint) return null;
```

Line 397 uses literal-equality `!== 'store-api'`. Any other value (`'json-ld'`, `'detail-page'`, null, undefined) returns `null` from `tryStoreApiVerify`, which means the **fast-path** is skipped.

But there is an **ELSE branch** at lines 759-769 that the prior R2 missed:
```
703    const storeApiFastPath = await tryStoreApiVerify(products, domain, siteId, hasWaf);
704    if (storeApiFastPath) {
       // ... fast-path execution ...
759    } else {
760      // ─── Verify method must be declared in site profile ──────────────
761      const { _getSiteCacheEntry: getEntry } = await import('./scraper/adapter-registry');
762      const entry = getEntry(domain.replace(/^www\./, ''));
763      const verifyMethod = entry?.siteProfile?.crawlers?.maintain?.verifyMethod;
764      if (!verifyMethod) {
765        console.error(`[VerifyWorker] ${domain}: MISSING verifyMethod ... Skipping verification.`);
766        return;
767      }
768      // verifyMethod === 'detail-page' — visit each product URL via Playwright
769      const pwResult = await verifyProductsViaPlaywright(products, domain, siteId, tier, hasWaf, ...);
```

Line 764 gates ONLY on `!verifyMethod` (truthy check, not literal-equality). Line 769 calls `verifyProductsViaPlaywright` UNCONDITIONALLY for any non-falsy `verifyMethod`. The comment on line 768 is misleading — it says `'detail-page'` but the code accepts ANY truthy value.

**VERDICT**: `'json-ld'` is **NOT dead code**. It is a valid routed value that means: "skip Store API fast-path, run Playwright detail-page verification." The prior R2 was wrong.

The 'json-ld' vs 'detail-page' distinction (if any) lives in `product-verifier.ts` (called by `verifyProductsViaPlaywright`). The skill should treat verifyMethod as a 3-way switch but recognise that today's worker code only distinguishes `'store-api'` vs everything-else.

## REQUIRED VERDICT #2 — WPML canonical language

```
curl HEAD https://pavillonchassepeche.ca/  -> 200, no redirect
curl HEAD https://pavillonchassepeche.ca/  -H "Accept-Language: en-US" -> 200, no redirect
curl HEAD https://pavillonchassepeche.ca/  -H "Accept-Language: fr-CA" -> 200, no redirect
curl HEAD https://pavillonchassepeche.ca/en/ -> 200
```

Apex HTML:
```
<html lang="fr-FR">
<link rel="canonical" href="https://pavillonchassepeche.ca/" />
<link rel="alternate" hreflang="fr" href="https://pavillonchassepeche.ca/" />
<link rel="alternate" hreflang="en" href="https://pavillonchassepeche.ca/en/" />
<link rel="alternate" hreflang="x-default" href="https://pavillonchassepeche.ca/" />
<meta name="generator" content="WPML ver:4.8.6 stt:1,4;" />
```

EN tree HTML:
```
<html lang="en-US">
<link rel="canonical" href="https://pavillonchassepeche.ca/en/" />
```

**VERDICT**: WPML exposes TWO co-equal canonical trees. The site-default (`x-default` hreflang) is **FR**. The DB-stored operator runtime choice is **EN**. Neither is "wrong" — they answer different questions:
- "What does a fresh-browser visit to the apex see?" → FR (site default).
- "Which tree did the operator pick for the crawler?" → EN (DB choice).

R1's FR was the canonical-by-redirect answer. DB's EN is the operator's runtime decision. Both should coexist — skill should emit `multilingual: "wpml"` and record both URL trees.

## REQUIRED VERDICT #3 — Rule C "firearm-only" vs `feedback_full_coverage.md` "100% coverage"

**Per-category live test** (sampled product slugs in excluded categories):
- `/categorie-produit/peche/` (243 products): rods, reels, lures, baits, ice fishing. **ZERO firearm content.**
- `/categorie-produit/vetements/` (184 products): boots, mittens, jackets, pants. **ZERO firearm content.**
- `/categorie-produit/plein-air/` (129 products): propane heaters, first-aid kits, compasses, knives. **ZERO firearm content.**

So R1's Rule C exclusion is technically correct *if* the scope is "firearm-relevant only". But:

**DB siteProfile.catalogUrls** (operator authority):
```
/en/product-category/hunting-en-6/
/en/product-category/liquidation-en/
/en/product-category/fishing/
/en/product-category/clothing/
/en/product-category/outdoors-en-4/
/en/product-category/saltworks/
```

Operator explicitly included `fishing/clothing/outdoors`. This matches `~/.claude/projects/d--Projects-FIREARM-ALERT/memory/feedback_full_coverage.md`: "catalogUrls must cover 100% of products, NEVER drop categories for being 'too small'."

**VERDICT**: On retailer sites (`siteCategory: "retailer"`), `feedback_full_coverage.md` 100% coverage rule **OVERRIDES** Rule C "firearm-relevance scope filter" in the SKILL.md. The reason: scope filtering happens at runtime (keyword match against user alerts), not at crawl-target selection. If a category is excluded from `catalogUrls`, products in that category never enter the index, and a user who searches for "boot knife" or "fishing rod for hunting expedition" gets zero matches.

R1's Rule C exclusion of 556 products (peche+vetements+plein-air) is a **scoping mistake** on retailer sites. Skill must drop Rule C when siteCategory is retailer.

## Other live findings

### perPage HTML vs API
- WC Store API `/wp-json/wc/store/v1/products?per_page=100` -> 200, 13 pages (`X-WP-TotalPages: 13`, `X-WP-Total: 1243`). **API perPage = 100 honored.**
- WC Store API `/wp-json/wc/store/v1/products?per_page=72` -> 200, 18 pages. **Honored.**
- HTML `/magasiner/?per_page=72` -> 36 cards (locked).
- HTML `/magasiner/?posts_per_page=72` -> 36 cards (locked).
- HTML `/en/shop/?per_page=72` -> 36 cards (locked).

Conclusion: **Elementor archive widget locks HTML at 36 perPage** regardless of query param. Store API honors any perPage up to 100. The DB top-level `perPage: 100` is the API perPage; the `paginationPattern.perPage` should be 36 for the HTML fallback. R1's `paginationPattern.perPage: 36` is the right value for that field; DB's top-level `perPage: 100` is the right value for the API-first bootstrap path. **Both are correct for different paths**; the schema confusion is that the skill template doesn't separate the two clearly.

### expectedProductCount live values vs DB
| Endpoint | Value (today) | DB stored |
|---|---|---|
| WC Store API `/products` | 1243 | 1291 |
| WC Store API `/products?lang=en` | 1249 | — |
| WP REST `/wp/v2/product` | 1253 | 1318 |
| WP REST `/wp/v2/product?lang=en` | 1260 | 1318 |

DB's 1318 matches **no live endpoint today**. DB is stale (lastVerified 2026-04-12; today is 2026-05-15). R1's 1243 is correct as of today. DB's `productCountMethod` extras (wpRestTotal=1318, enScopeTotal=1318, storeApiTotal=1291, rootScopeTotal=1311) are residual audit-trail; they don't agree with each other either.

### Top-level FR taxonomy (per WP REST product_cat parent=0)
| slug | id | count |
|---|---|---|
| liquidation | 1063 | 483 |
| chasse | 21 | 412 |
| peche | 144 | 243 |
| vetements | 197 | 184 |
| plein-air | 110 | 129 |
| salines | 795 | 48 |
| tirage | 1107 | 1 |

Sum = 1500 (includes drafts/hidden). Customer-visible Store API global = 1243. Difference = 257 (drafts + cross-tag overlap).

## Confidence summary

| Field | R2 verdict | Confidence |
|---|---|---|
| url (EN runtime tree) | Operator choice; DB EN is valid | high |
| catalogUrls (6 EN slugs full coverage) | DB correct; Rule C overridden by full-coverage | high |
| expectedProductCount (1243 today) | R1 correct as of 2026-05-15; DB stale | high |
| productCountMethod.endpoint (WP REST) | Operator choice; both valid | medium |
| perPage top-level (100) | DB correct for API path | high |
| paginationPattern.perPage (36) | R1 correct for HTML fallback | high |
| crawlers.maintain.verifyMethod (json-ld) | DB correct; NOT dead code | high |
| crawlers.bootstrap.apiEndpoints (2-step) | DB correct; encodes real pipeline | high |
| multilingual: wpml | DB correct | high |

## Files
- `docs/site-audit/pavillonchassepeche.ca-2026-05-15T09-20-44Z-R2-corrections.json`
- `docs/site-audit/pavillonchassepeche.ca-2026-05-15T09-20-44Z-R2-investigation.md` (this)
