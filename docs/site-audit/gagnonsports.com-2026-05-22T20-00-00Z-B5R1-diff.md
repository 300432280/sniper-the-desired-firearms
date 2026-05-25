# B5R1 Diff — gagnonsports.com (candidate vs DB snapshot)

Candidate: `docs/site-audit/gagnonsports.com-2026-05-22T20-00-00Z-B5R1.json`
DB snapshot: `_audit_tmp/batch5-2026-05-22/gagnonsports.com-DB-snapshot.json`

## Agreements (no divergence)
- `platform = lightspeed-ecom`
- `adapterType = generic-retail`
- `hasCaptcha = false`
- `sortParam = "?sort=newest"` (both)
- `paginationPattern.type = "suffix-replace"`, `match = "?sort=newest"`, `template = "page{N}.html?sort=newest"`
- `needsPlaywright = false`
- `crawlers.watermark.method = "navigate-from-watermark"`
- `crawlers.maintain.verifyMethod = "detail-page"`
- Most `/hunting/...` catalogUrls overlap.

## Divergences (numbered, with one-line WHY)

1. **`hasWaf`** — Candidate `false` vs DB `true`. WHY: I treated cf-ray + DYNAMIC cache + clean rapid burst as Cloudflare-passive (operationally not gating), so per the skill's "operational" rule I set false. DB pairs `true` with `wafType: cloudflare-passive` + iPhone UA workaround — operator chose true defensively. Mine likely wrong; B9 sustained-walk test skipped.

2. **`wafWorkaround`** — Candidate `null` vs DB `{ method: "mobile-ua", ... }`. WHY: I observed all UAs returned 200 on a one-shot probe so concluded no workaround. DB pins iPhone Safari UA as long-term policy. I didn't sustained-walk 50+ pages per UA. Mine likely wrong.

3. **`userAgentOverride`** — Candidate `null` vs DB iPhone Safari 17.2. WHY: Same as #2 — I skipped the production-UA-pool sustained walk. Mine likely wrong.

4. **`perPage`** — Candidate `100` vs DB `24`. WHY: I probed `?limit=100` and got 47/47 on centerfire-rifles single fetch; tui-limit UI exposes 100. DB shipped 24 (default). Tradeoff: largest verified vs Cloudflare burst pressure. Both defensible.

5. **`paginationPattern.perPage`** — Candidate `100` vs DB `24`. Same as #4.

6. **`expectedProductCount`** — Candidate `2706` vs DB `2613`. WHY: 3.6% drift (inside 5% gate). I included 7 `/firearms/...` leaves DB excluded (~227 products); DB included 2 archery leaves I excluded (~unknown); I included empty `collectors-cartridges`. Candidate-acceptable but URL set differs.

7. **`catalogUrls` — `/firearms/new-firearms/*` and `/firearms/used-firearms/*`** — Candidate includes 10 such URLs; DB has 0. WHY: I verified `/firearms/new-firearms/centerfire-rifles/` returns 47 real products live today (Browning, Benelli, AKDAS). DB note "No /firearms/ category exists" contradicts live evidence; site likely added the `/firearms/` tree since DB lastVerified 2026-04-07. DB likely wrong (Mistake 12 risk on DB side; missing 227+ firearm products).

8. **`catalogUrls` — `/archery/bows/`, `/archery/arrows-accessories/`** — DB includes; candidate excludes. WHY: I applied Rule C "pure archery not firearm-relevant" exclusion (Rule C's include list has airsoft = firearm-shaped, not bow/arrow). DB scope is broader. Inconclusive — operator scope choice.

9. **`catalogUrls` — `/sale/hunting-super-specials/new-used-guns/`, `/previously-owned-merchandise/`** — DB includes; candidate excludes. WHY: I judged these as overlapping with leaf categories without proving redundancy. Per Rule C "only drop when proven redundant via full walk + dedup", my exclusion is rule-violating. Mine likely wrong.

10. **`catalogUrls` — `/hunting/ammunition/collectors-cartridges/`** — Candidate includes (empty today); DB excludes. WHY: I followed Rule C "empty ≠ dead, keep". DB drops on 0-walk evidence. Mine correct per Rule C.

11. **`productCountMethod`** — Candidate `{method:"html-pagination", selector, perPage:100}` vs DB `{method:"sitemap-flat", sitemapUrl, productPattern}`. WHY: `sitemap-flat` is NOT in `product-count-probe.ts`'s 11 canonical method names — runtime switch falls through to `default: return null` (B6 shape-gate violation). DB likely wrong on this field. My `html-pagination` is canonical but the value 2706 isn't a single runtime probe either — both have gaps.

12. **`searchUrl`** — Candidate `/search/?q={keyword}` vs DB `/search/{keyword}/`. WHY: I read the form `<form action="/search/" method="get">` (= `?q=` query form). DB has path-form variant. I did not live-validate against a known firearm keyword (B4 rule violated). Inconclusive — DB form may be validated; mine is form-action-derived only.

13. **`crawlers.watermark.reason`** — Candidate emits a reason string; DB has only `method`. Cosmetic — skill only requires `reason` on `full-catalog-sweep`.

14. **`crawlers.bootstrap.apiEndpoints`** — DB has the field (null). Skill skips (operator-doc only, zero runtime consumers). Cosmetic.

## Summary
- **Divergence count**: 14
- **Blockers**: none (skill ran to completion)
- **Likely candidate wrong**: #1 hasWaf, #2 wafWorkaround, #3 userAgentOverride, #9 missing sale/used catalogUrls
- **Likely DB wrong**: #7 missing all `/firearms/...` (~227 live firearm products), #11 non-canonical `sitemap-flat` method
- **Inconclusive**: #4-5 perPage tradeoff, #8 archery scope, #12 searchUrl form

## Top 3 WHYs

1. **DB missing `/firearms/new-firearms/*` and `/firearms/used-firearms/*`** — Live walk found 7 productive firearm leaves (~227 products: BAR centerfire 47, rimfire 30, shotguns 73, air-guns 16, used-rifles 42, used-shotguns 19). DB note "No /firearms/ category exists" contradicts homepage nav + sitemap + live extraction. Likely site change since 2026-04-07.
2. **`hasWaf` + `userAgentOverride` skipped sustained walk** — I read one-shot cf-ray + 200 across UAs as Cloudflare-passive and dropped the iPhone UA. B9 rule explicitly says: run a 50-page sustained walk with each of the 5 production UAs before concluding "no workaround". I skipped that. DB's defensive iPhone UA is the load-bearing position.
3. **`perPage` 100 vs 24** — I shipped largest-verified (skill rule) but never timed both paths end-to-end against rate-limit risk; DB conservatively shipped 24. Defensible either way; the perPage tradeoff explicitly listed in skill anti-pattern: "any 'X is faster' claim needs side-by-side timing at scale, not single-request math".

## Paths
- Candidate JSON: `docs/site-audit/gagnonsports.com-2026-05-22T20-00-00Z-B5R1.json`
- Diff: `docs/site-audit/gagnonsports.com-2026-05-22T20-00-00Z-B5R1-diff.md`
- DB snapshot: `_audit_tmp/batch5-2026-05-22/gagnonsports.com-DB-snapshot.json`
