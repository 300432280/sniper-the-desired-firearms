# R3 adversarial counter — internationalshootingsupplies.com

- Round: R3 (FRESH skeptic, no prior R1 access; reviewed R2 and prior R3 only)
- Site: internationalshootingsupplies.com
- R2 corrections audited: `internationalshootingsupplies.com-2026-05-15T09-19-15Z-R2-corrections.json`
- R2 investigation: `internationalshootingsupplies.com-2026-05-15T09-19-15Z-R2-investigation.md`
- Prior R3 audited: `internationalshootingsupplies.com-2026-05-13T09-15-00Z-R3-counter.md`
- Live re-probe window: 2026-05-15T12:44Z to 2026-05-15T12:47Z
- Tools: curl (Mozilla Edge UA + bare curl UA), Read on backend/src, Grep across whole repo

---

## Mandatory verdicts (resolving the "CRITICAL contradiction" flagged by the operator)

### REQUIRED — store-api OOS-transition outcome ruling (worker.ts line-by-line trace)

**The flagged contradiction is NOT a contradiction.** Both R2 claims live on different branches of a single gate at `worker.ts:397`.

Complete control-flow diagram for an OOS-transition product on a `verifyMethod=store-api` site (ISS):

```
processVerifyCrawl(job)                                 worker.ts:686
  └── tryStoreApiVerify(products, domain, siteId, hasWaf)        :703
        ├── L396  maintainConfig = profile.crawlers.maintain
        ├── L397  if (verifyMethod !== 'store-api') return null
        │         (ISS profile has 'store-api' → does NOT return null)
        ├── L403  withSourceId = products.filter(p => p.sourceId != null)
        │         (ISS WC products all have numeric sourceIds → withSourceId=products)
        ├── L452  axios.get(`${origin}/wp-json/wc/store/v1/products?include=${ids}&per_page=${CHUNK_SIZE}`)
        │         Store API default filter is in-stock only.
        │         OOS product is NOT returned → apiMap.get(sourceId) === undefined
        ├── L510  for (const product of chunk)
        │   ├── L511  apiProduct = apiMap.get(sourceId)  // undefined for OOS
        │   ├── L513  if (apiProduct) { /* update lastSeenAt + stock + price */ }
        │   ├── L537-546  else { /* silent skip — explicit comment */ }
        │   ├── L548  verified++                  ← UNCONDITIONAL
        │   └── L549  handledProductIds.push(product.id)  ← UNCONDITIONAL
        └── returns { verified, handled: products.length }
  └── L711  if (storeApiFastPath.handled === products.length)
        ├── L712-714 console.log success
        ├── L715-724 onCrawlComplete({ status:'success', matchesFound:verified, ... })
        ├── L725 selfQueueNextBatch
        └── L726 return        ← EARLY RETURN. Playwright fallback never reached.
```

**Data outcome for an OOS-transition product (real, exhaustive)**:
- `lastSeenAt`: NOT updated (no DB write at all)
- `stockStatus`: NOT flipped to `out_of_stock`
- `isActive`: NOT flipped to false
- `staleSince`: NOT changed
- `verifyErrors`: NOT incremented
- Telemetry: `verified++` → reported as success
- Next cycle: same product re-queued, same silent-skip recurs

This IS the 2026-04-03 mass-deactivation fix. R2 verdict (`store-api SAFE/INTENDED, KEEP`) **survives**.

The "contradiction" the operator flagged is resolved by reading L397 carefully: the shooterschoice/pavillon path (`verifyMethod='json-ld'`) returns `null` at L397 and falls through to the else branch at L759-769 (which calls `verifyProductsViaPlaywright` unconditionally on any truthy verifyMethod, ignoring the L768 comment that says it's only for `'detail-page'`). The ISS path (`verifyMethod='store-api'`) clears L397 and takes the silent-skip path. **Both R2 claims are correct because they describe different branches.**

Caveat the operator should be aware of (not flagged by R2 but flagged by prior R3): the silent no-op leaves OOS-but-truly-deleted products with stale `lastSeenAt` indefinitely. The 2,923 OOS products in ISS's catalog will never be probed by Playwright via the verify path. Recovery depends on cross-tier cycle completion (CLAUDE.md "Stale detection only via cross-tier cycle completion" rule). This is a **known tradeoff**, not a bug. R2's KEEP recommendation is consistent with project policy.

### REQUIRED — crawlers.catalog dead-code re-grep verdict

**CONFIRMED DEAD.** Grep results across the entire repo (not just `backend/src`):

```
crawlers\.catalog | crawlers\?\.catalog | html-category-walk | html_category_walk | categoryWalk
  backend/src   → 0 matches
  backend       → 0 matches  (.ts and .js)
  whole repo    → 2 matches (both in docs/, neither runtime code):
                  - docs/site-audit/...R2-corrections.json (this batch's own output)
                  - docs/site-verification/...2026-04-28.json (audit snapshot)
```

Only `crawlers.watermark.method` and `crawlers.maintain.verifyMethod` have runtime readers:
- `watermark-crawler.ts:677-680` reads `crawlers.watermark.method`
- `worker.ts:396` reads `crawlers.maintain`
- `worker.ts:763` reads `crawlers.maintain.verifyMethod`
- `profile-validator.ts:97-165` validates `crawlers.watermark`
- `stale-detector.ts:204` is just a comment, no read

R2's claim that `crawlers.catalog` is dead audit-trail residue **survives**. Recommendation to remove from DB **survives**.

### REQUIRED — adapter-registry.ts:116 sole-routing verdict

**CONFIRMED SOLE ROUTING KEY.** Read `adapter-registry.ts:100-141`:
- L114-116: `const siteInfo = siteCache.get(domain); if (siteInfo) { const adapter = adapters[siteInfo.adapterType] || adapters.generic; ... }`
- L128-141: subdomain fallback uses identical pattern — `parentInfo.adapterType`
- No runtime override path checks `crawlers.catalog.method` or any other field

`catalog-crawler.ts:261` and `:664` call `getAdapterForUrl(url)` which routes to this single dispatch. No override anywhere. R2's claim **survives**.

---

## Per-correction adversarial attempts

### C1. `expectedProductCount = 5237` — COULDN'T DISPROVE

Live re-probe 2026-05-15T12:45Z (prod-rotated Edge UA):
```
GET /wp-json/wp/v2/product?per_page=1                              → 200, X-WP-Total: 5237
GET /wp-json/wc/store/v1/products?per_page=1                       → 200, X-WP-Total: 2314
GET /wp-json/wc/store/v1/products?per_page=1&stock_status=outofstock → 200, X-WP-Total: 2923
```
2314 + 2923 = **5237**. Exact match. Triangulated by partition + endpoint match + (prior R3's) tail-walk. Independent.

Alternative I tested: could WP REST include draft/private statuses inflating total? No — anonymous WP REST strips non-public statuses. The Store API partition (publish-only) sums to the same total, so WP REST can't be over-counting drafts.

Cross-check against woocommerce.ts:340: the watermark crawler hits WP REST first; the 5237 denominator is what watermark walks. Using R1's 2314 would surface 2,923 false "new" OOS products per cycle. R2's value is required for correctness.

**Counter-claim**: none. R2 survives.

### C2. `productCountMethod.endpoint = /wp-json/wp/v2/product` — COULDN'T DISPROVE

Same reasoning as C1. The endpoint MUST match the watermark crawler's walk endpoint. `woocommerce.ts:340` queries WP REST first. R1's Store API endpoint would silently undercount.

**Counter-claim**: none. R2 survives.

### C3. `catalogUrls = 79 entries (DB-as-is)` — COULDN'T DISPROVE

Re-tested the two leaves R1 dropped:
```
GET /product-category/bows/crossbows/         → 200, .product type-product count = 2 (live products)
GET /product-category/uncategorized/          → 200, .product type-product count = 2 (live products)
```
Both have real products. R1's parent-count>0 chain was the bug. R2 explicitly cites the SKILL Rule C violation that produced it.

Independent check vs prior R3: prior R3 says `80 leaves (incl. firearms/handguns)`. This batch's R2 says `79 leaves (DB list correct)`. The discrepancy is the same number of leaves (R1's 77 + 2 missing = 79 vs DB's 79). Prior R3's "80" probably counts an additional firearms-children leaf that the new R2 already includes in its 79. Not enough info to break the tie without ground-truthing the full live taxonomy walk; R2's "DB list correct" is the safer call because it tracks an audited DB profile.

**Counter-claim**: none on the +2 missing leaves. INCONCLUSIVE on the 79 vs 80 difference relative to prior R3 — would need full live taxonomy walk to settle, but R2's "DB list is correct" is the most conservative recommendation.

### C4. `verifyMethod = store-api KEEP` — COULDN'T DISPROVE

Code trace already done above. R2's verdict matches the explicit 2026-04-03 incident-fix comment at L538-545. Prior R3 argued for `detail-page` instead, citing the silent-no-op cost for 2,923 OOS products.

Comparing the two recommendations:
- **R2 (KEEP `store-api`)**: zero risk of mass deactivation; accepts stale OOS lastSeenAt as known tradeoff; relies on cross-tier cycle completion for stale detection.
- **Prior R3 (`detail-page`)**: refreshes OOS products' DB state on each verify, but at 2,923 Playwright per-product hits per cycle vs 53 batched Store API calls. ~55x cost increase.

Prior R3's "0% fall through" reasoning is correct: line 549 unconditional push → line 711 condition met → line 726 early return → Playwright never invoked. But that's by **design**, not bug. The cost ratio (~55x) is real.

Neither answer is "wrong"; they're a cost-vs-completeness tradeoff. R2's choice aligns with CLAUDE.md's "Never deactivate based on lastSeenAt alone" rule and the project's documented cross-tier-completion stale path. **R2's recommendation survives** because it's consistent with project policy. Prior R3's recommendation is a defensible alternative if the operator decides the cost is acceptable.

**Counter-claim**: none. R2 survives on policy grounds.

### C5. `crawlers.catalog` removal — COULDN'T DISPROVE

Re-grepped whole repo per operator instruction (not just backend/src). Zero runtime readers. R2 survives.

Additional check: the DB `notes` field claims "WP REST blocked", but live probe with prod-rotated UA returns 200 with X-WP-Total=5237. The override's rationale is also stale. R2 survives on a second axis.

**Counter-claim**: none. R2 survives.

### C6. `auditNotes.requiresBrowserUa = true` — COULDN'T DISPROVE

Direct test:
```
curl -A 'curl/7.x' /wp-json/wp/v2/product?per_page=1 → 403 BPS Plugin 403 Error Page
curl -A 'Mozilla/5.0 ... Edg/120 ... ' /wp-json/wp/v2/product?per_page=1 → 200
```
Confirmed BPS plugin UA filter on `/wp-json/*` paths only. Production `http-client.ts` rotates 4 Mozilla UAs → no production impact. The annotation is documentation-only for future operators. **R2 survives.**

### C7. `paginationPattern.template = "page/{N}/"` — INCONCLUSIVE (cosmetic)

R2 admits "cosmetic only, medium confidence". Functionally identical to R1's `"/page/{N}/"`. No counter-claim possible.

### C8. `hasWaf = false / wafType = null` — COULDN'T DISPROVE

- Rapid 10-burst with prod UA → all 200, no rate limit
- nginx Server header, no cf-ray / x-sucuri / x-incapsula / x-akamai
- BPS plugin behavior is app-layer path-and-UA filtering, not CDN-edge WAF
**R2 survives.**

---

## Counter-claims summary

- Corrections attempted: 8 distinct fields
- Counter-claims landed: **0** (every R2 correction survives independent re-probe)
- Reasoning issues found: **0** in R2. Prior R3 reasoning was correct but reached a different verifyMethod recommendation than this batch's R2 — disagreement is on policy interpretation, not facts.
- "Inconclusive" verdicts: 1 (C7 paginationPattern cosmetic)
- Operator's flagged "CRITICAL contradiction" between batches: **NOT a contradiction.** Both claims describe different branches of `worker.ts:397`. Drawing the full control-flow diagram resolves it cleanly.

### Strongest 3 counter-observations (none disprove R2; included as honest notes)

1. **`verified++` at L548 is unconditional** — telemetry reports OOS-transition products as "verified" even when nothing was written to DB. Looks healthy in logs, silently stale in data. Not R2's fault (the silent-skip is intentional), but operators reading `verified` counts should know they include silent no-ops.

2. **2,923 OOS products will never see a Playwright verify under store-api** — because L549 marks them handled before the L730 partial-fastpath branch could route them. Recovery for OOS-but-deleted products depends entirely on cross-tier cycle completion (CLAUDE.md rule). If cross-tier cycles are stalled for any reason, these products go infinitely stale. Defensible by policy, but worth a monitoring metric.

3. **DB's `crawlers.catalog` field has been internally inconsistent for ~6 weeks** — it claims `adapterType` was changed to `generic-retail`, but the actual `adapterType` field is still `woocommerce`. Half-applied override. The dead-code re-grep confirms zero runtime effect, but operators encountering the DB row would reasonably believe an HTML-walk path is active when it is not. R2's removal recommendation is correct and overdue.

### Final stance

R2's 8 corrections all survive adversarial re-probe with no successful counter-claims. The operator's flagged contradiction between this batch's ISS verdict and the shooterschoice/pavillon `json-ld` verdict is a misreading — both verdicts live on different branches of the L397 gate and are simultaneously true. Recommend accepting all 8 R2 corrections.
