# wolverinesupplies.com — Batch-4 Single-Round Validation

**Date:** 2026-05-19T23:00:00Z
**Site:** wolverinesupplies.com (BigCommerce Stencil, generic-retail, Cloudflare passive)
**Persona:** engineering-code-reviewer (Karpathy §1-§4)
**Post-fix snapshot:** `_audit_tmp/batch4-validation-2026-05-19/wolverinesupplies.com-POSTFIX.json`

---

## Fix 1 — `hasWaf` column flip true → false

**POSITIVE — Live test:**
- `curl -I https://wolverinesupplies.com/firearms/?sort=newest&perPage=100` → HTTP 200, 638 KB body.
- Response headers: `server: cloudflare`, `cf-ray` present, `cf-cache-status: DYNAMIC`, `__cf_bm` cookie (anti-bot management, set on every CF site; presence != active blocking).
- No `cf-mitigated`, no 403, no JS challenge, no Turnstile, no `__cf_chl_*` cookie.

**ADVERSARIAL — 5-burst on `/firearms/` (read-only GET, no auth, no path traversal):**
```
burst1: HTTP:200 time:0.977720s
burst2: HTTP:200 time:0.907125s
burst3: HTTP:200 time:0.996827s
burst4: HTTP:200 time:0.976919s
burst5: HTTP:200 time:0.912028s
```
All 5 = HTTP 200, ~1s, no escalation, no rate-limit, no challenge. CF is passive (header-presence only).

**Note on inconsistency:** `column_hasWaf=false` but the embedded `siteProfile.hasWaf=true` AND `siteProfile.wafType='cloudflare-passive'`. Runtime read path (`adapter-registry`) uses `siteProfile.hasWaf` — see `worker.ts:769` (`entry?.siteProfile?...`). If the column is the authoritative source the embedded field is stale; if siteProfile is authoritative the column flip is cosmetic. **NEEDS-OPERATOR review of which field gates `product-count-probe.ts:172` WAF cookie path.**

**Verdict:** PASS (network proof of passive CF) / NEEDS-OPERATOR (clarify column vs siteProfile precedence — they currently disagree).

---

## Fix 2 — `productCountMethod = {method:'sitemap', url:'/xmlsitemap.php?type=products&page=1'}`

**POSITIVE — Live test:**
- `GET /xmlsitemap.php?type=products&page=1` → HTTP 200, 968,911 bytes, `Content-Type: text/xml; charset=UTF-8`.
- `grep -c "<loc>"` → **8193** entries.
- Sample loc URLs are real product detail pages (`/dan-wesson-front-night-sight-180/`, `/eotech-vudu-1-6x24-sr3-reticle-ffp-moa/`, etc.) — not categories.

**Code-path sanity (`backend/src/services/product-count-probe.ts`):**
- L110-122 `VALID_METHOD_NAMES` includes `'sitemap'`.
- L186 `validateMethod(m)` accepts it.
- L232-238 `case 'sitemap'` reads scalar `m.url`, GETs `${origin}${m.url}`, counts `<loc>` occurrences. Matches the corrected DB shape exactly.
- Previous broken bare-string shape (just `'sitemap'`) would fail `validateMethod` (method = undefined) and throw — confirming the fix is non-cosmetic.

**ADVERSARIAL:**
- Probe count (8193) > `siteProfile.sitemapProductCount` (8054) and equals `expectedProductCount` (8193). `notes` say "8,054 in sitemap" — stale; probe will overwrite via `verifyBootstrapCoverage`.
- DB browsable count is 5,739 (notes) / 5,801 (sum of `catalogUrlStats`). `dbCount / 8193 = 0.708` — **below 0.95 `COVERAGE_THRESHOLD`**. The sitemap includes 2,300 OOS products excluded from category listings (`sitemapNote`). This is a **known false negative** — the coverage gate will permanently fail unless the operator switches to a category-walk count method (e.g. `stream-page-count`) for the runtime gate.

**Verdict:** PASS for probe correctness / NEEDS-OPERATOR for coverage-gate semantics (sitemap count is not browsable ground truth here).

---

## Fix 3 — `expectedProductCount = 8193`

**POSITIVE:** Equals the live `<loc>` count (8193). Internally consistent with Fix 2.

**ADVERSARIAL:** As above — 8193 is sitemap (incl. OOS), not browsable. `5801 / 8193 = 0.708` will trip `isAcceptable=false` in `verifyBootstrapCoverage` (L513). Bootstrap will never declare complete with current numbers.

**Verdict:** PASS as a faithful sitemap echo / NEEDS-OPERATOR — pick one definition (sitemap OR browsable) and align `expectedProductCount` + `productCountMethod` to it.

---

## Fix 4 — `crawlers.maintain.verifyMethod = 'detail-page'`

**POSITIVE — Code read (`backend/src/services/worker.ts:765-781`):**
- L769 reads `entry?.siteProfile?.crawlers?.maintain?.verifyMethod`.
- L770-773: if missing, logs `MISSING verifyMethod ... Skipping verification` and `return`s. Pre-fix wolverine hit this branch (no-op verify worker).
- With `'detail-page'` set: L775 calls `verifyProductsViaPlaywright(products, ...)` over all products. No-op eliminated.
- Note: the value is not branched on by name — comment at L774 says `verifyMethod === 'detail-page'` but the code just checks for presence. Any truthy string would also exit the early-return. Acceptable; comment is documentation-only.

**ADVERSARIAL:** Detail-page verify on 8054+ products via Playwright is expensive. With `hasWaf=false` (column) the verify path skips WAF cookies. With `siteProfile.hasWaf=true` the verify path may still acquire CF cookies (function reads siteProfile). Either way Playwright runs, so verification is no longer a no-op. Confirmed not a security/correctness regression.

**Verdict:** PASS.

---

## Summary

| Fix | Verdict |
|---|---|
| 1. `hasWaf` column flip | PASS / NEEDS-OPERATOR (column vs siteProfile drift) |
| 2. `productCountMethod` corrected shape | PASS (probe correct) / NEEDS-OPERATOR (8193 != browsable ground truth) |
| 3. `expectedProductCount = 8193` | PASS / NEEDS-OPERATOR (same definition issue as Fix 2) |
| 4. `verifyMethod = 'detail-page'` | PASS |

**Top issues:**
1. `column_hasWaf=false` vs `siteProfile.hasWaf=true` disagreement — only one is authoritative at runtime; clarify and align.
2. Sitemap count (8193) includes ~2,300 OOS products invisible to category walk → permanent `isAcceptable=false` on coverage gate. Either accept that ratio or switch the count method.

**Blockers:** None. All 4 fixes function correctly; remaining items are profile-consistency choices for the operator.
