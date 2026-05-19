# Pre-Bootstrap R1 vs DB Diff — budgetshootersupply.ca

Audit run: 2026-05-15T09-08-04Z (R1, blind skill run)
Candidate: `docs/site-audit/budgetshootersupply.ca-2026-05-15T09-08-04Z-R1.json`
DB read: `MonitoredSite.siteProfile` (date stamp `lastVerified: 2026-04-11`)
Validator: 16/16 passed, score 100, valid: true.

## Top-level column diff

| Column | DB | R1 |
|---|---|---|
| `domain` | `budgetshootersupply.ca` | (same) |
| `url` | `https://www.budgetshootersupply.ca` | (R1 picked apex `https://budgetshootersupply.ca`) |
| `adapterType` | `woocommerce` | `woocommerce` (match) |
| `hasWaf` | `false` | `true` |
| `hasCaptcha` | `false` | `false` (match) |
| `name` | `Budget Shooter Supply` | (R1 omitted; not a candidate field) |

## siteProfile field diff

| Field | DB | R1 | Divergent? | One-line WHY |
|---|---|---|---|---|
| `platform` | `woocommerce` | `woocommerce` | NO | match |
| `adapter` / `adapterType` | `woocommerce` | `woocommerce` | NO | match |
| `hasWaf` | `false` | `true` | YES | Wordfence is installed (CSS/JS/login plugin) and SQLi/XSS payload GETs return 403; R1 set true defensively per Stage 2 "when unsure, set true." DB read it operationally — the WAF does NOT block the crawler's URL space. DB is correct. R1 overcautious. |
| `wafType` | (not set; `wafProbeResult:"no-waf"`) | `wordfence` | YES | R1 named the vendor; DB declared no-waf. |
| `hasCaptcha` | `false` | `false` | NO | match (both correctly identified login-only reCAPTCHA, not gating catalog) |
| `captchaType` | (omitted) | `recaptcha-v3` | YES (informational) | R1 records the vendor for context; DB omits since hasCaptcha=false. |
| `ageGate.detected` | (omitted) | `false` | YES (informational) | R1 explicitly tested + recorded; DB omits. |
| `userAgentOverride` | (omitted) | `null` | YES (informational) | match in spirit |
| `needsPlaywright` | `false` | `false` | NO | match |
| `expectedProductCount` | `2756` | `1577` | **YES — material** | DB counts ALL published products via WP REST `/wp-json/wp/v2/product` (includes hidden/drafts/private statuses). R1 counts customer-visible via WC Store `/wp-json/wc/store/v1/products`. Both have valid `x-wp-total` evidence headers. The "right" answer depends on whether the watermark tracks customer-visible-only or all published. DB calls out the gap explicitly: `"storeApiNote: Store API returns in-stock only (1598 vs WP REST 2756 all published)"`. R1 missed this distinction. |
| `productCountMethod.method` | `wp-rest-header` | `wp-rest-header` | NO | same canonical method name |
| `productCountMethod.endpoint` | `/wp-json/wp/v2/product` | `/wp-json/wc/store/v1/products` | YES | downstream of the count divergence above |
| `productCountMethod.header` | `x-wp-total` | `x-wp-total` | NO | match |
| `catalogUrls` | `["/products/"]` (1 entry) | 167 leaf URLs | **YES — material** | DB takes "API-only crawl, HTML fallback ref" stance (catalogUrls is a placeholder). R1 strictly enforced Rule C "100% leaf coverage via HTML category pages" because the runtime catalog crawler walks HTML, not API. Both approaches have merit; the project has chosen the API-only mode in DB. R1's leaf list is the right answer IF you want HTML coverage; DB is the right answer IF the catalog crawler defers entirely to API. The skill harness has no signal for "this site is API-only by operator choice". |
| `paginationPattern.type` | `api-page` | `path` | **YES — material** | DB describes API pagination via `?page=N`; R1 describes HTML pagination via `/page/{N}/`. Same root cause as catalogUrls divergence — DB is API-mode, R1 is HTML-mode. Both verified independently. |
| `paginationPattern.template` | `"page={N}"` (API query) | `"/page/{N}/"` (HTML path) | YES | downstream of pagination-type divergence |
| `perPage` | `100` | `100` | NO | match |
| `sortParam` | `?orderby=date` | `?orderby=date` | NO | match |
| `sortVerified` | `true` | `true` | NO | match |
| `sortVerifiedMethod` | `api-id-jump` | (R1 used HTML 3-outcome counter-control) | YES (method-of-proof) | DB proved monotonicity via API post-ID jumps page1→page2; R1 proved via HTML first-3-slug counter-control on a leaf. Both pass. Audit-trail residue per Rule B — not a runtime field. |
| `crawlers.watermark.method` | `api-date-since-watermark` | `api-date-since-watermark` | NO | match |
| `crawlers.bootstrap.apiEndpoints.productDiscovery` | `/wp-json/wp/v2/product` | (R1: `wcStoreApiProducts: /wp-json/wc/store/v1/products`) | YES (naming + shape) | DB names the discovery endpoint with its explicit role; R1 used different key names. Endpoints overlap in spirit but DB uses WP REST as primary discovery, R1 uses WC Store API. |
| `crawlers.maintain.verifyMethod` | `store-api` | `store-api` | NO | match |
| `crawlers.maintain.verifyEndpoint` | `/wp-json/wc/store/v1/products` | `/wp-json/wc/store/v1/products` | NO | match |
| `searchUrl` | `?s={keyword}&post_type=product` | (omitted) | YES | R1 missed this field — skill Stage 3 mentions `searchUrl` is OPTIONAL but should be discovered when present. |
| `apiDateFilter` (DB only) | `{param:modified_after, format:ISO8601, evidence:..., monotonic:true}` | (not in candidate schema) | YES | Audit-trail residue per Rule B — DB carries it, R1 candidate schema doesn't. |
| `dataFlow` (DB only) | `{steps:[...]}` | (not in candidate schema) | YES | DB has a detailed `dataFlow` doc for operators; not a candidate schema field. |
| `t1IntervalMin` (DB only) | `17` | (omitted) | YES | Scheduler-config field, not a pre-bootstrap output. |
| `jsOverlay` / `jsOverlayChecked` (DB only) | `none` / `[searchspring, klevu, ...]` | (omitted) | YES | Discovery-audit trail; R1 didn't probe these. |
| `htmlCrawlNote` / `catalogUrlsNote` / `shopPageNote` / `shopPageSlug` / `notes` (DB only) | extensive prose | (omitted) | YES | Audit-trail residue per Rule B. |
| `siteCategory` (DB only) | `retailer` | (omitted) | YES | Not in candidate schema. |
| `htmlCrawlViable` (DB only) | `false` | (R1 implicitly true since leaf extraction passed) | **YES — material disagreement** | DB explicitly says HTML crawl is NOT viable (Woodmart AJAX shop renders only 5 widget products); R1's extraction-quality test on the LEAF subcategory `centerfire-rifle-ammunition` returned 12 real product hrefs cleanly. The DB note describes PARENT-category pages; R1 tested LEAF pages. Both correct in their scope — R1 found the workaround (leaf URLs render products fine), DB never tried leaves. |
| `theme` (DB only) | `woodmart` | (omitted) | YES | Not in candidate schema; R1 noted Woodmart in evidence but didn't surface it as a top-level field. |
| `wafProbeEvidence` | DB: long prose string | R1: structured object | YES (shape) | DB's is a prose paragraph; R1's is the schema-conformant object. |
| `paginationPattern.note` (DB) | "WP REST API pagination via ?page=N..." | (omitted by R1) | YES | DB-side annotation, not part of candidate schema. |

## Divergent-field summary

**Material divergences (5):**
1. `hasWaf` — DB says false (operationally correct); R1 says true (defensive).
2. `expectedProductCount` — DB 2756 (WP REST all published); R1 1577 (WC Store visible). Different denominators.
3. `productCountMethod.endpoint` — downstream of (2).
4. `catalogUrls` shape — DB API-only single placeholder; R1 167-leaf HTML coverage.
5. `paginationPattern.type/template` — DB API-page form; R1 HTML path form. Downstream of (4).

**Method-of-proof divergences (2):** `sortVerifiedMethod` (api-id-jump vs HTML counter-control); pagination evidence (API `?page=N` vs HTML `/page/2/` zero-overlap).

**Audit-trail residue absent from R1 (Rule B governs; expected absence):** `apiDateFilter`, `dataFlow`, `t1IntervalMin`, `jsOverlay*`, `htmlCrawlNote`, `siteCategory`, `theme`, `notes`, `htmlCrawlViable`. R1 omits these per spec.

**Fields R1 missed that the candidate schema permits:** `searchUrl`.

## Operator interpretation

The fundamental gap between R1 and DB is **HTML-catalog vs API-only crawl mode**. The DB profile took an API-only stance: the catalog crawler defers entirely to WP REST + WC Store API; HTML `/products/` is decorative. R1 followed Rule C strictly and produced 167 leaf URLs because that's what gives 99.3% leaf-HTML coverage. The skill has no input signal saying "this site is API-only" — it built the catalogUrls a customer-facing UI would expose.

If the operator confirms API-only is the right mode, R1's 167-URL catalogUrls is the wrong answer for runtime (HTML walk would be redundant work). If HTML walk is wanted for cross-validation, R1's list is materially more complete than DB's single `/products/` placeholder.
