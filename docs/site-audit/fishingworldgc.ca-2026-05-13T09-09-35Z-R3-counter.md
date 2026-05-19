# R3 Adversarial Counter — fishingworldgc.ca

**Probe time:** 2026-05-13T09:00-09:09Z
**R2 corrections under review:** `docs/site-audit/fishingworldgc.ca-2026-05-13T08-49-12Z-R2-corrections.json`
**Method:** Fresh skeptic. For each R2 correction, run a DIFFERENT probe than R2 and try to disprove it. "Inconclusive" preferred over fabricated counter.

---

## Summary

- Corrections attempted: 8
- Corrections countered: 0
- Corrections survived: 8 (7 fully verified, 1 with one minor framing tightening — see #6)

R2's verdict holds in full.

---

## Per-correction attempts

### 1. `productCountMethod.method = shopify-products-walk` — SURVIVED

**R2 reasoning:** Switch in `product-count-probe.ts:148` has no `products-json-walk` arm — falls through to `default: return null`. Canonical arm at line 272 is `shopify-products-walk`.

**R3 method (different):** Trace the runtime call site, not the switch.

`worker.ts:248` reads `siteProfile?.productCountMethod ?? null` and passes it into `verifyBootstrapCoverage(...)` (`product-count-probe.ts:466`), which dispatches on `m.method` through the same switch. No second resolver, no alias shim. The candidate value `shopify-products-walk` literally matches case at line 272. DB value `products-json-walk` matches NO case → line 446 default → `null`.

**Counter:** none.

---

### 2. `hasWaf = false` — SURVIVED (R2 used bodies; R3 used timing + challenge-cookie inspection)

**R3 method (different from R2's body inspection):** 30 parallel GETs with no inter-request spacing.

```
30 parallel requests in 426 ms
Statuses: {"200":30}
Unique set-cookie names: [ 'localization=CA' ]
```

Plus `_shopify_y` (Shopify identity cookie). Critically ABSENT from every response:
- `cf_clearance` — set when CF issues a challenge and client passes
- `__cf_bm` — CF bot-management session
- `__cfwaitingroom` — CF queue token
- `cf-mitigated` response header

Zero CF challenge tokens across 30 rapid hits in 426 ms (~70 req/s). No 429, no 503. CF is `cf-cache-status: DYNAMIC` (passive proxy).

**Counter:** none. Two independent methods (bodies + timing+cookies) agree.

---

### 3. `catalogUrls = ['/collections/all']` — SURVIVED (R2 walked 4 sub-collections; R3 walked 3 MORE)

**R2 walked:** centre-fire-rifle (88), shotgun-ammo (75), pre-owned (12), shooting-miscellaneous-1 (172).

**R3 walked 3 sub-collections R2 did NOT touch:**

```
|P| /products.json   = 2011
|A| /collections/all = 2011   P\A=0  A\P=0  (byte-equivalent reconfirmed)

S(all-guns)     size=364   S\A=0   S\P=0
S(all-ammo-1)   size=352   S\A=0   S\P=0
S(magazines-1)  size=80    S\A=0   S\P=0
```

Picked deliberately: `all-guns` and `all-ammo-1` are the TWO LARGEST sub-collections on the site (`products_count` 726 and 592). If anything were hiding outside `/collections/all`, a mega-collection would expose it. Every ID was a member of both A and P.

Combined with R2, 7 of 250 sub-collections walked spanning small (12, 75, 80, 88) / medium (172) / large (352, 364) buckets — total 1143 membership slots tested, all subset of A.

**Counter:** none.

---

### 4. `expectedProductCount = 2011` — SURVIVED

Re-walked `/products.json` (9 pages) fresh 2026-05-13T09:00Z → 2011 unique IDs. Three-way reconcile from R2 holds. DB's 1953 is 32-day-stale data drift at +1.8/day, consistent.

**Counter:** none.

---

### 5. `topLevelCategories.categories[].allOption` (downgrade to medium) — SURVIVED + EXTENDED

R3 found additional `products_count` over-reports on 3 slugs not in R2's table:

| slug | products_count | live walk | ratio |
|---|---|---|---|
| all-guns | 726 | 364 | 1.99x |
| all-ammo-1 | 592 | 352 | 1.68x |
| magazines-1 | 143 | 80 | 1.79x |

Confirms the over-report is systemic across the site, not a per-slug fluke. Downgrade to "medium" stands.

**Counter:** none.

---

### 6. `crawlers.maintain.verifyMethod = detail-page` — SURVIVED, FRAMING TIGHTENED

**R3 read of worker.ts:759-769:**

```
} else {
  const verifyMethod = entry?.siteProfile?.crawlers?.maintain?.verifyMethod;
  if (!verifyMethod) { ...skip... return; }
  // verifyMethod === 'detail-page' — visit each product URL via Playwright
  const pwResult = await verifyProductsViaPlaywright(...);
}
```

The check is `if (!verifyMethod)` — truthy-only. The comment says "=== detail-page" but the code does NOT enforce that equality. Both `'detail-page'` and `'json-ld'` (and any other truthy string) fall through to the IDENTICAL Playwright path TODAY. `tryStoreApiVerify` returns null unless verifyMethod is literally `'store-api'`.

R2 already conceded this on its runtime-impact table line 133 ("Same Playwright path either way today; future SKILL.md tightening may strict-check the label"). The correction is label-canonical, not bug-fix.

**Counter:** none. **Tightening:** label this as "label normalization, zero runtime impact today, future-proofing for SKILL.md strict checks" rather than a high-impact correction.

---

### 7. `paginationPattern.perPage = 250` — SURVIVED

`catalog-crawler.ts:288-294` calls `adapter.fetchCatalogPage(origin, page, { ..., perPage: profilePerPage || (params.hasWaf ? 20 : 50), ... })`. With profilePerPage=250 the Shopify adapter uses /products.json which caps at 250. Fresh walk completed in 9 pages = 2011/250 → 8 full + 1 partial.

**Counter:** none.

---

### 8. `crawlers.maintain.verifyEndpoint = null` — SURVIVED

`tryStoreApiVerify` at worker.ts:397 short-circuits before reading verifyEndpoint when verifyMethod != 'store-api'. detail-page Playwright path does not consult verifyEndpoint at all.

**Counter:** none.

---

## Required verdicts

### `/collections/all` extra-sub-collection coverage — REQUIRED

**Verdict:** PROVEN as global cover. R3 walked 3 additional sub-collections not touched by R2: `all-guns` (364 — 1.99x over-report by /collections.json), `all-ammo-1` (352 — 1.68x), `magazines-1` (80 — 1.79x). All three: S\\A = 0 and S\\P = 0. Combined with R2's 4, the test covers 7 collections at small/medium/large/mega density tiers, 1143 product-membership slots — every one a subset of `/collections/all`. Counter-claim space closed.

### WAF rapid-burst rate-limit — REQUIRED

**Verdict:** CF-passive confirmed via timing. 30 parallel GETs in 426 ms (~70 req/s) → 30 × HTTP 200. No CF challenge cookies (`cf_clearance`, `__cf_bm`, `__cfwaitingroom`) in any response. Only Shopify cookies (`localization`, `_shopify_y`). No 429, no 503, no `cf-mitigated`. Two independent methods (R2's payload bodies + R3's timing+cookies) converge. **hasWaf:false correct.**

---

## Strongest "counter-claims"

There are none in the disprove-R2 sense. The closest is correction #6 — verifyMethod runtime impact today is zero, so "high confidence" overstates urgency. R2 themselves flagged this honestly on line 133. Recommend re-labelling #6 as a future-proofing canonicalization rather than an active bug.

---

## Files

- `_audit_tmp/fw-r3-pj-{1..9}.json` — fresh /products.json walk
- `_audit_tmp/fw-r3-coll-all-{1..9}.json` — fresh /collections/all walk
- `_audit_tmp/fw-r3-sub-all-guns-{1..4}.json` — biggest sub-collection R2 did not touch
- `_audit_tmp/fw-r3-sub-all-ammo-{1..3}.json` — 2nd biggest R2 did not touch
- `_audit_tmp/fw-r3-sub-magazines-1.json` — small R2 did not touch
- `_audit_tmp/fw-r3-coll-list.json` — 250-collection inventory used to pick

Inline 30-parallel-burst output captured in the WAF verdict above.
