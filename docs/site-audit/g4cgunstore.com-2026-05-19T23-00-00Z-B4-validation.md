# g4cgunstore.com — Batch-4 Validation (single round)

Date: 2026-05-19T23:00:00Z
Reviewer: validation-pass

## Fix-by-fix verdict

### 1. catalogUrls = ['/shop/'] — PASS
- Live with Safari 17 UA:
  - `GET /shop/page/245/` -> **200**
  - `GET /shop/page/246/` -> **404**
- Confirms /shop/ is the canonical paginated spine and bounds (24 per page * 245 ~= 5880 slots, matches 5863 with a small tail).

### 2. userAgentOverride = Safari 17 — PASS (and adversarial confirms necessity)
- Safari UA WP REST: `x-wp-total: 5863`, HTTP 200.
- Adversarial Chrome 120 UA across 10 distinct /shop/page/N/ (N=12,47,88,130,175,200,215,230,5,60) at 800 ms spacing: **all 10 returned 403** (instant block — even harsher than R3 predicted; the Safari override is required, not optional).

### 3. expectedProductCount = 5863 — PASS
- WP REST header `x-wp-total: 5863` matches DB value exactly. (Old profile noted 5741; inventory has grown.)

### 4. needsPlaywright = false — PASS
- HTTP + Safari UA suffices for /shop/ and /wp-json/wp/v2/product. No JS challenge fired.

### 5. wafType = 'cloudflare-passive' — PASS conditional on Safari UA
- Passive with Safari, active 403 with Chrome 120. Profile note (siteProfile L109) accurately captures this.

### 6. Phase 3b warn (platform != adapterType) — PASS with caveat
- `adapter-registry-mismatch.ts:44-54` implements the C2 branch. For g4cgunstore: `siteProfile.crawlers.catalog` is absent, so the catalog.method branch short-circuits on `typeof catalogMethod === 'string'` (false), and execution falls through to the platform branch. `platform="woocommerce"` != `adapterType="generic-retail"` -> warn fires once.
- Caveat: `warnedDomains` is shared across both branches. If a domain has BOTH catalog.method drift AND platform drift, only the first branch's warn is emitted in that process. Acceptable for g4cgunstore (only platform drift exists); track if other sites hit both.
- `_resetAdapterMismatchWarnings()` test export is correct.

### 7. Dead dataFlow.steps in code — PASS
- `grep -r 'dataFlow' backend/src` returns 0 hits. The `dataFlow` block at siteProfile L72-96 is operator-doc residue with no runtime consumer.

## Overall: APPROVED
All five DB fixes verified live. Phase 3b warn fires as intended. No regressions detected.
