# Pre-Bootstrap Diff — doctordeals.ca (Batch 4 / Round 1)

Run: `B4R1-2026-05-15T18-42-44Z`
Candidate: `docs/site-audit/doctordeals.ca-2026-05-15T18-42-44Z-B4R1.json`
DB read: `MonitoredSite` row + `siteProfile` JSON column.

## Identical fields (no divergence)

| Field | Value |
|---|---|
| `platform` | `woocommerce` |
| `adapterType` | `woocommerce` |
| `hasWaf` | `true` |
| `wafType` | `sgcaptcha` |
| `hasCaptcha` | `false` |
| `needsPlaywright` | `true` |
| `sortParam` | `"?orderby=date"` |
| `wafWorkaround.method` | `cookie-cache` |
| `searchUrl` | `"/?s={keyword}&post_type=product"` |
| `productCountMethod.method` | `wp-rest-header` |
| `productCountMethod.endpoint` | `/wp-json/wp/v2/product` |
| `crawlers.watermark.method` | `api-date-since-watermark` |
| `crawlers.bootstrap.apiEndpoints.productDiscovery` | `/wp-json/wp/v2/product` |
| `crawlers.bootstrap.apiEndpoints.priceEnrichment` | `/wp-json/wc/store/v1/products` |

## Divergent fields (8)

### 1. `expectedProductCount`: **971** vs DB **965**
WHY: Both reflect WP REST `x-wp-total` on `/wp-json/wp/v2/product`. Live probe today returned 971; DB was last verified 2026-04-06 (~39 days old) and captured 965 then — 6 new products added since the DB snapshot.

### 2. `catalogUrls`: 6 URLs (canonical form) vs DB 5 URLs (`/gun-shop/` alias form)
WHY: DB uses `/product-category/gun-shop/<slug>/` (5 entries). Candidate uses `/product-category/<slug>/` (6 entries, adds `mags-barrels`). Sub-divergences:
- (a) **URL form** — both forms return 200 with identical content; `<link rel="canonical">` on either form points to `/product-category/<slug>/` (no `gun-shop`). The DB form is the alias; the candidate uses the canonical, which the WP taxonomy API itself returns in the `link` field.
- (b) **`mags-barrels` missing from DB** — top-level taxonomy entry (id 6294, parent=0, 109 products: 87 magazines + 22 barrels). Per Mistake 12 (don't drop categories), it must be in `catalogUrls`.

### 3. `perPage`: **12** vs DB **20**
WHY: Flatsome theme renders exactly 12 cards per HTML page; no `<select>` exposes a perPage override in the markup. DB's 20 is not honored — page 1 returns 12 regardless. The 20 likely came from a generic WC default. Candidate value matches what the HTML stream walker actually sees.

### 4. `paginationPattern`: full object vs DB **(field absent)**
WHY: Candidate emits `{type:"path", template:"/shop/page/{N}/", perPage:12, firstPageHasParam:false, startPage:1, zeroIndexed:false}`. DB omits the whole key. Without it the runtime crawler falls back to adapter defaults instead of a deterministic pattern.

### 5. `crawlers.maintain.verifyMethod`: **`store-api`** vs DB **`json-ld`**
WHY: SKILL.md Stage 3 table maps `platform=woocommerce` to `verifyMethod=store-api`. The worker uses this to choose batch API verification (fast, ~1 req per 10 products) vs per-product Playwright JSON-LD scrape. DB's `json-ld` forces the slow path even though the Store API returns 200 with valid payload.

### 6. `crawlers.maintain.verifyEndpoint`: **`/wp-json/wc/store/v1/products`** vs DB **(absent)**
WHY: Companion to #5. The worker needs the endpoint when `verifyMethod=store-api`. DB omits it because DB's `verifyMethod` is `json-ld`.

### 7. `userAgentOverride`: iPhone iOS **17.0** vs DB iPhone iOS **17.2**
WHY: Cosmetic only — both bypass sgcaptcha equally. Skill used the UA baked into Playwright's iPhone 13 device profile. No functional impact.

### 8. Operator audit-trail / runtime-tuning fields: candidate omits, DB has `crawlers.bootstrap.method`, `htmlFallback`, `dataFlow.steps[]`, `crawlers.maintain.cooldowns/tierShares/tierWindows`, `t1IntervalMin`, `name`, `budget`, `timeout`, `hasRateLimit`, `siteCategory`, long-form `notes`, older `lastVerified` date
WHY: Per Rule B in SKILL.md, the skill produces runtime fields only; audit-trail residue and runtime-tuning fields are operator-added during DB promotion. Listed here for completeness, not as a defect.

## Validator status
- Required fields present (9/9): `profileVersion`, `platform`, `adapterType`, `hasWaf`, `expectedProductCount`, `productCountMethod`, `catalogUrls`, `extractionTested`, `paginationPattern`.
- Recommended fields present (7/7): `sortParam`, `sortVerified`, `perPage`, `crawlers.watermark.method`, `crawlers.bootstrap.apiEndpoints`, `crawlers.maintain.verifyMethod`, `lastVerified`.

## Material divergences (operator should reconcile)
1. `catalogUrls`: switch to canonical `/product-category/<slug>/` form AND add `mags-barrels` (109 products currently uncovered).
2. `perPage`: drop 20 → 12 (or switch to API-based crawl path).
3. `paginationPattern`: add the missing discriminated-union object.
4. `crawlers.maintain.verifyMethod`: switch `json-ld` → `store-api` + add endpoint.
5. `expectedProductCount`: 965 → 971 (stale by 6).
