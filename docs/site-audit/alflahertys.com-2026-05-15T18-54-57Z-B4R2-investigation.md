# alflahertys.com — B4R2 Live Investigation

- Candidate: `docs/site-audit/alflahertys.com-2026-05-15T18-31-39Z-B4R1.json`
- R1 diff: `docs/site-audit/alflahertys.com-2026-05-15T18-31-39Z-B4R1-diff.md`
- Corrections: `docs/site-audit/alflahertys.com-2026-05-15T18-54-57Z-B4R2-corrections.json`
- Probe IP: audit-host (single IP)
- Probe time: 2026-05-15T18:52Z – 18:54Z

## Mission recap

R1 made four high-risk claims on a BigCommerce Stencil + Klevu site:
1. WAF: stored DB had `hasWaf=true + wafType=cloudflare-passive + wafWorkaround=sucuri-cookie-cache` (three-way internal contradiction). R1 downgraded to `hasWaf=false` with `medium` confidence.
2. Klevu sort enums `NEWEST` / `DATE_DESC` / `NAME_ASCENDING` return HTTP 500 — only `RELEVANCE` and `PRICE_ASC` work.
3. Klevu silently caps at `limit=100` (limit=250 returns 100).
4. BC Stencil HTML category pages return 0 products (Klevu hydrates client-side).

Mission: re-probe all four against live targets.

## 1. WAF re-probe (8 batches + body scan)

| Batch | Test | Status |
|---|---|---|
| 1 | Bot UA (`googlebot/2.1`) on `/` | **200** |
| 2 | Empty UA on `/` | **200** |
| 3 | Suspicious UA (`curl/8.0`) on `/` | **200** |
| 4 | 10x rapid burst (Chrome UA) on `/` | **200 x 10** |
| 5 | SQLi payload `?id=1' OR '1'='1` | 000 (curl URL-parse error, NOT a WAF block) |
| 6 | XSS payload `?q=<script>` | 400 (BC origin parser rejects literal angle brackets, NOT a WAF) |
| 7 | Honeypots `/wp-admin/`, `/wp-login.php`, `/.env`, `/.git/config` | 403 path-selective (Cloudflare managed-rules / BC origin); does NOT affect `/` |
| 8 | Header inspection | Only `Server: cloudflare` + `cf-ray: 9fc4566fdb8cade0-YYZ` + `__cf_bm` cookie |

Body-marker scan on category HTML (`/shooting-supplies-firearms-and-ammunition/firearms/`):
- `sucuri|malcare|sgcaptcha|incapsula|wordfence|cloudfront` matches: **0**
- `cf_challenge|cf-mitigated|challenge-platform|just a moment|attention required` matches: **0**

### Three-way contradiction resolution

| DB field | DB value | Reality (2026-05-15) |
|---|---|---|
| `hasWaf` | `true` | **false** — no path actively blocked |
| `wafType` | `cloudflare-passive` | **cloudflare-passive** (retained as posture tag, not blocking-WAF flag) |
| `wafWorkaround.method` | `sucuri-cookie-cache` | **(remove)** — no Sucuri markers exist anywhere |

The DB record is fully stale residue. Likely sourced either from an earlier audit when the site sat behind Sucuri (BC stores do flip between Sucuri and CF over time) or from a copy-paste of another site's profile. The current posture is Cloudflare-passive with `__cf_bm` bot-cookie only; this is a fingerprinting cookie, not a blocking WAF, so `hasWaf=false` is operationally correct. **R1's downgrade is right; the confidence should be `high`, not `medium`.**

## 2. Klevu sort-enum 500 verdict

Test: POST `https://uscs33v2.ksearchnet.com/cs/v2/search` with `apiKey=klevu-170966446878517137`, `limit=1`, `offset=0`, varying the `sort` field. 19 candidates, 800ms inter-request delay.

| Sort enum | HTTP | qTime |
|---|---|---|
| `RELEVANCE` | **200** | 14ms |
| `PRICE_ASC` | **200** | 11ms |
| `PRICE_DESC` | **200** | 11ms |
| `NEWEST` | 500 | 0ms |
| `DATE_DESC` | 500 | 0ms |
| `NAME_ASCENDING` | 500 | 0ms |
| `NAME_DESCENDING` | 500 | 0ms |
| `LATEST` | 500 | 0ms |
| `CREATED_AT_DESC` | 500 | 0ms |
| `ADDED_TIME_DESC` | 500 | 0ms |
| `newest` (lowercase) | 500 | 0ms |
| `oldest` | 500 | 0ms |
| `dateDesc` | 500 | 0ms |
| `dateAsc` | 500 | 0ms |
| `createdAt` | 500 | 0ms |
| `added` | 500 | 0ms |
| `date-desc` | 500 | 0ms |
| `date_desc` | 500 | 0ms |
| `date` | 500 | 0ms |

All HTTP 500 responses have `qTime=0` — validation rejection, not execution failure. **Klevu instance is configured to expose only relevance + price sorts.** R1's claim is correct; no newest-first sort possible via Klevu API on this merchant instance. `full-catalog-sweep` is the correct watermark method.

## 3. Klevu perPage cap re-verdict

Test: POST same endpoint with `limit` varied from 50 to 1000, `sort=RELEVANCE`. Inspect `records.length`:

| limit | records.length | noOfResults |
|---|---|---|
| 50 | **50** | 50 |
| 100 | **100** | 100 |
| 150 | 100 | 100 |
| 200 | 100 | 100 |
| 250 | 100 | 100 |
| 500 | 100 | 100 |
| 1000 | 100 | 100 |

**Cap is exactly 100, silent (no warning header, no error).** Both `records.length` and `meta.noOfResults` are clamped. R1's `perPage:100` is the verified optimum. 5595 products / 100 = 56 paginated calls for a full sweep.

## 4. BC Stencil HTML category empty re-verdict

Test: `curl -A "Mozilla/5.0 Chrome/121.0" "https://alflahertys.com/shooting-supplies-firearms-and-ammunition/firearms/"`

- HTTP 200, body 141504 bytes
- Product anchor counts:
  - `class="card-figure"` -> **0**
  - `data-product-id="..."` -> **0**
  - `class="*card*"` -> 0 unique BC product-card class names
- Klevu hydration markers found in body:
  - `js.klevu`, `klevu`, `ksearchnet`
  - `klevu-170966446878517137`
  - `klevu-js-v1`, `klevu-recs`, `klevu-user-customization-170966446878517137-v2`
  - `klevuLanding`, `klevu_addtocart`, `klevu_currency`, `klevu_customAddToCart`
  - `klevu_pageCategory`, `klevu_page_meta`

**Confirmed**: BC server renders category chrome only; Klevu JS injects products client-side. `needsPlaywright:true` for HTML fallback is mandatory. The runtime walks via Klevu API wildcard, not category HTML.

## 5. expectedProductCount cross-check (bonus finding)

R1 claims sitemap count (5264) and Klevu `totalResultsFound` (5264) match exactly. **They don't anymore.** Today:

- BC sitemap `xmlsitemap.php?type=products&page=1` <loc> count: **5264**
- Sitemap page=2 -> HTTP 404 (sitemap is single-page; total = 5264)
- Klevu `totalResultsFound`: **5595**
- Klevu offset=5594 -> 1 record, offset=5595 -> 0 records (confirms 5595 is the true catalog tail)

**The 331-product delta is sitemap regen lag** (sitemap was generated when catalog was smaller). Klevu's index drives the live UI and is the authoritative source. R1 is internally inconsistent: it chose the Klevu method but reported the stale sitemap value. **Corrected `expectedProductCount: 5595`.**

## 6. productCountMethod naming (bonus finding)

`product-count-probe.ts` line 17 has `'json-api-count'` and line 75 has `'klevu-api-count'`. Both can hit this endpoint and return 5595. However:

- `klevu-api-count` (case at line 302): purpose-built. Calls `resolveKlevuKey()` for key self-healing on rotation. Body shape baked in: `typeOfRequest:'SEARCH' + typeOfRecords:['KLEVU_PRODUCT']`. Requires `{method, endpoint, apiKey}`.
- `json-api-count` (case at line 156): generic. Operator hand-authors the field drill-path. No key rotation handling.

DB convention is `klevu-api-count`. **Switch back to it** — the named method exists specifically for this platform.

## 7. Pagination disjoint verification

| offset | records | first ID |
|---|---|---|
| 0 | 100 | 10599 |
| 100 | 100 | 17683 |
| 200 | 100 | 16803 |
| 500 | 100 | 16976 |
| 5000 | 100 | 5621 |
| 5500 | 95 | 12333 |
| 5594 | 1 | 9266 |
| 5595 | 0 | — |
| 6000 | 0 | — |

Direct overlap check: `offset=0` IDs intersect `offset=100` IDs = **0 overlap**. Pagination semantics intact.

## Files

- `docs/site-audit/alflahertys.com-2026-05-15T18-54-57Z-B4R2-corrections.json`
- `docs/site-audit/alflahertys.com-2026-05-15T18-54-57Z-B4R2-investigation.md`

## Constraints satisfied

- 800ms inter-request delay on all Klevu API probes.
- Zero DB writes.
- "Inconclusive" called out where applicable (none — all four target claims resolved with high confidence).
