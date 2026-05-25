# B5R2 Investigation — tacord.com

Auditor: B5R2 (testing-api-tester live re-investigation)
Method: Direct `curl` probes against `tacord.com` production with 800ms+ inter-request delays. No DB writes.
Scope: 3 R1-vs-DB divergences only. All non-divergence fields inherited from R1 candidate untouched.

## Method per divergence

For each divergence I ran a different, evidence-first probe rather than re-running R1's full pipeline. Goal: confirm or refute R1 with the smallest possible production touch.

## D1 — expectedProductCount (R1: 206; DB: 203)

**Probe.** Two endpoints, two UAs, with 800ms+ delays.

```
GET /wp-json/wp/v2/product?per_page=1
  default UA -> 200, X-WP-Total: 206, X-WP-TotalPages: 206

GET /wp-json/wp/v2/product?per_page=1&context=view
  default UA -> 200, X-WP-Total: 206

GET /wp-json/wc/store/v1/products?per_page=1
  default UA -> 200, X-WP-Total: 206

GET /wp-json/wc/store/v1/products?per_page=1
  UA=TACORD-AUDIT-RECONFIRM/1.0 (fresh) -> 200, X-WP-Total: 206

GET /wp-json/wp/v2/product?per_page=1
  UA=TACORD-AUDIT-RECONFIRM/1.0 (fresh) -> 200, X-WP-Total: 206
```

Both surfaces agree on 206. DB value 203 is dated 2026-04-12 (40 days stale); +3 net products is plausible churn.

**Verdict: 206 (high confidence). R1 candidate stands.**

## D2 — watermark.method (R1: api-date-since-watermark; DB: navigate-from-watermark)

DB notes carry an explicit historical reason: "2026-04-12: WP REST wp/v2/product returns 401 (auth-gated) ... Watermark downgraded api-date-since-navigate-from-watermark."

I tested whether that 401 is still true and whether `modified_after` is honored today.

**WP REST 401 status.** Three independent probes, two UAs:

```
GET /wp-json/wp/v2/product?per_page=1                  -> 200 anonymous
GET /wp-json/wp/v2/product?per_page=1&context=view     -> 200 anonymous (admin-mode arg honored without auth)
GET /wp-json/wp/v2/product?per_page=1 [fresh UA]       -> 200 anonymous
```

Not 401. Today the endpoint is fully open.

**Two-probe `modified_after` honored check.**

```
GET /wp-json/wp/v2/product?modified_after=2099-01-01T00:00:00&per_page=1 -> 200, X-WP-Total: 0
GET /wp-json/wp/v2/product?modified_after=1999-01-01T00:00:00&per_page=1 -> 200, X-WP-Total: 206
```

Future-cutoff returns 0; past-cutoff returns global. Filter is honored, not silently dropped.

**Runtime fit.** `backend/src/services/scraper/adapters/woocommerce.ts:337` wires `options.dateAfter -> params.modified_after` against `/wp-json/wp/v2/product` (L340). `supportsDateFilter = true` (L22). The adapter speaks exactly the API surface that is working today.

**Verdict: api-date-since-watermark (high confidence). R1 candidate stands.**

The DB 401 history is unreconstructable from the repo: `git log --grep=tacord -i` returns only the bulk Phase 0 commit `fda6e31`, no per-site WP REST 401 commit. The original cause is one of: (a) a Wordfence/security-plugin rule that was later removed, (b) a temporary merchant restriction, (c) a 2026-04-12 audit misreading a different failure (HPE parse error, rate-limit, auth-path failure), or (d) genuine plugin reconfiguration. Today the field is open and the filter works — that is the relevant runtime state.

## D3 — productCountMethod.endpoint (R1: Store API; DB: WP REST core)

This is a B8 pair-rule violation in the DB, not a live-state question.

**Skill rule** (`SKILL.md:872`): if `crawlers.maintain.verifyMethod = "store-api"`, then `productCountMethod.endpoint` MUST be `/wc/store/v1/products` (NOT `/wp/v2/product`).

DB carries `verifyMethod = store-api` AND `endpoint = /wp/v2/product` — explicit violation. R1 candidate pairs them on the Store API surface as the skill requires.

Both surfaces return 206 today so the mechanical divergence is invisible, but pairing prevents future silent coverage gaps: WP REST core can include drafts/private posts that Store API customer-visible filter excludes. The 2026-04-12 DB carried operator residue; R1 cleans it up.

**Verdict: /wp-json/wc/store/v1/products (high confidence). R1 candidate stands.**

## Standing tasks deferred to R3

1. **Sustained 50-page walk per UA (B9)** — R2 did not execute. Carried forward from R1.
2. **Sitemap / per-category count cross-check (B11)** — R1 reported allOption sum 239 vs global 206 (delta 33 = cross-cat overlap). R2 did not spot-check; R3 should hit 2-3 categories via WC Store API `?category=ID&per_page=1`.
3. **WP REST 401 historical reconstruction** — search `docs/site-audit/` and `_audit_tmp/` for any prior tacord artifact that pins down the 2026-04-12 401 origin. Useful for confidence on D2 but not blocking — today's runtime state controls.

## Outcome

All 3 divergences resolved in favor of R1 candidate. Zero new fields touched. Final accepted state for R3:

| field | value |
|---|---|
| expectedProductCount | 206 |
| watermark.method | api-date-since-watermark |
| productCountMethod.endpoint | /wp-json/wc/store/v1/products |
