# Batch 6 — Round 4 Synthesis (Orchestrator, Karpathy §1–§4 throughout)

Batch: 2026-05-23 (3 sites, 4 rounds, 9 agent-spawns, no DB writes).

Sites: basspro.ca, townpost.ca, www.gobles.ca.

R3 tally: 1 substantive counter (basspro count regex case-flag), 7 couldn't-disprove, 2 untested-by-harness (Akamai page-2 wall), 1 R3-refinement (gobles catalogUrls 90→84).

---

## A. Per-site final corrections (no DB writes)

### basspro.ca

| Field | Final value | Source |
|---|---|---|
| `platform` | `ibm-websphere-commerce` | R2-confirmed live markers (wcParamJs.storeId=10151, catalogId=10052, /webapp/wcs/stores/servlet/* paths). DB's `generic-retail` was adapter-fallback. |
| `expectedProductCount` | **16,543** | R3 catch: R2's 16,526 used case-sensitive grep; runtime `product-count-probe.ts:323` uses `new RegExp(patternSrc, 'i')` — 17 uppercase-slug products were missed. |
| `productCountMethod` | `{ method: 'generic-product-sitemap', url: '/webapp/wcs/stores/servlet/sitemap_10151.xml.gz', pattern: '/p/' }` | Canonical method at VALID_METHOD_NAMES[117]; sitemap path listed in robots.txt line 8 (DB investigator never opened the `.gz` path). |
| `searchUrl` | `/webapp/wcs/stores/servlet/SearchDisplay?storeId=10151&catalogId=10052&langId=-1&searchTerm={keyword}` | R2/R3 B3 junk-keyword diff PASSED across 6 keyword/junk pairs (real terms returned 351-1134 results / 134-175KB; junk returned 0 / ~49KB). DB's `/search?q=` returns 404. |
| **OPERATOR DECISION** | perPage / paginationPattern / sortParam / catalogUrls full walk | **Untested-by-Akamai**: page-2+ blocked by Bot Manager from audit IP across all UAs/TLS handshakes. Production-IP re-probe needed before promotion. |
| **Akamai risk** | hasWaf=true, wafType=akamai-bot-manager | Single-GET passes; sustained access requires either residential-IP rotation or real-browser Playwright TLS-matching. |

### townpost.ca

| Field | Final value | Source |
|---|---|---|
| `adapterType` | `generic` (DB) | R1's `classifieds-gunpost` wrong; gunpost adapter is for Drupal classifieds. Townpost is Tailwind+Next.js. **BUT** `generic.ts:91-130` lacks the `a[href*="/marketplace/"]` selector — runtime gap (see B2). |
| `perPage` | **21** (R1) | DB's 17 + pinnedAds=4 FALSIFIED: 10-page walk shows 21 unique IDs per page, 10-way intersection = 0. Only 1 "Top Ad" badge sitewide. |
| `pinnedAds` | 0 (or omit) | Same evidence. DB's 4 wrong. |
| `expectedProductCount` | **8,889** | 423×21 + 6 = 8889. |
| `lastPage` | **424** | Pages 425/500/1000 return byte-identical p1 echo (deterministic wrap, not CDN cache — R3 verified across 3 timestamps + 5s repeats). |
| `searchUrl` | `/search?q={keyword}` (DB) | R2/R3 B3 PASSED: glock/ammo/rifle = 21 results; xyz789nonsense/zzzzzzz/asdfqwerzxcv = 0. Clean signal/noise. R1 omitted. |
| `sortParam` | null | R2 tried 5 variants — all return identical results. Default sort is bump-date NOT creation. DB sortNote right; R1's "monotonic ID descent" FALSIFIED. |
| `classifiedRules.soldDetection` | Leave/null (low confidence) | R3 flag: unverified by either round. Drop or mark `confidence=low`. |

### www.gobles.ca

| Field | Final value | Source |
|---|---|---|
| `hasWaf` | **false** (column AND siteProfile.hasWaf) | R3 confirmed Cloudflare-passive via 8 cross-UA probes (monotonic CF-RAY a0118109..a0118141, no challenges). DB's `hasWaf:true + wafType:cloudflare-passive` B10-invalid. |
| `productCountMethod` | `{ method: 'generic-product-sitemap', url: '/sitemap.xml', pattern: '\\.html$' }` | DB's `category-page-walk` NOT in VALID_METHOD_NAMES → silent-disable. R3 verified shape matches runtime switch at L313-335; sitemap returns 6383 `<loc>`, 3770 matching `.html`. |
| `expectedProductCount` | **3,770** | Sitemap count. DB's 596 (parent-page-yield) severely undercounts. |
| `catalogUrls` | **84 URLs** (R2's 90 minus the 6 empty sub-action leaves R3 caught) | R3 walked all 20 of R2's added leaves with `.product-element`; 6 returned 0 products: centerfire-rifles/{falling-block,pump-action}/, combination/centerfire-shotgun/, rimfire-rifles/{pump-action,revolver}/, shotguns/lever-action/. |
| `perPage` | 100 | LightSpeed `?limit=100` honored; `?limit=250` silently caps to 24. |
| `sortParam` | `?sort=newest` | 3-outcome counter-control verified. |
| `paginationPattern` | `{ type: 'suffix-replace', template: 'pageN.html?sort=newest', perPage: 100 }` | LightSpeed path-segment per batch-5 B5 lesson. |
| **DB spine RUNTIME-BROKEN** | DB's 9-parent URLs return 0 products via production selectors across all 4 UAs at 3 time-of-days | Loss = ~596 products = 16% of catalog if promoted. |

---

## B. Cross-cutting lessons learned by artifact

### B1. SKILL.md gaps

1. **Akamai Bot Manager TLS/JA3 fingerprint detection** blocks paginated/parameterized URLs from non-production IPs across all UAs AND headless Playwright. Even with batch-4 D2 `--sustained` flag, this site can't be fully audited from a non-production IP. SKILL.md needs an "Akamai blockade" section documenting the production-IP requirement.
2. **WebSphere Commerce platform fingerprint** missing from SKILL.md primary platform table. Markers: `wcParamJs.storeId`, `catalogId`, `/webapp/wcs/stores/servlet/`, sitemap at `/webapp/wcs/stores/servlet/sitemap_{storeId}.xml.gz`. Add to platform table + gz-sitemap pattern to Stage 8.
3. **Bump-date vs creation-date confusion on classifieds**: monotonicity test must verify within-page ID order, NOT max-per-page descent. SKILL.md classifieds section should warn explicitly.
4. **Pinned-ads detection**: walk 10+ pages and find IDs present in ALL/most pages. R1's single-badge inference was wrong; R2's 5-page walk found 0 truly pinned; R3's 10-page broadening confirmed.
5. **Parent-page-yields-zero trap**: LightSpeed and similar platforms render parent-category pages as subcategory tiles (no product cards). DB's `categoryStats` from a different surface masks the issue. SKILL.md must say: catalogUrls must yield products via the SAME extraction selectors the runtime uses; DB stats from another surface are not authoritative.
6. **Robots.txt sitemap directive**: read `Sitemap:` line(s) literally — don't guess paths. basspro's WebSphere-specific `/webapp/wcs/stores/servlet/sitemap_10151.xml.gz` was missed because the investigator tried `/sitemap.xml` first.

### B2. Runtime code gaps

1. **`generic.ts:91-130 extractCatalogProducts` missing `a[href*="/marketplace/"]` selector** that `generic-retail.ts:964` has. Townpost (and other classifieds-shape sites) won't extract through generic.ts without it. Surgical port + vitest case.
2. **Methodology gap (not a runtime bug)**: `product-count-probe.ts:323` uses `new RegExp(pattern, 'i')`. R2's manual grep used case-sensitive matching → 17 missed uppercase-slug products on basspro. SKILL.md verification section should require: when reproducing a runtime regex by hand, copy the exact flags.
3. **Non-canonical productCountMethod names** continue to slip through (`category-page-walk` on gobles). The new C5 validator (batch-5) is supposed to catch these at promote — confirm it actually runs in the promotion path.

### B3. Harness/methodology gaps

1. **R3 broadening keeps delivering value**: caught basspro's case-flag bug + gobles's 6 empty sub-action leaves. The 3× broaden rule from SKILL.md calibration mode is consistently load-bearing.
2. **R1 self-falsification on townpost** ("monotonic ID descent" → "within-page IDs disproved it") is a strong signal. R1 prompts could explicitly encourage: "if your own observations contradict your verdict, mark CONTRADICTORY in the diff hypothesis."
3. **Untested-by-harness classification used correctly**: basspro R2 + R3 both applied it for Akamai-blocked items rather than misclassifying as "couldn't disprove."
4. **Cross-batch verification standing task**: basspro R3 confirmed commit `ee63f12` (batch-3 fix) accepts `generic-product-sitemap` in allowlist. Standing R3 directive #3 paid off again.

---

**Bottom line**: 1 substantive R3 counter, 1 R3 refinement, 7 couldn't-disprove, 2 untested-by-harness.

**Highest-impact**:
- **gobles DB spine returns 0 products via production selectors** → if used as-is in production, loses 16% of catalog. Replace with R3's 84-URL list.
- **basspro Akamai blockade** → either crawl from production IP, use real-browser Playwright with TLS matching, or skip. Operator call.
- **townpost generic.ts missing selector** → runtime fix; without it, adapter returns empty even though page has 62 marketplace anchors.

No DB writes performed. 3 sites ready for operator promotion review.
