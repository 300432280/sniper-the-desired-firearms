# alflahertys.com — Batch 4 Validation (single-round positive + adversarial)

- Timestamp: 2026-05-19T23:00:00Z
- Reviewer: engineering-code-reviewer + ECC code-review + silent-failure-hunter (Karpathy §1-§4)
- Inputs:
  - POSTFIX DB snapshot: `_audit_tmp/batch4-validation-2026-05-19/alflahertys.com-POSTFIX.json`
  - Runtime adapter: `backend/src/services/scraper/adapters/generic-retail.ts`
  - Type-check: `npx tsc --noEmit` (clean, 0 errors)

---

## Fix 1 — `hasWaf` column flip true → false (passive CF only)

**Verdict: PASS-with-caveat (NEEDS-OPERATOR follow-up)**

### Positive evidence
- Live `HEAD https://www.alflahertys.com/` returns ONLY:
  - `Server: cloudflare`
  - `set-cookie: __cf_bm=...` (Cloudflare bot-management, HttpOnly, passive)
  - `CF-RAY: 9ff1a4336e2cebb9-YYZ`
- Grep for `sucuri|cloud-proxy` on both response headers and homepage body: zero hits.
- `column_hasWaf: false`, `column_requiresSucuri: false` confirmed in POSTFIX DB snapshot.

### Adversarial finding (silent-failure-hunter)
**Embedded `siteProfile.hasWaf` is still `true`** in POSTFIX (line 16 of snapshot). The runtime is inconsistent:

| Code path | Reads from | Effect after fix |
|---|---|---|
| `crawl-scheduler.ts:209`, `worker.ts:883`, `catalog-crawler.ts:290-852`, `priority-engine.ts:205` | `site.hasWaf` (DB column) | Sees `false` correctly — uses 50 perPage default path, no Playwright fallback. PASS. |
| `generic-retail.ts:363` (Klevu key resolver call) | `profile?.requiresSucuri || profile?.hasWaf` (embedded blob) | Sees `true` — `klevu-key-resolver.ts:75` still uses Playwright on key-refresh. Degraded perf, not broken. |

Not a regression (pre-fix it also used Playwright), but the column flip alone does not fully propagate. Operator should flip the embedded `siteProfile.hasWaf` to `false` for consistency, or accept the Playwright key-resolve path.

---

## Fix 2 — `wafWorkaround` block DELETED (stale Sucuri notes)

**Verdict: PASS**

POSTFIX siteProfile has no `wafWorkaround` key. `grep -r "wafWorkaround" backend/src` confirms no code reads `siteProfile.wafWorkaround` anywhere. Pure documentation residue; safe to delete.

---

## Fix 3 — `sortParam = null` (Klevu rejects every date-sort)

**Verdict: PASS**

### Positive
- Live POST to `https://uscs33v2.ksearchnet.com/cs/v2/search` with `{sort: 'PRICE_ASC', limit: 1}`:
  - HTTP 200, `responseCode:200`, returns valid record.
- Live POST with `{sort: 'DATE_DESC', limit: 1}`:
  - HTTP 500 — `{"responseCode":500,"error":{"message":"Invalid request or server error"}}`.
- Confirms Klevu rejects DATE_* sorts entirely. Setting `sortParam = null` is the only honest representation.

### Adversarial
- `generic-retail.ts:386` hard-codes `sort: 'RELEVANCE'` in the live Klevu call — does NOT read `siteProfile.sortParam`. So the DB sortParam change is purely a documentation/UI signal here, not a runtime switch. Not a bug — RELEVANCE works (200 OK) and the column null correctly says "no usable date sort exists." Watermark crawler config already declares `method: 'full-catalog-sweep'` to match.

---

## Fix 4 — `perPage = 20`

**Verdict: PASS**

- POSTFIX shows `siteProfile.perPage: 20`.
- Verified runtime path: `catalog-crawler.ts:290` uses `profilePerPage || (params.hasWaf ? 20 : 50)` — 20 will be honored.
- Klevu wildcard `{limit:1}` returns `totalResultsFound: 5261`, which at perPage=20 → 264 pages. Within crawler budget (120/hr). No regression.

---

## Fix 5 (runtime code) — Phase 3b: `_resolveKlevuCategoryPath` DELETED

**Verdict: PASS**

### Positive
- `grep _resolveKlevuCategoryPath backend/src` returns ONLY the tombstone comment at `generic-retail.ts:286-293`. The method declaration is gone.
- `grep klevuCategoryPaths backend/src` matches the comment at L289 only. Outside `src/`: one historical DB seed (`scripts/migrate-site-profiles.js:22`) and one comment in the apply script — both confirmed documentation, not runtime callers.
- `fetchPageWithMeta` was never imported by `generic-retail.ts` (verified by grep — all hits are in catalog-crawler, watermark-crawler, scraper/index, http-client, product-verifier, stale-detector, the scripts/verify-dd.ts harness). The task brief's "fetchPageWithMeta import removed" is a no-op — there was no such import here to remove.
- `npx tsc --noEmit`: zero errors.

### Adversarial
- The live Klevu fetch at `generic-retail.ts:377-394` uses `query:{term:'*'}` global wildcard SEARCH. Verified live: `totalResultsFound: 5261` vs POSTFIX `expectedProductCount: 5262` — 1-off, within normal in-flight catalog drift. The deleted method's `klevuCategoryPaths` was never invoked, so deletion changes zero runtime behavior.
- Inputs to L377 trace cleanly:
  - `klevuEndpoint` ← `profile.apiConfig.klevuEndpoint` (present in POSTFIX).
  - `klevuKey` ← `resolveKlevuKey(domain, origin, {hasWaf})` at L362 — self-heal path intact.
  - `perPage` ← `options?.perPage` from catalog-crawler (20) || `KLEVU_DEFAULTS.perPage` (36).
  - `offset` ← `(page-1)*perPage`.

### Silent-failure check
- No "klevuProduct" selector logic in `extractMatches` depends on `klevuCategoryPaths` (the SELECTORS entry at L78 is a CSS selector, unrelated). PASS.

---

## Top issues / blockers

1. **MINOR (operator follow-up):** `siteProfile.hasWaf` embedded value still `true` in POSTFIX while column is `false`. Two readers of `hasWaf` use different sources; the key-resolver path will keep using Playwright. Not blocking. Recommend flipping the embedded value for consistency.
2. **NONE blocking.** All other fixes verified live + tsc clean.

## Per-fix verdicts

| Fix | Verdict |
|---|---|
| 1. hasWaf column flip | PASS (caveat: embedded `siteProfile.hasWaf` still true) |
| 2. wafWorkaround deletion | PASS |
| 3. sortParam = null | PASS |
| 4. perPage = 20 | PASS |
| 5. `_resolveKlevuCategoryPath` deletion | PASS |

Overall: **PASS** (with one cosmetic operator follow-up).
