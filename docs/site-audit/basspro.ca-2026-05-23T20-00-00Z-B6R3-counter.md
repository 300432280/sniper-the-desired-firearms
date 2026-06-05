# basspro.ca B6R3 — Adversarial Counter to R2

Round: **R3 ADVERSARIAL** (persona: engineering-code-reviewer). Mission: disprove R2's verdicts via 3× sample broadening, harness-block tagging, post-merge re-test. ~20 min budget.

Audit IP: same cloud IP as R2 (audit-environment-cloud-ip). Probe scratch under `_audit_tmp/batch6-2026-05-23/r3/`.

## Counts

- counter: **1** (R2 wrong, fix needed)
- couldn't-disprove: **3** (R2 verdict reinforced)
- untested-by-harness: **2** (Akamai blocked probe — verdict noted for R4)

---

## Top 3

### 1. COUNTER — `expectedProductCount` 16526 is WRONG; correct value is **16543** (matches R1, NOT R2)

R2's `evidence` said "Grep '<loc>https?://[^<]*?/p/[a-z0-9-]+' = 16526 matches (R1 reported 16543, 17-item drift consistent with normal catalog turnover over ~2 days)."

That's a verification-method bug, not catalog drift.

- R3 re-fetched `https://www.basspro.ca/webapp/wcs/stores/servlet/sitemap_10151.xml.gz` (200, 289,406 B gzip; ungzipped 2,223,023 B).
- R3 ran R2's case-sensitive regex → **16,526** (reproduced).
- R3 ran case-insensitive `/p/` count (the runtime equivalent) → **16,543**.
- The 17 "missing" URLs are products whose slug contains uppercase letters: `TenPoint-…`, `Mossberg-500-Pump-…`, `IceArmor-by-Clam-…`, `River2Sea-…`, `Cobra-5-…`, `Nite-Ize-…`, `Star-brite-…`, `Wild-republic-…`, etc. (17 enumerated, full list in scratch).
- **Runtime code path** at [`product-count-probe.ts:323`](../../backend/src/services/product-count-probe.ts) builds the regex with `new RegExp(patternSrc, 'i')` — case-insensitive flag is hardcoded. R1's pattern `/p/[a-z0-9-]+` therefore matches **16,543** at runtime, not 16,526. **R2's grep dropped the `-i` flag and silently mismatched runtime behavior.**

R4 action: set `expectedProductCount: 16543`. Do NOT adopt R2's 16,526.

### 2. COULDN'T DISPROVE — `searchUrl` B3 differential confirmed across 6 keyword/junk pairs (R2 verdict reinforced)

R3 fired 6 fresh probes against `/webapp/wcs/stores/servlet/SearchDisplay?storeId=10151&catalogId=10052&langId=-1&searchTerm={kw}` (800ms delays, Safari 17 macOS UA):

| keyword | bytes | totalSearchCount |
|---|---|---|
| tent | 174,968 | **365** |
| ammunition | 151,823 | **1134** |
| qqzzznomatch | 49,260 | **0** |
| remington | 134,866 | **351** |
| pez-dispenser-fake | 49,266 | **0** |
| scope | 138,222 | **558** |

Real terms (4/4) returned 351–1134 results with 134–175 KB bodies. Junk terms (2/2) returned 0 results with ~49 KB bodies. Differential is dramatic and consistent across firearm + non-firearm vocab + nonsense inputs. R1/R2 verdict stands; `searchUrl` is a real differentiating endpoint and survives 3× B3 broadening.

### 3. COULDN'T DISPROVE — sitemap fetch + gzip handling stable

- Sitemap returned 200 / 289,406 B gzip (vs R2's 289,311 B — 95-byte delta = sub-percent timestamp/metadata diff, not catalog change).
- `gunzip` produces 2,223,023 B (matches R2 byte-for-byte on size).
- Total `<loc>` entries: 17,609 (includes `/l/`, `/c/`, `/b/`, `/p/`). `/p/` subset = 16,543 (see Finding 1).
- `productCountMethod: generic-product-sitemap` is reproducible and stable. The `.xml.gz` Content-Type is handled transparently by axios at runtime (default decompress); no special handling needed.

---

## untested-by-harness (NOT "couldn't disprove")

### A. `wcParamJs.storeId=10151` stability across UAs + time-of-day — UNTESTED-BY-HARNESS

- First R3 burst (3 UAs sequential, 800ms delays — Chrome 120, Safari 17 macOS, iPhone Safari 17): **all 3 returned HTTP 403 / 370 B Akamai access-denied body**. Akamai per-session quota tripped after the upstream B3 burst.
- 30s cooldown + single Safari retry → 200 / 57,725 B, `wcParamJs` block present with `"storeId":"10151"`, `"catalogId":"10052"`, `"langId":"-10"`. Confirms R1's values from one sample only.
- **UA matrix + time-of-day spread (R3 priority 2) IS UNTESTED.** Akamai's per-session 403 prevents the 3× sample-broadening rule from running. Operator should re-probe from production crawler IP across the production UA pool over ≥60 s sustained walk before declaring storeId stable.
- R4 should mark in `auditNotes.storeIdStability: "untested-by-harness (akamai-403-on-ua-rotation)"`.

### B. perPage / paginationPattern / sortParam — UNTESTED-BY-HARNESS (carries from R2)

R2 already flagged. Same Akamai page-2 wall persists in R3. No new evidence. Carry verdict forward.

---

## Post-merge re-test (Calibration rule 3)

Most recent merged fix per `git log --oneline -5 origin/main`: **`ee63f12 fix(runtime): five batch-3 R4 verdict bugs + unit tests`** (merged via `6851ac7`).

That fix touched `product-count-probe.ts` — the same file this R3 cites as ground truth in Finding 1. The fix's `validateMethod` at [L138-196](../../backend/src/services/product-count-probe.ts) accepts both `generic-product-sitemap` and `stream-page-count`. R1's chosen method is in the allowlist. **Verified post-merge: `productCountMethod: generic-product-sitemap` does NOT throw at runtime.**

The Finding 1 bug is independent of the merged fix — it's a regex-flag mismatch in R2's verification grep, not in the production code path. Production behavior is correct (16,543); R2's audit-time grep was wrong.

---

## R4 action items

1. **Set `expectedProductCount: 16543`**, NOT 16526. Cite the case-insensitive regex flag at `product-count-probe.ts:323`.
2. Keep R1/R2 verdicts: platform = `ibm-websphere-commerce`, wafType = `akamai`, searchUrl = R1's WebSphere SearchDisplay path, needsPlaywright = true, productUrlSchemes per R1.
3. Mark `storeId-stability` and `perPage/pagination/sort` explicitly as `untested-by-harness` in `auditNotes`, NOT as "verified" or "couldn't disprove" — operator must re-probe from production IP.
4. Preserve R2's catalogUrls merge recommendation (R1's 3 `/c/*` as catalogUrls + 18 firearm-relevant `/l/*` leaves in `topLevelCategories.categories`). R3 has no new evidence to contradict this.

## Files produced

- This file
- Probe scratch: `_audit_tmp/batch6-2026-05-23/r3/{tent,ammo,qqzzz,rem,pez,scope}.html`, `home2.html`, `sitemap.xml(.gz)`
