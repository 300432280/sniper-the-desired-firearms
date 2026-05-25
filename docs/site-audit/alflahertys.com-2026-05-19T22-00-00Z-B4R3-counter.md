# alflahertys.com B4R3 Adversarial Counter (2026-05-20T00:11Z)

Reviewer: engineering-code-reviewer. Inputs: R2 investigation + R2 corrected JSON + live site + runtime code (`generic-retail.ts`, `product-count-probe.ts`, `catalog-crawler.ts`, `crawl-scheduler.ts`, `http-client.ts`). DID NOT read R1 candidate / R1 diff / DB snapshot per harness rules.

## Verdict counts
- COUNTER: 1 partial (klevu_pageCategory decode is incomplete)
- COULDN'T DISPROVE: 9
- Net assessment: R2 corrections are sound for runtime behavior. The one counter is theoretical because the code path R2 documents is dead.

---

## Per-correction tests

### 1. R2 claim: `hasWaf: false` (Cloudflare passive)
- **Test:** Fresh `curl -sI https://alflahertys.com/` 2026-05-20T00:11:50Z. Looked for `cf-mitigated`, `cf-chl-bypass`, `x-sucuri-*`, sucuri_ cookies. Also grepped `requiresSucuri` consumers in `backend/src/`.
- **Result:** Live headers show `Server: cloudflare`, `cf-cache-status: DYNAMIC`, `Set-Cookie: __cf_bm=...` ONLY. Zero `cf-mitigated`, zero `cf-chl-bypass`, zero `x-sucuri-*`. `requiresSucuri` is NOT consumed by `http-client.ts` at all - Sucuri solving fires from BODY DETECTION (`html.includes('sucuri_cloudproxy_js')` at line 559) regardless of profile flag. So even if a Sucuri challenge ever appeared, the crawler would still solve it; `hasWaf=false` is safe.
- **Verdict:** COULDN'T DISPROVE. R2 correct.

### 2. R2 claim: Remove `wafWorkaround` block
- **Test:** Inspected fresh headers + grepped Sucuri consumers.
- **Result:** No Sucuri activity on live site. `wafWorkaround` is not read by any runtime code path (Sucuri solver is body-detection-driven).
- **Verdict:** COULDN'T DISPROVE.

### 3. R2 claim: `sortParam: null` (Klevu rejects date sorts)
- **Test:** R2 only tried `"NEWEST"`. I tested 5 alternatives via live POST against `https://uscs33v2.ksearchnet.com/cs/v2/search`:
  - `PRICE_ASC` -> HTTP 200 (totalResultsFound: 5262)
  - `PRICE_DESC` -> HTTP 200
  - `DATE_DESC` -> 500
  - `DATE_ASC` -> 500
  - `newest` (lowercase) -> 500
  - `RECENCY` -> 500
  - `RECENT` -> 500
- Also `curl /shooting-supplies-firearms-ammunition/ammunition/?sort=newest` -> 140KB HTML with `<div class="klevuLanding"></div>` shell only; zero product cards. BC's `?sort=newest` URL param is meaningless because BC SSR is not producing the product list.
- **Result:** Klevu DOES accept sorts (PRICE_*), but no date-based sort exists. The site cannot deliver a newest-first product stream via API or HTML.
- **Verdict:** COULDN'T DISPROVE. `sortParam: null` is correct.

### 4. R2 claim: `perPage: 20`
- **Test:** Read `catalog-crawler.ts:290`. `perPage: profilePerPage || (params.hasWaf ? 20 : 50)`. Klevu adapter at `generic-retail.ts:380` accepts any perPage.
- **Result:** With `hasWaf=false` and `perPage=20`, profile overrides the default-50. Explicit operator preference for smaller payloads (50 also works fine).
- **Verdict:** COULDN'T DISPROVE.

### 5. R2 claim: `needsPlaywright: false` (inert)
- **Test:** Grepped `needsPlaywright` in `backend/src/services/`.
- **Result:** Confirmed - no runtime consumer in `backend/src/services/`. Klevu API branch at `generic-retail.ts:362-401` posts JSON directly; never invokes Playwright. Field is audit residue.
- **Verdict:** COULDN'T DISPROVE.

### 6. R2 claim: `productCountMethod: klevu-api-count`
- **Test:** Read `product-count-probe.ts:342-371`. Live POST with `{sort:"RELEVANCE",limit:1}` -> `totalResultsFound: 5262`. Sitemap also = 5262.
- **Result:** Both equal. Klevu API is the canonical index. Implementation present and self-heals via `resolveKlevuKey`.
- **Verdict:** COULDN'T DISPROVE.

### 7. R2 claim: 6 firearm-relevant `catalogUrls`
- **Test:** `catalogUrls` is consumed by `catalog-crawler.ts:371`, `watermark-crawler.ts:565,681`, `stream-detector.ts:50`, `product-count-probe.ts:385` (stream-page-count branch only - NOT klevu-api-count). For Klevu-API sites, `fetchCatalogPage` ignores origin and queries ALL 5262 products via wildcard SEARCH. So catalogUrls primarily drive `streamState` initialization (how many parallel stream slots) and watermark seed points.
- **Result:** With Klevu wildcard SEARCH returning global 5262 regardless of category, having 6 catalogUrls vs 12 = 6 stream-rotation slots vs 12. Each slot re-walks the same global 5262 -> 6x is more efficient than 12x. R2's 6 are firearm-relevant. Couldn't disprove the 6 chosen; the parent-slug aliasing (`firearms-and-ammunition` vs `firearms-ammunition` vs `and-firearms`) is real BC peculiarity verified live.
- **Verdict:** COULDN'T DISPROVE.

### 8. R2 claim: 8 deep `klevuCategoryPaths` matching `klevu_pageCategory` verbatim after `&amp;` decode
- **Test (different from R2):** Fetched 4 pages NOT in R2's sample. Adversarially looked for entity types other than `&amp;`.
  - GET `/optics/` -> `klevu_pageCategory = "Optics"` (no entities)
  - GET `/als-bargains/` -> **`klevu_pageCategory = "Al&#x27;s Bargains"`** (HEX ENTITY for apostrophe - `&#x27;` is NOT `&amp;`)
  - GET `/shooting-supplies-firearms-and-ammunition/stocks-parts-barrels-kits/` -> `klevu_pageCategory = "Shooting Supplies, Firearms &amp; Ammunition;Stocks, Parts, Barrels &amp; Kits"` (only `&amp;`)
  - GET `/shooting-supplies-and-firearms/storage-transportation/` -> `klevu_pageCategory = "Shooting Supplies, Firearms &amp; Ammunition;Storage &amp; Transportation"` (only `&amp;`)
- **Result:** PARTIAL COUNTER. The adapter's HTML fallback at `generic-retail.ts:300` does `.replace(/&amp;/g, '&')` - it does NOT decode `&#x27;`, `&quot;`, `&lt;`, `&gt;`, or numeric entities. A category title containing an apostrophe (like Al's Bargains) would yield a broken `klevu_pageCategory` of literal `"Al&#x27;s Bargains"` if the runtime ever needed to call `_resolveKlevuCategoryPath` for that URL.
- **HOWEVER:** Grepped `_resolveKlevuCategoryPath` in `backend/src/` - declared at `generic-retail.ts:288` but NEVER CALLED. The active Klevu fetch path at `generic-retail.ts:387` does wildcard SEARCH with `query:{term:'*'}` globally - it never filters by category. Likewise `klevuCategoryPaths` is referenced only inside the dead method (`generic-retail.ts:291`). So R2's 8-deep-paths correction is COSMETIC; the runtime ignores both the profile field and the HTML decode bug.
- **Verdict:** COUNTER (theoretical) / COULDN'T DISPROVE (runtime). R2's 8 verbatim strings are correctly transcribed for documentation purposes. Two risks for a future maintainer:
  1. If anyone wires `_resolveKlevuCategoryPath` into the live fetch path, the HTML-decode regex at line 300 must be broadened (e.g. use `he.decode()` or a `replace` chain covering `&#x27;`, `&#39;`, `&quot;`, `&#34;`, etc.) BEFORE relying on the fallback.
  2. The 8 stored `path` values already use the unescaped `&` form - if `klevu_pageCategory` is ever sent verbatim to Klevu as a CATNAV term, the wire payload must keep `&` (not `&amp;`).
- **Corrected value:** No JSON change. Add a maintainer note: "klevuCategoryPaths is documentation-only until generic-retail.ts:288 (_resolveKlevuCategoryPath) is invoked from a live code path. Adapter's `&amp;`-only decode at line 300 is insufficient for titles containing `&#x27;` (apostrophe)."

### 9. R2 claim: Klevu key + endpoint match
- **Test:** Live POST -> 200, `totalResultsFound: 5262`. Key visible in homepage HTML.
- **Verdict:** COULDN'T DISPROVE.

### 10. R2 claim: Audit-residue + operator-knob handling
- **Test:** Confirmed `wafProbe*`, `topLevelCategories`, `extractionTested/Sample`, `auditNotes` are not consumed by runtime services. Operator knobs (budget, timeout, t1IntervalMin, cooldowns, tierShares, tierWindows) live on `MonitoredSite` columns, not in siteProfile JSON.
- **Verdict:** COULDN'T DISPROVE.

---

## Untested / skipped
- DID NOT validate against DB snapshot (rules forbade reading it).
- DID NOT re-run Playwright (R2 reported MCP timeout; static-HTML extraction is equivalent for `klevu_pageCategory` since it's SSR'd into page source).
- DID NOT attempt UI-driven sort dropdown on BC frontend (irrelevant - BC SSR is empty Klevu shell).

## Top 3 counters / risks
1. **HTML-entity decode is incomplete** (`generic-retail.ts:300`). Real category names contain `&#x27;` (`Al's Bargains`). Not a current-runtime bug because the method is dead code, but a footgun for the next developer who wires it in.
2. **`klevuCategoryPaths` config is currently runtime-inert.** R2's 8-path correction is documentation, not behavior. Recommend marking it `// not consumed at runtime - kept for future CATNAV branch` in comments / R4 synthesis.
3. **All Klevu sorts other than PRICE_ASC/PRICE_DESC/RELEVANCE return 500.** R2's `sortParam: null` decision is correct; no date-based sort exists; T1 must use full-catalog-sweep dedup.
