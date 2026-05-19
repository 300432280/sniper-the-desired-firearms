# dantesports.com R3 adversarial counter (R2 = 2026-05-15T09-19-32Z)

Run: `dantesports.com-2026-05-15T12-47-10Z-R3`.
Reviewer: engineering-code-reviewer (FRESH skeptic).
Mission: try to disprove R2 corrections. NO DB writes. 800ms inter-request delay.

R2 corrections: `docs/site-audit/dantesports.com-2026-05-15T09-19-32Z-R2-corrections.json`
R2 investigation: `docs/site-audit/dantesports.com-2026-05-15T09-19-32Z-R2-investigation.md`
Prior R3 (older R2 batch): `docs/site-audit/dantesports.com-2026-05-13T09-11-28Z-R3-counter.md`

---

## MANDATED probes (executed first)

### A. /en/ prefix runtime behavior — 3-URL live curl + code read

Live (per_page=1, browser UA, 800ms apart):

```
GET https://dantesports.com/wp-json/wc/store/v1/products?per_page=1
  -> HTTP 200, x-wp-total: 2131, x-wp-totalpages: 2131

GET https://dantesports.com/en/wp-json/wc/store/v1/products?per_page=1
  -> HTTP 200, x-wp-total: 2130, x-wp-totalpages: 2130

GET https://dantesports.com/fr/wp-json/wc/store/v1/products?per_page=1
  -> HTTP 200, x-wp-total: 2131, x-wp-totalpages: 2131
```

The prefix DOES matter at the wire level — `/en/` returns a different totals header (2130 vs 2131). One product is FR-only.

Code read — `backend/src/services/scraper/adapters/woocommerce.ts`:

- L288  `async fetchCatalogPage(origin: string, ...)` — `origin` is the parameter.
- L298  `new URL(origin).hostname` — treats `origin` as a full URL.
- L340  ``axios.get(`${origin}/wp-json/wp/v2/product`, {...})``
- L422  ``axios.get(`${origin}/wp-json/wc/store/v1/products`, {...})``
- L530  ``axios.get(`${origin}/wp-json/wc/store/v1/products`, {...})``

All three lines hard-code the path immediately after `${origin}`. Callers set `origin = new URL(siteUrl).origin`, which per WHATWG spec returns only `protocol+host` (no pathname). There is no code path that injects `/en/` or `/fr/` between `${origin}` and `/wp-json/...`.

Verdict: **the prefix DOES NOT reach the runtime catalog adapter.** Whatever `crawlers.bootstrap.apiEndpoints` string is stored in siteProfile is decoration; the adapter will always hit `https://dantesports.com/wp-json/...` (bare origin = the FR default = x-wp-total=2131).

Implication for R2: R2 says "all catalog/API endpoints in siteProfile must use the `/en/` prefix" and proposes `expectedProductCount=2130` (EN canonical) and `productCountMethod.endpoint=/en/wp-json/...`. Per code, the adapter will fetch the bare path (2131 products). The stored `/en/` endpoint string MISLEADS any future auditor into believing EN is crawled when in fact FR is crawled. The honest values for runtime behavior are:
- `expectedProductCount = 2131` (matches what the runtime adapter sees)
- `productCountMethod.endpoint = "/wp-json/wc/store/v1/products"` (matches reality), OR an explicit note that the field is documentation only.

This is the **strongest counter to R2** and aligns with prior R3 (older batch) which independently reached the same finding.

### B. `unclassified` 14-product walk — REPRODUCED + ONE CORRECTION

R2 says category `unclassified` holds 14 unique products. R2's catalogUrls list contains the URL `https://dantesports.com/en/product-category/unclassified/` — URL is correct.

I resolved the slug to category ID via WP REST `product_cat?slug=unclassified` → id=2408, count=15.

Live Store API walk `category=2408&per_page=100`:
- `x-wp-total: 14`, array length 14 (matches R2's 14 from Store API path; wp/v2 count=15 includes a draft/private item not exposed by Store API)
- Of 14 returned: **13 products are SOLO unclassified** (only category = `unclassified`). 1 product (`allen-sound-defender-foldable-safety-earmuffs`) is multi-cat with `[other-an, specials-an, unclassified]`.

So R2's "all 14 are solo" is slightly off — the true count of products that would be ORPHANED by dropping unclassified is **13**, not 14. The CONCLUSION still stands: dropping `unclassified` leaves 13 products uncrawled, violates full-coverage. **KEEP `unclassified` is correct.**

Important: R2's investigation also mentions cat id 12277 in the catalogUrls list. Independent check via `wp/v2/product_cat/12277` shows that ID belongs to **30-jours-de-bushnell** (the Bushnell marketing aggregate), not unclassified. R2 listed the unclassified URL correctly in the proposedValue but referred to the wrong ID in narrative — keep an eye on this in any downstream JSON.

### C. Does `per_page=100` get rejected with HTTP 400?

Live (Store API, /en/, browser UA, 800ms apart):
```
per_page=48   -> HTTP 200, x-wp-total: 2130, x-wp-totalpages: 45
per_page=100  -> HTTP 200, x-wp-total: 2130, x-wp-totalpages: 22
per_page=150  -> HTTP 400  (over WP REST default cap of 100)
```

per_page=100 is honored. The mandated "what if the API rejects 100 with 400" scenario is FALSE for this site. WP REST hard-caps at 100; 150 is rejected. R2's perPage=100 is correct for the runtime Store API path.

Verdict: COULDN'T DISPROVE R2's `perPage=100`.

### D. wafType — re-grep for OTHER consumers

R2 claimed `wafType` is read ONLY by `profile-validator.ts:122-125`. Independent grep:

`backend/src/`:
```
backend\src\services\profile-validator.ts:122  name: 'wafType',
backend\src\services\profile-validator.ts:124  run: (p) => (p.hasWaf === true && !p.wafType)
backend\src\services\profile-validator.ts:125  ? 'wafType should be set when hasWaf is true ...' : null,
```
That part matches R2.

`frontend/src/`:
```
frontend\src\app\dashboard\admin\profiles\page.tsx:13   wafType?: string;
frontend\src\app\dashboard\admin\profiles\page.tsx:48   'platform','adapter','phase','hasWaf','wafType','perPage',...
frontend\src\app\dashboard\admin\profiles\page.tsx:356  <td ...>{p?.wafType ?? '—'}</td>
frontend\src\app\dashboard\admin\profiles\page.tsx:461  for (const key of ['platform','adapter','phase','hasWaf','wafType',...])
frontend\src\app\dashboard\admin\profiles\page.tsx:496  knownKeys = new Set([...,'wafType',...])
```

**COUNTER-CLAIM**: R2 (and prior R3) both stated `wafType` has exactly ONE consumer (profile-validator). The Admin Profiles UI displays it in a column (`page.tsx:356`), uses it in field grouping (`page.tsx:48, 461`), and registers it in the known-keys set (`page.tsx:496`). So changing `wafType` from `cloudflare-passive` to `wordfence` is **not purely cosmetic for runtime backend code**, but it IS visible to admin operators and will show `wordfence` on the dashboard. R2's conclusion (set to `wordfence`) still holds — and in fact the UI exposure is an argument FOR accuracy, not against. But R2's framing "cosmetic for runtime" understates the operator-UX surface.

---

## Per-correction counter attempts

### 1. wafType: `wordfence` (R2) vs `cloudflare-passive` (DB)

**Disprove method**: Independent payload + body inspection. Used a third payload not in R1 or R2 batch.

```
GET https://dantesports.com/?eval=alert(document.cookie)
  -> HTTP 403; body contains "Generated by Wordfence" + ".wf-btn" CSS class
  -> Response headers: server: cloudflare, cf-ray: ...
```

Independent confirmation that the 403 BODY is rendered by Wordfence at origin and passed through CF. The fact that CF headers appear on EVERY response (including 200s for normal pages) confirms CF is a passive CDN, not the blocking layer.

**Verdict: COULDN'T DISPROVE.** R2 correct that `wafType=wordfence` is the operationally-blocking layer label.

Sharpened note: R2 (and prior R3) called this "cosmetic for runtime". With the frontend Admin UI consumer now confirmed (`page.tsx:356`), the value also drives operator triage signaling, so accuracy matters operator-side. Either way, `wordfence` is the right answer.

### 2. perPage = 100 (R2) vs 48 (R1) vs 12 (DB)

Live Store API: per_page=100 honored (200, 22 pages of 2130); per_page=48 honored (200, 45 pages); per_page=150 rejected (400).

Code: `woocommerce.ts:293` `Math.min(options?.perPage ?? 100, 100)`. Setting siteProfile.perPage=100 matches both the adapter clamp ceiling AND the API hard cap.

**Verdict: COULDN'T DISPROVE.** R2 correct on perPage=100.

Caveat: if Store API is ever down and the adapter falls back to HTML (theme caps at 48), the fallback path will fetch perPage=100 → server returns 12. That is a graceful-degradation issue, not a perPage value issue. R2's note about exposing `paginationPattern.htmlPerPage=48` is sensible but not required.

### 3. expectedProductCount = 2130 (R2) vs 2131 (R1) vs 2086 (DB)

Live: `/en/` x-wp-total=2130, `/fr/` x-wp-total=2131, bare-origin x-wp-total=2131.

R2's argument hinges on "crawlers fetch the /en/ path, so use the EN-canonical count". But per A above, the **adapter code fetches the bare origin path** regardless of what is stored in `crawlers.bootstrap.apiEndpoints`. The runtime adapter will see 2131 products. Storing 2130 creates a 1-product permanent drift the count-monitor will flag.

**COUNTER-CLAIM (medium strength)**: `expectedProductCount` should be **2131** to match what the runtime adapter actually sees (bare-origin path). R2's 2130 is internally consistent with its (incorrect) belief that the `/en/` prefix reaches the adapter. Couldn't disprove that R2's EN-vs-FR fact is wrong, but the runtime-relevant value is 2131.

### 4. productCountMethod = `{wp-rest-header, endpoint=/en/wp-json/..., header=x-wp-total}`

R2 correct on the discriminated-union shape (`product-count-probe.ts` requires the object form). R2 wrong on the endpoint string: per A above, runtime ignores the `/en/` prefix. Endpoint should be `/wp-json/wc/store/v1/products` for runtime honesty.

**Partial counter**: shape OK, endpoint string should drop `/en/` or be flagged as documentation-only.

### 5. catalogUrls — drop 5 marketing-aggregates, KEEP unclassified

Per B above: unclassified holds 14 returned items via Store API (x-wp-total=14), of which **13 are solo-categorized** and 1 is multi-cat. Dropping unclassified leaves 13 products uncrawled, not 14. CONCLUSION (keep unclassified) is correct.

**Verdict: COULDN'T DISPROVE.** Minor numeric correction (13, not 14).

Note: R2 narrative referred to cat ID 12277 for unclassified; that ID is actually `30-jours-de-bushnell`. The proposedValue array correctly lists the unclassified slug URL, so this is a narrative-only error.

### 6. crawlers.watermark.endpoint = `/en/wp-json/wp/v2/product`

Per A, the runtime adapter at `woocommerce.ts:340` will fetch `${origin}/wp-json/wp/v2/product`, ignoring the `/en/` prefix in siteProfile. The stored value misleads.

**Counter-claim (low strength, documentation-only)**: endpoint should be `/wp-json/wp/v2/product` to match runtime, OR the field needs to be acknowledged as decoration.

### 7. multilingual = `{plugin:wpml, crawlLanguage:en, defaultLanguage:fr, apiPrefix:/en/wp-json}`

Apex 302 -> /fr/ verified. WPML link-switcher anchors verified.

But: `apiPrefix=/en/wp-json` is decoration per A. If the field is consumed by future code that prepends apiPrefix to bare-host calls, IT WILL CHANGE BEHAVIOR (route the adapter to `/en/`). Today nothing reads it. If R2's intent is "tell the adapter to use /en/", a separate code change is required at `woocommerce.ts:340, 422, 530` — currently `apiPrefix` has no consumer.

**Verdict: COULDN'T DISPROVE the values**, but raise a flag: the field exists as data; the code consuming it does not yet.

### 8. wafProbeEvidence.rateLimit410After = null/drop

10-burst test: not re-executed (would burn the rate limit token unnecessarily). Accepting R2's evidence.

**Verdict: COULDN'T DISPROVE.**

---

## Prior R3 adversarial review

Prior R3 (2026-05-13) reviewed an earlier R2 batch (different correction set — 16 catalogUrls, expectedProductCount=2117, apiEndpoint=bare). Read for cross-batch contradictions:

| Field | Prior R2 (05-13) | Current R2 (05-15) | Prior R3 verdict | Current finding |
|---|---|---|---|---|
| /en/ prefix in apiEndpoint | drop (bare) | keep (/en/) | bare correct (origin reaches adapter) | bare correct — current R2 wrong on this point |
| expectedProductCount | 2117 | 2130 | 2117 confirmed at time | now 2131 bare / 2130 en / 2131 fr — natural drift; runtime sees 2131 |
| catalogUrls | 16 (incl. unclassified, accessoires parent etc.) | 12 (R1's 11 + unclassified) | 0 orphans against 16 | current R2's 12 also covers, but with different category structure; would need a fresh orphan walk to compare |
| perPage | 48 | 100 | flagged as "100 is tighter optimal" | 100 correct |
| wafType "consumer count" | "1 reader (validator)" | "1 reader (validator)" | "1 reader" | **WRONG in both — the Admin Profiles UI also reads it (5 references in page.tsx)** |

**Cross-batch contradictions found**:

1. **`/en/` prefix**: prior R3 verified by code-read that `URL.origin` returns protocol+host only, so the prefix CANNOT reach the adapter. Current R2 contradicts that by mandating `/en/` everywhere. Current R2 is wrong on this point. The runtime crawls the FR catalog regardless of what is stored.

2. **wafType consumer count**: BOTH prior R3 and current R2 claimed exactly one consumer. The frontend Admin Profiles UI is a second consumer surface. Neither auditor checked frontend/. Persona reminder: "grep BACKEND **and FRONTEND** when claiming consumer counts".

3. **Product count drift**: prior R3 saw 2117 (2026-05-13), current R2 sees 2130/2131 (2026-05-15). +13-14 in 2 days is high but plausible (new arrivals). Not a contradiction, but the count monitor needs slack at audit handoff.

---

## Summary

- **Corrections attempted to disprove**: 8
- **Successfully countered (full)**: 0
- **Successfully countered (partial)**: 3 (expectedProductCount 2131 vs 2130; productCountMethod endpoint string; wafType consumer count understated)
- **Survived intact**: 5
- **Numeric correction surfaced**: unclassified solo-count is 13, not 14

## Strongest counter-claims

1. **`/en/` prefix in siteProfile is decoration; runtime adapter fetches bare origin.** Per `woocommerce.ts:340, 422, 530` + caller `new URL(...).origin`. Storing `/en/wp-json/...` in `crawlers.bootstrap.apiEndpoints` misleads future auditors. R2's `expectedProductCount=2130` is internally consistent with the WRONG assumption that /en/ reaches runtime. The runtime-honest values: `expectedProductCount=2131`, endpoints stored as bare `/wp-json/...`.

2. **wafType IS read by the frontend Admin Profiles UI** (`page.tsx:13, 48, 356, 461, 496`). R2's "cosmetic for runtime" framing missed the operator-UX surface. Doesn't change the wafType=wordfence decision but invalidates the "single-consumer" justification.

3. **Unclassified solo-count is 13, not 14.** 14 total returned items; 1 multi-cat (`allen-sound-defender`). Dropping unclassified orphans 13 products. Conclusion (keep) unchanged.

## /en/ prefix runtime behavior — REQUIRED summary

Three live curls confirm the wire-level prefix matters (2131 / 2130 / 2131 different totals). Code at `woocommerce.ts:340, 422, 530` ignores the prefix because callers pass `origin` from `new URL(...).origin`, which by WHATWG spec contains no pathname. Therefore the runtime adapter always fetches `https://dantesports.com/wp-json/...` (the FR default, 2131 products) regardless of what siteProfile stores. The /en/ prefix exists in siteProfile as documentation only.

## unclassified 14-product walk — REQUIRED summary

`product_cat?slug=unclassified` -> id=2408 (count=15). Store API `category=2408&per_page=100` -> x-wp-total=14, 14 items returned. Slug-by-slug check of `categories[]`: 13 items have ONLY `unclassified`; 1 item (`allen-sound-defender-foldable-safety-earmuffs`) has `[other-an, specials-an, unclassified]`. Net orphan count if dropped: 13. R2's decision to KEEP unclassified is correct.

## Artifacts
- /tmp/dante_en.json, dante_fr.json — Store API per_page=1 across 3 prefixes
- /tmp/dante_pp48.json, dante_pp100.json, dante_pp150.json — perPage cap test
- /tmp/dante_2408.json — unclassified walk
- /tmp/dante_cat_unclassified.json — WP REST product_cat slug->id lookup
