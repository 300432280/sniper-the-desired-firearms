# R3 Adversarial Counter - pavillonchassepeche.ca

**Run:** R3-counter-2026-05-13T10:45:00Z (FRESH skeptic; did NOT re-read R1 diff/candidate; read R2 outputs + runtime code only)
**Target:** docs/site-audit/pavillonchassepeche.ca-2026-05-13T08-55-17Z-R2-corrections.json
**Method:** Tried to disprove each of R2's 18 "R1 correct" verdicts via independent live probes.

## Summary

- **Corrections attempted:** 18
- **Successfully countered (value):** 0
- **Partially countered (evidence/reasoning flawed, value still stands):** 1 (D2 - "29% EN coverage" claim)
- **Survived:** 17

The R1 candidate's corrected VALUES all stand. One R2 EVIDENCE chain was disproven but does not change the final accepted value.

---

## D1, D5, D6, D7 - HTML perPage override test (REQUIRED)

R2 says HTML pagination is fixed at 36 cards regardless of `?per_page=` or `?posts_per_page=`. Tested per the R3 mission spec.

| URL | cards |
|---|---|
| `/categorie-produit/chasse/armes-a-feu/` | 36 |
| `/categorie-produit/chasse/armes-a-feu/?per_page=72` | 36 |
| `/categorie-produit/chasse/armes-a-feu/page/2/?per_page=72` | 36 |
| `/shop/?per_page=72` | 301 -> `/magasiner/`, 0 cards on the redirect target (not a product archive root) |

HTML perPage override does not work. R2's perPage=36 claim survives.

---

## D2 - EN catalogUrls coverage - PARTIAL COUNTER

R2 claim: "EN top-level cats sum to ONLY 363 products vs scope total 1251 = 29% coverage" -> DB's EN catalogUrls violate `feedback_full_coverage.md`.

**Counter:** R2's 363 number comes from WP REST `product_cat.count`, which is filtered by WPML term-language association and **does not match actual HTML archive output**. Walked each EN top-level archive via plain HTML and counted `product type-product` cards:

| EN cat | R2 said (WP REST count) | Actual HTML walk (this R3) |
|---|---|---|
| clothing | 63 | **180** |
| fishing | 27 | **242** |
| hunting-en-6 | 78 | **412** |
| liquidation-en | 123 | **338** |
| outdoors-en-4 | 22 | **129** |
| saltworks | 49 | 49 |
| tirage | 1 | 1 |
| **SUM** | **363** | **1351** |

EN scope X-WP-Total=1251. Actual HTML walk yields 1351 (cross-tag overlap). Coverage is ~100%, not 29%. Confirmed by Store API: `/en/wp-json/wc/store/v1/products?category=997` (hunting-en-6) returns X-WP-Total=412, same as FR `category=21` (chasse=412). The Store API ignores WPML category-term scope and returns the same underlying product set regardless of `/en/` prefix.

**However:** the FINAL corrected catalogUrls value (FR `/categorie-produit/chasse/` + `/categorie-produit/salines/`) still stands for reasons R2 also gave but for different mechanisms:
- Canonical language: apex returns `<html lang="fr-FR">`, no `/en/` or `/fr/` redirect on root. FR is the unprefixed default.
- WPML duplication pitfall: EN archive yields `/en/product/<slug>/` permalinks while FR yields `/produit/<slug>/`. Same WC product_id (verified: id=93316) is reachable via both URLs. Crawling the EN side would create duplicate ProductIndex rows (URL-based delta detection).

Verdict: D2's corrected VALUE survives; D2's "29% coverage" supporting evidence does NOT - the actual coverage gap was misdiagnosed. Real reason to prefer FR is canonical-language + WPML-duplicate avoidance, not coverage shortfall.

---

## D8, D9 - worker.ts verifyMethod routing verdict (REQUIRED)

Read backend/src/services/worker.ts:381-400 directly.

```
line 397: if (!maintainConfig || maintainConfig.verifyMethod !== 'store-api') return null;
line 399: const verifyEndpoint = maintainConfig.verifyEndpoint;
line 400: if (!verifyEndpoint) return null;
```

Confirmed: `verifyMethod === 'store-api'` is the only value that activates the fast-path; `verifyEndpoint` is required. `json-ld` is silently dead. R2's claim survives on D8 and D9 verbatim.

---

## D3 - expectedProductCount = 1245

- WC Store API per_page=1: X-WP-Total=**1245**
- WP REST per_page=1: X-WP-Total=**1253**
- EN WC Store API per_page=1: X-WP-Total=**1251**

Three valid totals exist. R2 already flagged "medium confidence" for this. 1245 stands as conservative customer-visible. Could not disprove.

---

## D4, D18 - productCountMethod endpoint + extras

Read backend/src/services/product-count-probe.ts:148-154 directly. Confirmed only `m.endpoint` + `m.header` are consumed; extras (`wpRestTotal`, `enScopeTotal`, `storeApiTotal`, `rootScopeTotal`) are dead audit residue. Rule B violation confirmed. Could not disprove.

---

## D10-D17 - timestamps, ageGate, WAF probe evidence, topLevelCategories, extractionTested, operator-only fields

Spot-checked each; no counter-claim materialized. `extractionTested` verified as real runtime field at backend/src/services/profile-validator.ts:172. All survive.

---

## peche/vetements firearm-product walk verdict (REQUIRED)

Full Store API walks (this R3, fresh):

- peche (id=144, 244 products, 3 pages): 2 firearm-tagged products - `BILLET DE TIRAGE` and `VICTORINOX COUTEAU SPARTAN ROUGE 12 FONCTION`. **Both also tagged `21:chasse`** and appear in chasse Store API search (verified). Neither is an actual firearm (raffle ticket + Swiss army knife).
- vetements (id=197, 184 products, 2 pages): 2 firearm-tagged - `BILLET DE TIRAGE` (same product) and `BUCKLAND SAC A DOS ROWAN 20L`. Both also in chasse archive (verified).
- tirage (id=1107): 1 product (BILLET DE TIRAGE), already cross-tagged in chasse.

No firearm-relevant product exists outside the chasse rollup. R2's claim survives.

---

## HTML perPage=72 override test verdict (REQUIRED)

Already documented above (D1/D5/D6/D7). Override is ignored - server returns 36 cards regardless of `?per_page=72`, `?per_page=100`, or `?posts_per_page=100`. WC Store API DOES honor `per_page` up to 100 (HTTP 400 above). Distinct configs.

---

## worker.ts verifyMethod routing verdict (REQUIRED)

Already documented above (D8/D9). Confirmed verbatim at worker.ts:397. `'json-ld'` is unreachable dead code.

---

## Final position

ACCEPT R2's "R1 ACCEPT" verdict. All 18 corrected values stand under live re-probe.

One blemish: R2's D2 supporting evidence ("29% EN coverage") was a measurement artifact from WP REST `product_cat.count` and does not reflect actual HTML archive coverage (~100%). The corrected value still stands on canonical-language + WPML-duplicate-permalink grounds. Operator note: future audits of WPML sites should walk archive HTML rather than trust WP REST term counts when assessing coverage.
