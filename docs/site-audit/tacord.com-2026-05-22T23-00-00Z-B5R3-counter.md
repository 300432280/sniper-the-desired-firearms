# B5R3 Adversarial Counter — tacord.com

Auditor: B5R3 (engineering-code-reviewer adversarial)
Method: Live multi-UA probes + runtime trace of `woocommerce.ts:330-430`. 800ms delays. No DB writes.
Goal: disprove R2. All three verdicts SURVIVE.

## D1 — count 206 vs DB 203 → R2 SURVIVES

Re-probed both surfaces:
- `GET /wp-json/wp/v2/product?per_page=1` Chrome UA → 200, X-WP-Total=**206**
- `GET /wp-json/wp/v2/product?per_page=1&context=view` Firefox UA → 200, X-WP-Total=**206**
- `GET /wp-json/wc/store/v1/products?per_page=1` Edge UA → 200, X-WP-Total=**206**
- Page 50, page 206 → 200, total=206 (sustained pagination intact)

DB 203 stamped 2026-04-12, 41 days stale; +3 churn plausible. **206 stands.**

## D2 — watermark.method=api-date-since-watermark → R2 SURVIVES (with caveat)

Multi-UA WP REST 401 retest:
- Chrome / Firefox / Safari / Edge default `context` → all 200
- `context=edit` Safari UA → **HTTP 401 Unauthorized** (expected; admin-mode requires auth)
- `context=view` Firefox UA → 200 (anonymous OK)

Two-probe `modified_after` honored on WP REST: future cutoff=0, past cutoff=206 (filter live).
Two-probe `after=` honored on Store API: future=0, past=206 (Store API ALSO supports date filter — see `woocommerce.ts:419` `storeParams.after = options.dateAfter`).

Runtime: adapter L337 wires `dateAfter→modified_after` on WP REST first; L412 falls back to Store API `after=` if WP REST 401s. Today WP REST is open in `context=view` (the only context the adapter sends — it never sets context, defaulting to `view`). **Method stands.**

Caveat: the historical 401 may have been a `context=edit` misclassification, but adapter never sends edit; non-blocking.

## D3 — productCountMethod.endpoint=/wc/store/v1/products → R2 SURVIVES

B8 pair-rule is SKILL.md convention, not code-enforced (`profile-validator.ts:155` only checks `verifyMethod` is non-empty). Pairing is semantically correct: count surface must match verify surface to avoid drift between drafts/private (WP REST core) and customer-visible (Store API). Today both return 206 so no live divergence, but DB has explicit operator-residue mismatch (verifyMethod=store-api + endpoint=wp/v2). Cleanup correct.

Bonus B11 sitemap/category check (R2 standing task):
- cat=19 (tactical-ordnance) → X-WP-Total=42 (matches categories endpoint count=42)
- cat=75 (headware) → 2 (matches count=2)
- cat=260 (builders-choice) → 5 (matches count=5)

Per-category Store API counts consistent with category metadata; R1 allOption sum 239 vs global 206 (delta 33) is normal cross-cat overlap, not a coverage gap.

## Final R3 verdict

All three R2 corrections accepted. Promote to R4 synthesis:
- `expectedProductCount`: **206**
- `watermark.method`: **api-date-since-watermark**
- `productCountMethod.endpoint`: **/wp-json/wc/store/v1/products**

No new divergences uncovered. No fields reopened.
