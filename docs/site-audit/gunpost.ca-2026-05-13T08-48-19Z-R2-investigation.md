# R2 Investigation — gunpost.ca

**Run ID:** R2-blind-2026-05-13T08-48-19Z
**Candidate ref:** `docs/site-audit/gunpost.ca-2026-05-13T08-27-41Z-R1.json`
**Diff ref:** `docs/site-audit/gunpost.ca-2026-05-13T08-27-41Z-R1-diff.md`
**Method:** independent live probe (curl + Drupal Views walk) + runtime-code cross-reference. Did NOT re-run pre-bootstrap skill.

---

## Field-by-field investigation

### 1. `platform` — corrected to `"drupal-commerce"` (high)

R1 hypothesis path: SKILL.md most-specific multi-marker table.
R2 independent path: live HEAD probe headers.

```
[2026-05-13T08:43:44Z] HEAD https://www.gunpost.ca/ads?sort_by=date_pub&sort_order=DESC
  -> HTTP/1.1 200 OK
  -> X-Generator: Drupal 10 (https://www.drupal.org)
  -> X-Commerce-Core: 2
```

Both markers present in same response. `drupal-commerce` matches verbatim. Runtime usage check (Grep `siteProfile\.platform` in `backend/src`): 0 hits — field is purely informational. Either tag works at runtime; the specific one is correct per skill.

---

### 2. `expectedProductCount` — corrected to `30077` (high)

R1 hypothesis: 30,078 (1670 pages times 18 + page 1670 = 18 -> 30,078).
DB hypothesis: 30,423 (1690 times 18 + 3 last-page = 30,423).

R2 independent path: full pagination terminus walk + per-page item count.

Pager link from page 0 (top of catalog):
```
[2026-05-13T08:45:01Z] GET /ads?sort_by=date_pub&sort_order=DESC
  pager bottom HTML:
  <li class="pager__item pager__item--last">
    <a href="?sort_by=date_pub&sort_order=DESC&page=1670"
```

Per-page item counts (unique `data-history-node-id`):

| Page | Count | Has pager--next | Has pager--last |
|---|---|---|---|
| 0    | 18 | yes | yes (→1670) |
| 100  | 18 | — | — |
| 500  | 18 | — | — |
| 1000 | 18 | — | — |
| 1500 | 18 | — | — |
| 1668 | 18 | — | — |
| 1669 | 18 | — | — |
| **1670** | **17** | **NO** | **NO** |
| 1671 | 3 (none on page 0; differs per request) | no | no |
| 1690 | 3 (different IDs) | no | no |
| 1700 | 3 (different IDs) | no | no |
| 5000 | 3 (different IDs) | no | no |
| 100000 | 3 (different IDs) | no | no |

Page 1670's 17 unique IDs:
```
628101, 854084, 1054688, 1126755, 1138160, 1178524, 1178527, 1178531, 1178532,
1178533, 1178547, 1178566, 1178570, 1178572, 1178576, 1178579, 1226767
```

Page 1671's 3 IDs (`1153549`, `1195317`, `1217649`) — NOT on page 0 nor on page 1670. These are sticky/recommended "filler" Drupal Views shows on out-of-range pages.

Truth: real terminus is page 1670 with 17 items. Total = (1670 mid-pages × 18) + 17 = **30,077**.

R1 wrong by 1 (overcounted last page); DB wrong by 346 (extrapolated past the real terminus).

---

### 3. `productCountMethod` — corrected to candidate's `html-pagination` shape (high)

R1 hypothesis: DB's `"pagination-walk"` not in runtime switch.
R2 independent path: read `backend/src/services/product-count-probe.ts` switch cases.

Confirmed canonical 11-arm union (file lines 87–98):
1. `wp-rest-header`, 2. `json-api-count`, 3. `json-api-length`, 4. `html-pagination`,
5. `sitemap`, 6. `sitemap-index`, 7. `generic-product-sitemap`, 8. `ecwid-storefront-search`,
9. `shopify-products-walk`, 10. `klevu-api-count`, 11. `stream-page-count`.

`pagination-walk` is NOT in the union. Switch `default` at lines 446-451:
```ts
default: {
  const unknownMethod = (m as any)?.method;
  console.warn(`[productCountProbe] unknown method '${unknownMethod}' -- returning null`);
  return null;
}
```

DB silently returns null at runtime — coverage probe always falls back to stored `expectedProductCount` (which is also wrong).

Candidate's `html-pagination` shape is correct. Note: the pager selector extracts `page=1670` -> formula yields 1670 × 18 = 30,060 (under-counts last 17 by 0.06%). 30060/30077 = 99.94% — passes the 95% coverage threshold (`COVERAGE_THRESHOLD = 0.95` line 100).

---

### 4. `searchUrl` — corrected to `/ads?key={keyword}` (high)

Candidate gap; DB has it. R2 verified live + via adapter.

```
[2026-05-13T08:45:19Z] GET https://www.gunpost.ca/ads?key=glock
  -> HTTP 200, 148624 bytes, 15 data-history-node-id results
  -> <title>Classified Ads | GUNPOST</title>
```

Adapter source `backend/src/services/scraper/adapters/classifieds-gunpost.ts:82-84`:
```ts
getSearchUrl(origin: string, keyword: string): string {
  return `${origin}/ads?key=${encodeURIComponent(keyword)}`;
}
```

Adapter and DB agree on the pattern. Candidate's omission is a real gap (SKILL.md Stage 3 conditional was missed).

---

### 5. `classifiedRules.soldDetection` — corrected to 5-entry union (high)

R1 hypothesis: DB has wider/better coverage; candidate is incomplete.
R2 independent path: live detail page + adapter source.

Live detail page (in-stock listing):
```
[2026-05-13T08:46:39Z] GET /blades/knives-tools/owen-sound/nazi-dress-daggers-last-4-blow-out
  -> <div class="field-sold No">
       <div class="sold No">SOLD</div>
     </div>
```

Pattern is paired: `field-sold` (outer) + `sold` (inner SOLD badge), with `No` / `Yes` qualifier. The SOLD text is always present; visibility is gated by the qualifier (likely CSS-hidden when No).

Adapter source `classifieds-gunpost.ts:155-157`:
```ts
const elClass = element.attr('class') || '';
const isSold = /\bsold\b/i.test(elClass)
  || /SOLD/.test(element.find('.field-sold').text())
  || element.find('.sold, .ad-sold, [class*="sold"]').length > 0;
```

Adapter checks `.sold` AND `.ad-sold` selectors via `.find()`. DB list `["class=sold", "class=ad-sold", "field-sold Yes", "SOLD"]` covers these; candidate's narrower `["class=field-sold", "field-sold Yes", "SOLD"]` misses the actual `.sold` / `.ad-sold` selectors.

Recommended union: `["class=sold", "class=ad-sold", "class=field-sold", "field-sold Yes", "SOLD"]`.

---

### 6. `classifiedRules.wantedDetection` — corrected to DB list (medium)

Adapter `classifieds-gunpost.ts:33-52` hardcodes the patterns:
```ts
if (/^(wanted|wtb|wtt|iso)\b/i.test(title.trim())) return true;
if (/\b(wanted|wtb|wtt|iso)\s*$/i.test(title.trim())) return true;
if (/\bwanted\s*:/i.test(title)) return true;
```

DB stores them redundantly. SKILL.md silent on this for classifieds. Runtime does NOT read from siteProfile for wanted detection (adapter is self-contained). Keep DB value as operator-readable documentation; no runtime effect either way.

---

### 7. `userAgentOverride` — corrected to OMIT (high)

R1 hypothesis: defensive set per SKILL.md Stage 2 (cloudflare-active -> iPhone UA).
R2 independent path: live test default Chrome UA on real catalog URL.

```
[2026-05-13T08:48:18Z] GET /ads?sort_by=date_pub&sort_order=DESC
  UA: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/131.0.0.0 ...
  -> HTTP 200, 561288 bytes, 18 items

[2026-05-13T08:48:18Z] GET /ads?sort_by=date_pub&sort_order=DESC&page=100
  UA: same Chrome
  -> HTTP 200, 18 items
```

The iPhone UA override does NOT bypass bare /ads (still 403 with iPhone UA); the runtime crawler does not hit bare /ads (catalogUrls always include sort param). Override is wasted bytes. DB's omission is correct.

---

## Sticky-overflow finding (BOTH R1 hypothesis AND DB wrong; third truth)

The most important R2 finding: the catalog terminus is page 1670 with 17 items, total **30,077** — not 30,078 (R1) and not 30,423 (DB).

DB's 30,423 was built on the assumption that pages 1671..1690 contained real catalog items (extrapolating 1690 × 18 + 3 = 30,423). But every page beyond 1670 returns 3 differing sticky/featured/random items with no pagination — they are NOT part of the indexed listing set. DB was extrapolating into noise.

R1's 30,078 was close (off-by-1 on last-page item count) but the methodology was correct.

Implication for the runtime probe: the `html-pagination` method extracts `page=1670` from the pager and multiplies by perPage=18 -> 30,060. That's under-count by 17 (0.06%) but well within the 95% coverage gate. Acceptable.

---

## Bare /ads challenge confirmed (sanity check)

```
[2026-05-13T08:46:24Z] GET https://www.gunpost.ca/ads
  UA: iPhone Safari
  -> HTTP 403, 5610 bytes
  -> "Just a moment" + cf_chl_opt -> Cloudflare interactive challenge
```

Confirms WAF active rule-selective. Neither iPhone UA nor Chrome UA bypasses bare `/ads`. Runtime crawler must always include `?sort_by=` to avoid the challenge — already baked into `catalogUrls: ["/ads?sort_by=date_pub&sort_order=DESC"]`.

---

## Inconclusive: none

All eight divergences I investigated reached a confident verdict (6 high, 2 medium).

---

## Summary table

| Field | R1 said | DB said | R2 verdict | Confidence |
|---|---|---|---|---|
| platform | drupal-commerce | drupal | **drupal-commerce** | high |
| expectedProductCount | 30,078 | 30,423 | **30,077** (third truth) | high |
| productCountMethod | html-pagination spec | pagination-walk (runtime null) | **R1 (html-pagination)** | high |
| searchUrl | omitted | /ads?key={kw} | **/ads?key={kw}** (DB right) | high |
| soldDetection | 3-entry list | 4-entry list | **5-entry union** (third truth) | high |
| wantedDetection | omitted | 6-entry list | **6-entry list** (DB right, redundant but harmless) | medium |
| userAgentOverride | iPhone UA | (omitted) | **omit** (DB right) | high |
| wafLastProbedAt / wafProbeEvidence / wafProbeResult / wafWorkaround | structured/fresh | string/stale | mixed — keep candidate fresh shape for first 3, keep DB wafWorkaround steps | high |

Total live HTTP probes: ~25 over ~6 minutes, all with >=800ms inter-request delay.
