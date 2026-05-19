# R3 Adversarial Counter — pavillonchassepeche.ca

**Run:** R3-counter 2026-05-15T12:48:35Z (FRESH skeptic; read R2 outputs + worker.ts/playbook live, NOT R1)
**Target:** `docs/site-audit/pavillonchassepeche.ca-2026-05-15T09-20-44Z-R2-corrections.json`
**Also audited:** prior R3 at `docs/site-audit/pavillonchassepeche.ca-2026-05-13T10-45-00Z-R3-counter.md` — this R3 directly OVERTURNS the prior R3's verdict on `verifyMethod` "dead code."
**Method:** live curl + DB read-only + worker.ts:381–400 + worker.ts:700–775 line-by-line.

## Summary

- Corrections attempted: 13
- Successfully countered (R2 verdict wrong): **0**
- Partially countered (R2 verdict right, evidence/scope flawed): **1** (Rule C vs full-coverage — see below)
- Survived: 12

R2's values stand. The dispute is over WHICH operator-set values were "right" vs "operator override," not over what the live site says.

---

## REQUIRED — verifyMethod control-flow ruling (line-by-line)

This is the headline question. Prior R3 (2026-05-13) ruled `'json-ld'` is unreachable dead code, citing only worker.ts:397. **That ruling is wrong.** I re-read worker.ts:381–400 AND worker.ts:700–775.

`tryStoreApiVerify` (worker.ts:381–400) is just the fast-path probe. It returns `null` on any non-`'store-api'` value. The caller at worker.ts:703 is `const storeApiFastPath = await tryStoreApiVerify(...)` and the very next line `if (storeApiFastPath) { ... } else { ... }` (worker.ts:704 / 759) handles `null` explicitly.

Worker.ts:759–775 (the else branch) executes when fast-path returned null:
```
759    } else {
760      // ─── Verify method must be declared in site profile ───
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

Line 763 reads `verifyMethod` (raw value). Line 764 gates ONLY on `!verifyMethod` (truthy check — null/undefined/empty-string skip). Line 769 calls `verifyProductsViaPlaywright(products, ...)` **unconditionally** for any truthy value. The literal string `'json-ld'` is truthy → reaches line 769.

**Definitive ruling:**
1. Does `verifyMethod: 'json-ld'` route to Playwright? **YES.**
2. Does the verify call return early? **NO** — only `!verifyMethod` returns (line 766).
3. Does Playwright branch on the literal `'json-ld'`? **NO at worker.ts level.** Worker treats it as "any truthy value = Playwright verify." The comment at line 768 is misleading: code accepts ANY truthy value, but comment says `'detail-page'`.
4. The `'json-ld'` vs `'detail-page'` distinction (if it exists) would live inside `verifyProductsViaPlaywright` / `product-verifier.ts`. I did not chase that, but it's separate from "is `'json-ld'` reachable" — which it IS.

R2 is correct. Prior R3 was wrong. R2's claim survives.

---

## REQUIRED — Rule C vs `feedback_full_coverage.md` reconciliation

R2 claimed "full-coverage WINS on retailer sites." I dispute the framing.

Read `feedback_full_coverage.md` line 8 verbatim: *"the smallest set of URLs that together cover EVERY **firearm-relevant** product with minimum overlap."* (emphasis mine, present in source). The rule is **firearm-relevant**, not "every product." Lines 19, 148, 165, 169 of `.claude/catalog-url-discovery-playbook.md` all say "firearm-relevant." Line 850 cites theammosource precedent: *"48,012 sitemap products but only 2,437 firearm-relevant (out-of-scope verticals include motorcycle, ATV, fishing, camping). The DB coverage metric must compare against the firearm-relevant catalogUrls aggregate, NOT the whole sitemap."*

**Live test of R2's claimed-firearm-irrelevant categories** (sampled product-card classes via curl):
- `/en/product-category/fishing/` → cards with `product_cat-fishing-rods`, `product_cat-fishing-line`, `product_tag-rapala-en` (Rapala = fishing brand). Zero firearm content.
- `/en/product-category/clothing/` → `product_cat-vetements-gants-et-mitaines` (gloves/mittens), `product_cat-boots`, `product_tag-acton-en` (Acton = boot brand). Zero firearm content.
- `/en/product-category/outdoors-en-4/` → cards include `plein-air-randonnee` (hiking). One cross-tags `hunting-en-6` (already covered by hunting catalogUrl).

By the playbook + feedback_full_coverage.md (both authoritative), fishing/clothing/outdoors should be **excluded**. The playbook directly precedents theammosource as "fishing, camping = out-of-scope verticals."

**Reconciliation:** R2's verdict that "DB is right" treats DB as ground truth. But DB stores the OPERATOR'S choice, not the playbook-correct answer. R1's Rule C exclusion matches the playbook + feedback_full_coverage.md. DB's wider coverage is an operator override (possibly defensible if scope filtering at keyword-match time is unreliable, but the playbook + feedback_full_coverage.md don't support that).

**Verdict:** R2's "DB_CORRECT" verdict on `catalogUrls` is OPERATOR_OVERRIDE not playbook-correct. R1's narrower set is the playbook answer. Both can be defended, but R2's framing ("full-coverage wins on retailer sites") is wrong — `full_coverage.md` says firearm-relevant, not all-products. **This is the one partial counter — value is operator's call, not a clean DB-wins.**

---

## REQUIRED — WPML hreflang x-default verdict

Live apex HTML inspection (curl + grep):
```
<html lang="fr-FR">
<link rel="canonical" href="https://pavillonchassepeche.ca/" />
<link rel="alternate" hreflang="fr" href="https://pavillonchassepeche.ca/" />
<link rel="alternate" hreflang="en" href="https://pavillonchassepeche.ca/en/" />
<link rel="alternate" hreflang="x-default" href="https://pavillonchassepeche.ca/" />
<meta name="generator" content="WPML ver:4.8.6 stt:1,4;" />
```
`Accept-Language: en-US` HEAD probe → HTTP 200, no redirect, no `location:` header. Same body. WPML lang cookie defaults to `fr`.

**Verdict:** R2 is **right** that there is no Accept-Language redirect, and BOTH trees are independently reachable. BUT the canonical-equality framing ("two co-equal trees") is wrong on the wire: `x-default` hreflang = FR apex. By the W3C/Google spec, `x-default` IS the site-canonical for users without a matching language preference. The EN tree exists as an alternate, not as a co-equal canonical. The operator's choice of `/en/` as runtime root is an OPERATOR_OVERRIDE of the site's stated `x-default`. R2's "OPERATOR_CHOICE" verdict label is right; the "two co-equal trees" explanation is loose. **The url-field verdict stands.**

---

## Other corrections — survival check

| field | R2 verdict | counter? |
|---|---|---|
| expectedProductCount (1243 today, DB 1318 stale) | R1 right today | Confirmed live: Store API X-WP-Total=1243, WP REST=1253. DB 1318 matches nothing. SURVIVES. |
| productCountMethod.endpoint (WP REST vs Store API) | OPERATOR_CHOICE | Both endpoints return X-WP-Total live. SURVIVES. |
| perPage 100 / paginationPattern.perPage 36 | DB right for API, R1 right for HTML | Confirmed prior R3: HTML pagination locked at 36 by Elementor. SURVIVES. |
| verifyEndpoint omitted (json-ld doesn't need one) | DB right | Follows from verifyMethod ruling above. SURVIVES. |
| apiEndpoints 2-step (productDiscovery/priceEnrichment) | DB right | DB matches dataFlow.steps in profile. SURVIVES. |
| multilingual: wpml | DB right | WPML 4.8.6 generator meta confirmed live. SURVIVES. |
| htmlFallback / method / cooldowns / tierShares | DB right (runtime/scheduler) | Not derivable from probe. SURVIVES. |

---

## Skill-gap findings worth keeping

R2 surfaced 5 skill gaps. Three I'd elevate:
1. **WPML detection** — should be Stage-3 marker (generator meta or sitepress-multilingual-cms asset path). Currently the skill doesn't emit `multilingual: wpml`.
2. **verifyMethod must be probed, not template-defaulted.** Today the skill hardcodes `'store-api'` for WooCommerce. The operator overrode to `'json-ld'` for a reason. The skill should test Store API batch-by-ID at scale before locking in `'store-api'`.
3. **apiEndpoints shape conflates discovery + enrichment.** `{products, categories}` is wrong for sites where WP REST returns IDs-without-prices and Store API returns prices-by-ID. Need `{productDiscovery, priceEnrichment, categories}`.

`Rule C vs full-coverage` is NOT a real skill gap — both files agree on "firearm-relevant." The gap is that the operator overrode the rule for this site; the skill is doing the right thing by Rule C.

---

## Final position

ACCEPT R2's R1→DB corrections **as operator-state**. One framing flag: R2's "feedback_full_coverage.md wins" reasoning on `catalogUrls` misreads the rule — playbook + feedback both say "firearm-relevant," so R1's narrower Rule C set is playbook-correct; DB's wider set is operator override. Not a value counter, a framing counter.

Headline: **prior R3's `'json-ld' = dead code` verdict is overturned.** Worker.ts:759–775 routes any truthy verifyMethod to Playwright. R2's reading is correct.
