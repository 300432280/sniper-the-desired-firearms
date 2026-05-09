---
name: pre-bootstrap
description: AI-driven harness for onboarding a new site to the FirearmAlert fleet. Produces a candidate siteProfile JSON for operator review. AI drives discovery directly; helper scripts under backend/scripts/probe/ are personal tools, NOT pipeline components.
---

# Pre-Bootstrap — AI-Driven Site Onboarding Harness

## Usage

```
/pre-bootstrap <url>
```

## Mission

Onboard a NEW site by producing a candidate `siteProfile` JSON that an operator reviews and (separately) promotes to the DB. The output goes to `docs/site-audit/<domain>-<ISO-timestamp>.json`. Pre-bootstrap **never** writes to DB.

This skill can also be run on an EXISTING site as a **calibration run**: produce a candidate, diff against the DB siteProfile (the answer key), find gaps in the harness, fix them. Calibration output goes to the same `docs/site-audit/` folder; the operator does NOT promote calibration output to DB.

## Architecture (post-2026-04-27 pivot)

**AI is the operator.** You drive discovery interactively — fetch a page, read it, decide what to fetch next, build the answer field by field.

**Helper scripts are personal tools, not pipeline stages.** The legacy composer at [`backend/scripts/pre-bootstrap.ts`](../../../backend/scripts/pre-bootstrap.ts) and the helper folders under [`backend/scripts/probe/`](../../../backend/scripts/probe/) still exist; the prior session proved they're fragile across platforms. Do NOT treat them as the pipeline. Invoke individual helpers (heavy-WAF probe, platform detectors, sitemap extractor, walk-and-dedupe, count probe) as **TOOLS** when useful — but the discovery loop is yours.

**One artifact:** the candidate `siteProfile` JSON. Anything else (intermediate scratch, helper-script output, debug logs) is supporting evidence, not the deliverable.

---

## Critical rules (read these before any stage)

These four rules are non-negotiable. Violating any of them produces broken output that looks plausible.

### Rule A — `pre-bootstrap-output/<domain>-profile.json` is NOT a siteProfile

If your project has a helper script that emits intermediate JSON (e.g. `docs/pre-bootstrap-output/<domain>-profile.json`), it's **scratch / evidence**, NOT a siteProfile. The only siteProfile is the formal candidate JSON you produce in Stage 9 at `docs/site-audit/<domain>-<ts>.json`, plus the eventual DB column the operator promotes it to. Don't conflate.

### Rule B — Audit-trail residue is NOT a target field

The DB `siteProfile` JSON column on existing sites contains TWO kinds of fields:
- **Runtime fields** the crawler reads at execution time: `platform`, `adapterType`, `hasWaf`, `wafType`, `userAgentOverride`, `needsPlaywright`, `expectedProductCount`, `productCountMethod`, `catalogUrls`, `paginationPattern`, `perPage`, `sortParam`, `sortVerified`, `crawlers.watermark.method`, `crawlers.bootstrap.apiEndpoints`, `lastVerified`, `profileVersion`.
- **Operator audit-trail residue** — documentation of how the operator validated, NOT consumed at runtime: `walkProof`, `paginationVerified`, `sortIdJumpVerified`, `wafProbeEvidence` (long-form), `coverageNotes`, `productUrlSchemes.notes`, freeform `notes` strings, anything `<field>Verified` or `<field>Evidence` blocks.

Pre-bootstrap **only** produces runtime fields (plus a small `wafProbeEvidence` summary and optional `auditNotes`). Don't try to reproduce `walkProof` etc. — those are operator-added during review.

### Rule C — `catalogUrls` = top-level category list, NOT a single all-products mega-URL

`catalogUrls` MUST cover **100% of the site's products with minimum overlap**. The shape of the right answer is **one URL per top-level category** (e.g. `/firearms/...`, `/ammunition/...`, ...). NOT a single all-products convenience aggregator URL — those overlap entirely with the per-category list and the per-category list is what production crawl operations need.

Constraints:
- Discovery method is flexible (taxonomy API, nav crawl, sitemap, view-all probes — combine as needed).
- Two hard constraints: efficient (don't probe needlessly) AND non-banning (≥800ms inter-request delay, no parallel hammering, standard browser UA).
- NEVER drop a category for being "too small" — even 1-product categories matter.
- Verify coverage before declaring success: walk-test page-1 of parent vs page-1 of one child if your platform might hide child products on the parent listing.

### Rule D — Validate every stage's output against ground truth before moving on

When running on an existing site (calibration mode), diff each stage's runtime output against the DB `siteProfile` (the answer key) for at least one ground-truth site. `tsc --noEmit` and module smoke tests are necessary but NOT sufficient — they don't catch wrong values. Bugs accumulate fast when validation is deferred.

If pre-bootstrap output ≠ DB on a stage, two possibilities:
1. **DB is stale** — count grew, site migrated, WAF flipped. Check `lastVerified` freshness.
2. **Probe is wrong** — refine the harness, re-run.

Do NOT modify the DB siteProfile to match buggy probe output. The DB is the answer key.

---

## Output target — the formal `siteProfile` shape

Validated by [`backend/src/services/profile-validator.ts:43-80`](../../../backend/src/services/profile-validator.ts). 9 required fields, 7 recommended. Shape (with synthetic illustrative values):

```jsonc
{
  "profileVersion": 1,
  "platform": "<vendor tag — e.g. celerant-coldfusion, woocommerce, shopify, bigcommerce-stencil>",
  "adapterType": "<woocommerce|shopify|generic-retail|classifieds-gunpost|forum-xenforo|forum-vbulletin|auction-hibid|auction-icollector|auction-generic|generic>",
  "hasWaf": <boolean>,
  "wafType": "<cloudflare-passive|cloudflare-active|sucuri|sgcaptcha|incapsula|akamai|malcare|null>",
  "wafLastProbedAt": "<ISO timestamp>",
  "wafProbeMethod": "heavy-8-batch",
  "wafProbeResult": "<one-line verdict>",
  "wafProbeEvidence": { /* heavy-probe excerpt — relevant flags only */ },
  "userAgentOverride": "<UA string or null>",
  "needsPlaywright": <boolean>,
  "expectedProductCount": <positive int>,
  "productCountMethod": "<wp-rest-header|wc-store-api-header|shopify-count-json|shopify-products-walk|ecwid-storefront-search|klevu-api|bc-xmlsitemap|magento-toolbar|celerant-perpage-all|celerant-perpage-all-option|generic-product-sitemap|wix-store-products-sitemap|catalog-walk-only>",
  "catalogUrls": ["<absolute or path URLs that together cover 100% of products with minimum overlap — typically one URL per top-level category>"],
  "extractionTested": true,
  "sortParam": "<query-string fragment, empty string for path-baked, or null>",
  "sortVerified": <boolean>,
  "perPage": <int>,
  "paginationPattern": { "type": "<query|path|offset-query|suffix-replace|api-page|api-offset|null>", "template": "<...{N}...>", "perPage": <int>, "firstPageHasParam": <bool>, "startPage": <int>, "zeroIndexed": <bool> },
  "crawlers": {
    "watermark": { "method": "<api-date-since-watermark|navigate-from-watermark|full-catalog-sweep>", "reason": "<REQUIRED if full-catalog-sweep>" },
    "bootstrap": { "apiEndpoints": { /* adapter-specific */ } }
  },
  "topLevelCategories": { /* OPTIONAL but recommended — operator-curated catalog URL list documentation: { categories: [{slug, allOption}], source, totalsSumCheck } */ },
  "lastVerified": "<ISO date>",
  "auditNotes": { /* OPTIONAL — runId, fieldConfidence map, watchdogPriorVerdict if known */ }
}
```

---

## Stage-by-stage harness

For each pre-bootstrap field below: **what to fetch**, **what to look for**, **how to decide**, **what to record**, **anti-patterns**. Helper scripts you can call are listed at the bottom of each stage.

Order matters — later stages depend on earlier outputs. Each stage produces 1+ `siteProfile` field.

### Stage 1 — Canonical URL

**Output fields:** the canonical origin used by all later fetches. NOT a siteProfile field directly, but every subsequent URL builds from it.

**Action:** Resolve apex vs www. Try the input host first. If it returns 200 cleanly, that's the canonical. If apex 4xx/redirects/challenges, try www-fallback (`www.<apex>`).

**What to look for:**
- HTTP status (200 = good; 301/302 = follow; 403/503 = challenge; ENOTFOUND = DNS dead)
- Redirect target (apex → www is common; some sites do the reverse)
- Body containing challenge markers: `Just a moment...`, `_cf_chl_opt`, `sucuri_cloudproxy_js`, `<meta http-equiv="refresh"... /.well-known/sgcaptcha/`, `Incapsula incident ID`

**Decision:**
- Both apex and www return 200 cleanly → canonical = apex (preserves user's input intent).
- Apex challenges, www clean → canonical = www.
- Both challenge → record as `hasWaf: true` and continue (Stage 2 will classify).
- Both fail with no body → site dead; abort with FAILURE artifact.

**Record:** `canonicalOrigin = "<protocol>//<host>"` (no trailing slash).

**Anti-patterns:**
- Don't assume www is canonical without testing. Some sites canonicalize on apex.
- Don't follow more than 5 redirects.

**Helper:** [`backend/scripts/probe/access-identity/canonical-host.ts`](../../../backend/scripts/probe/access-identity/canonical-host.ts) — implements this logic. Call its `resolveCanonicalHost()` if you want a deterministic shortcut.

---

### Stage 2 — WAF Probe + Workaround

**Output fields:** `hasWaf`, `wafType`, `wafLastProbedAt`, `wafProbeMethod`, `wafProbeResult`, `wafProbeEvidence`, plus `userAgentOverride` and `needsPlaywright` (set later if WAF requires them).

**Action:** Run the 8-batch heavy probe — single-GET fingerprint, multi-UA, rapid burst, honeypot paths, suspicious-fingerprint, SQLi-shaped query, XSS-shaped query, no-UA. Each batch tests one signal. **Ships with this skill:** [`./heavy-waf-probe.sh`](./heavy-waf-probe.sh) — invoke as `bash <skill-dir>/heavy-waf-probe.sh <url>`. Generic — works for any site, any platform.

**What to look for:**
| Signal | Indicates |
|---|---|
| `cf-ray` header present (any batch) | Cloudflare (passive if all 200; active if any challenges) |
| `x-sucuri-id` header / `sucuri_cloudproxy_js` body | Sucuri |
| `_cf_chl_opt` body | Cloudflare active challenge |
| `<meta refresh ... /.well-known/sgcaptcha/` body | SiteGround sgcaptcha (Mistake 30) |
| `Incapsula incident ID` body | Incapsula |
| `MalCare WordPress Security Plugin` body | MalCare |
| `server: AkamaiGHost` header | Akamai |
| Rapid burst returns 429/503 | rate-limit |
| Honeypot paths (`/wp-admin`, `/.env`, `/.git/config`) → 403 but `/` → 200 | path-selective |
| SQLi/XSS payloads → 403 but normal `/` → 200 | rule-selective |
| All batches 200 + consistent timing + no markers above | **No WAF, hasWaf=false (HIGH confidence)** |

**Decision:**
- `cf-ray` AND any 5xx/challenge response → `wafType: 'cloudflare-active'` → set `userAgentOverride: <iPhone Safari>`, `needsPlaywright: true`.
- `cf-ray` AND all 200 → `wafType: 'cloudflare-passive'`.
- Sucuri / sgcaptcha / Incapsula → `userAgentOverride: <iPhone Safari>`, `needsPlaywright: true` (Mistake 30 Fix B for sgcaptcha; same UA helps the others).
- All 200, no markers → `hasWaf: false`, `wafType: null`.

**Record:**
- `hasWaf` is a DB COLUMN, not just a JSON field — production scheduler reads `site.hasWaf` at [`crawl-scheduler.ts:209,282,576`](../../../backend/src/services/crawl-scheduler.ts). The candidate JSON sets the JSON field; whoever promotes to DB also sets the column.
- `wafProbeMethod: 'heavy-8-batch'`, `wafProbeResult` = one-line summary.
- `wafProbeEvidence` = small subset (cfHeaders array, sucuriHeaders array, rapidBurstStatus, sqliRuleFired, xssRuleFired, honeypotPathsBlocked, botUaBlocked) — NOT the full 30KB body.

**Anti-patterns:**
- Don't rely on a single GET — Cloudflare-passive looks identical to no-WAF on one request. The 8-batch probe is mandatory (Mistake 23).
- Don't trust stored `wafType` from prior audits — re-classify every time (Mistake 35).

**Helpers:**
- [`./heavy-waf-probe.sh`](./heavy-waf-probe.sh) — ships with this skill, the 8-batch shell script.
- [`backend/scripts/probe/access-identity/waf-detect.ts`](../../../backend/scripts/probe/access-identity/waf-detect.ts) — classifier that consumes the shell output.

---

### Stage 3 — Platform Identification

**Output fields:** `platform`, `adapterType`, `needsPlaywright` (refined from Stage 2).

**Action:** Fetch the canonical homepage with the right UA (iPhone for sgcaptcha/sucuri/incapsula/cf-active, desktop otherwise). Parse for platform fingerprints — markup signatures, header signatures, cookie signatures, generator meta.

**What to look for (most common platforms):**
| Platform | Signals |
|---|---|
| `woocommerce` | `<meta name="generator" content="WooCommerce ...">`, `wp-content/plugins/woocommerce`, `woocommerce-` CSS classes |
| `shopify` | `Shopify.shop = ` JS var, `cdn.shopify.com`, `shopify-section` divs |
| `bigcommerce-stencil` | `cdn11.bigcommerce.com`, `stencil-` classes, `<meta name="generator" content="Stencil">` |
| `bigcommerce-blueprint` | `cdn11.bigcommerce.com` AND no Stencil markers |
| `magento-2.x` | `Magento_*` Knockout components, `mage-` classes, `<script>require.config` Magento pattern |
| `magento-1.x` | `var Mage = ...`, `var BLANK_URL`, `prototype.js` |
| `drupal-commerce` | `drupal-settings-json` JS, `<body class="...node--type-classified">` for classifieds |
| `opencart` | `<meta name="generator" content="OpenCart">`, `route=common/`, `index.php?route=` |
| `volusion` | `JoinAffiliate`, `Volusion-Pro`, `getEnvironment().volusion` |
| `lightspeed-ecom` | `cdn.shoplightspeed.com`, `lightspeed-`, `data-shop-id` |
| `lightspeed-classic` | `webshopapp.com` cdn, classic Light Speed markers |
| `wix-thunderbolt` | `static.parastorage.com/services/thunderbolt`, `wix-headless` |
| `godaddy-ols` | `data-aid="PRODUCT_LIST_RENDERED"`, `mysimplestore.com` API |
| `ecwid-on-wordpress` | `app.ecwid.com/script.js`, `ec-store` classes, `wp-content/plugins/ecwid-shopping-cart/` |
| `nopcommerce` | `nopCommerce` markers, `Nop.` JS |
| `odoo` | `<meta name="generator" content="Odoo ...">`, `web.assets_common` |
| `hikashop-joomla` | `option=com_hikashop`, Joomla framework markers |
| `celerant-coldfusion` | `Server: Null` header, `CFID` + `CFTOKEN` cookies, `.cfm` URLs, celerant CDN refs |
| `forum-xenforo` | `<meta name="application-name" content="XenForo">`, `data-xf-` attrs |
| `forum-vbulletin` | `vBulletin` markers |

**Decision:** Pick the platform with the strongest signals (multi-marker matches > single-marker). If two platforms both score high (e.g. ecwid plugin on a WP site → both `woocommerce` and `ecwid-on-wordpress` match), prefer the more specific one.

Then map platform → `adapterType`:
| Platform | adapterType |
|---|---|
| woocommerce | `woocommerce` |
| shopify | `shopify` |
| drupal* + classifieds markup | `classifieds-gunpost` |
| forum-xenforo | `forum-xenforo` |
| forum-vbulletin | `forum-vbulletin` |
| auction-hibid / icollector / auction-* | matching adapter |
| Anything else (incl. celerant, magento, opencart, etc.) | `generic-retail` |

**Record:** `platform`, `adapterType`. If the site is a SPA (Wix Thunderbolt, GoDaddy OLS, some custom builds), set `needsPlaywright: true`.

**Anti-patterns:**
- Don't skip cross-checking — Mistake 22 (Odoo with stored "shopify" tag was wrong) and Mistake 39 (theme name ≠ platform name) both came from trusting one signal.
- Don't trust DB-stored `platform` on a re-audit; re-derive from live HTML.

**Helpers:** [`backend/scripts/probe/access-identity/detectors/`](../../../backend/scripts/probe/access-identity/detectors/) — 18 detectors covering the platforms above. Each detector returns `{ detectorId, confidence, signals }`. The composer at [`platform-detect.ts`](../../../backend/scripts/probe/access-identity/platform-detect.ts) picks the highest-confidence match.

---

### Stage 4 — Catalog URL Discovery (THE HARDEST — most session time)

**Output fields:** `catalogUrls`, `topLevelCategories` (recommended).

**Goal:** A list of URLs that **together cover 100% of the site's products with minimum overlap** (Rule C above). The discovery method is flexible (API + nav + view-all + sitemap-derived); two hard constraints — efficient and non-banning.

**The shape of the answer:** **one catalog URL per top-level category** of the site. For the bullseyenorth.com example: `/firearms`, `/ammunition`, `/magazines`, `/storage`, `/reloading`, `/optics`, `/accessories`, `/knives`. NOT a single all-products convenience aggregator URL — those are excluded as overlapping subsets of the per-category list.

**Action — multi-source discovery** (run in parallel where possible, dedupe at the end):

#### 4a — Platform-API discovery (fastest when available)

Try the platform's taxonomy API:
- WooCommerce: `GET /wp-json/wp/v2/product_cat?per_page=100&hide_empty=false` → array of `{ id, slug, count, parent, link }`. Parent IDs let you build the tree; `count > 0` filters empty categories. **DO NOT** drop "small" categories (Mistake 12: even 1-product categories matter for full coverage).
- Shopify: `GET /collections.json?limit=250` → `{ collections: [{ handle, products_count }] }`. Visit each `/collections/<handle>`.
- BigCommerce GraphQL: typically locked behind auth; sitemap is the better source for BC sites.

**For WooCommerce specifically:** parent categories may or may not include their child products (theme-dependent — Minimog themes show subcategory tiles instead of products). Walk-test: page 1 of parent vs page 1 of one child. If child has products NOT in parent, include BOTH parent and child.

#### 4b — Homepage nav crawl (works for everything)

```
GET <canonicalOrigin>/
```

Parse all `<a href>` links from the HTML body. Don't restrict to `<nav>`/`<header>` containers — Celerant and many custom sites put category links in `<div>` containers `<a href>` doesn't restrict to.

Filter the link list:
- **Same hostname** (compare with `www.` stripped — apex-vs-www mismatch silently drops legit links: see this session's fix).
- **Drop nav-utility paths**: `/cart`, `/checkout`, `/account`, `/login`, `/register`, `/contact`, `/about`, `/faq`, `/privacy`, `/terms`, `/shipping`, `/returns`, `/blog`, `/news`, `/search`, `/sitemap`, `/robots`.
- **Drop fragment-only / `mailto:` / `javascript:` / `tel:` / empty hrefs**.
- **Drop product-detail URLs**: paths whose last segment matches `/^-?[a-z0-9][a-z0-9-]*-\d{3,}$/i` (slug-with-numeric-id pattern); paths under `/shop/`, `/product/`, `/products/` with a long slug.
- **Drop filter-subset URLs**: paths containing `/brand/`, `/sale/`, `/clearance/`, `/keyword/`, `/search/`, `/tag/`, `/filter/`.
- **Drop aggregator URLs**: paths starting with `/all-products`, `/shop-all`, `/products-all`, `/everything`, `/full-catalog` — these overlap entirely with the per-category catalog URLs and the operator's chosen output is the per-category list, not the aggregator.

What survives is a candidate list. Categorize by path-segment count: 1-segment paths are top-level candidates, 2-segment paths are subcategory candidates.

#### 4c — Probe each candidate

For each candidate URL:
1. `GET` the URL with the right UA.
2. Run platform-aware extraction ([`generic-retail.ts:extractCatalogProducts`](../../../backend/src/services/scraper/adapters/generic-retail.ts) for everything except classifieds-drupal which has its own extractor).
3. Count products on page 1.

Three outcomes:
- **≥3 products** → productive candidate, keep.
- **0 products + page is full HTML** → tile/landing page (common for Celerant `/firearms`, BC Stencil parent categories). Try platform-specific listing-suffix retries before giving up.
- **0 products + page is small/empty** → not a catalog URL.

**Listing-suffix retries by platform:**
| Platform | Suffix to retry |
|---|---|
| celerant-coldfusion | `/browse/orderby/new-arrivals/perpage/36` (also bake the sort into the catalog URL — Stage 6 will verify) |
| Plain WooCommerce when bare 0-products | `?page=1` (some themes need explicit param), or recurse to children via taxonomy API |
| Plain Shopify | `/collections/<handle>` is already the listing URL; if 0 products, the collection is genuinely empty |

**Anti-pattern:** Don't conclude "no catalog URL" just because the bare nav link returns a tile page. Try the suffix retry first.

#### 4d — Walk + dedupe + minimum-overlap pruning

You have a list of N productive candidates. Walk each one (page 1, 2, 3, … until empty). Maintain a running Set of seen product URLs across ALL walks (deduped). After walking each candidate, record how many NEW products it contributed (NEW = in this candidate but not in the running Set BEFORE it was walked).

After all candidates walked:
- Drop any candidate that contributed **<1% of total NEW unique** — it's a redundant subset.
- Keep at least one candidate (don't return zero — if pruning would remove everything, keep the candidate with the highest total NEW).

That filtered list is `catalogUrls`.

**Order of walking matters.** Walk aggregator-shaped URLs FIRST (anything with `/orderby/`, `/all`, etc.) — but since those are excluded by 4b's filter, you typically end up walking the per-category URLs in any order. The dedup runs across all walks.

#### 4e — Coverage verification

Sum up walked-unique total. Compare to the count from Stage 8 (run Stage 8 first if you haven't — it's typically fast).
- Drift `|walked - count| / count × 100`.
- ≤ 5% → pass.
- > 5% → catalog discovery is incomplete OR count probe is wrong. Investigate. Do NOT soften the gate.

If under-covering, ALSO probe 2-segment subcategory paths (children of the top-level catalog URLs). For Celerant: `/firearms-rifles/browse/perpage/36`, `/storage-rifle-shotgun-cases/browse/perpage/36`, etc. Add productive ones, re-prune, re-verify.

#### 4f — Record

```jsonc
"catalogUrls": ["<absolute or path URL 1>", "<...>"],
"topLevelCategories": {
  "source": "nav | taxonomy-api | sitemap | manual",
  "categories": [
    { "slug": "/firearms", "allOption": 491 },  // count from <select> "All" option or API
    ...
  ],
  "totalsSumCheck": "<arithmetic note: sum of allOption vs all-products count, overlap %>"
}
```

The `topLevelCategories.categories[]` is an OPTIONAL but recommended documentation block — operators use it to confirm the catalog URL list is correct. Even if you collapse `catalogUrls` to a single mega-URL for runtime efficiency on a Celerant-style site, document the per-category catalog URLs here.

#### Anti-patterns (this session's lessons)

- **Don't include `/all-products/...` aggregator URLs in `catalogUrls`.** The user is explicit — those are "stupid URLs". The per-category catalog URL list is the answer.
- **Don't stop at the first viable nav link.** The catalog URLs are the FULL set of top-level categories, not the first match.
- **Don't drop categories for being "too small"** (Mistake 12) — even 1-product categories matter.
- **Don't assume bare paths render product listings.** Celerant tile pages → 0 products extracted; needs `/browse/perpage/N` suffix retry.
- **Don't bias the host filter to apex when nav links use `www.`** (or vice versa) — strip `www.` before comparison.

#### Helpers

- [`backend/scripts/probe/geography-count/sitemap-products.ts`](../../../backend/scripts/probe/geography-count/sitemap-products.ts) — sitemap product-URL extractor (filtered through `NEGATIVE_PATTERNS`). Use to seed the dedup set or as count source.
- [`backend/scripts/probe/geography-count/walk-verify.ts`](../../../backend/scripts/probe/geography-count/walk-verify.ts) — walk-and-dedupe utility. Useful for Stage 4d.
- [`backend/scripts/probe/geography-count/catalog-urls.ts`](../../../backend/scripts/probe/geography-count/catalog-urls.ts) — the deprecated discovery script. Has working logic for taxonomy-API + nav + suffix retry + min-overlap pruning. **Treat as a personal helper — call individual functions, don't run the whole pipeline.**

---

### Stage 5 — Pagination Pattern

**Output field:** `paginationPattern: { type, template, perPage, firstPageHasParam, startPage, zeroIndexed }`.

**Action:** Pick the canonical-sorted catalogUrl as testUrl (one with `/orderby/` in path or `?sort=` in query — that's the operator's runtime choice; perPage from THIS URL is the canonical). Test 3 pagination patterns:

1. `?page={N}` (query, most common)
2. `?p={N}` (alternate query)
3. `/page/{N}` (path-based, Celerant + others)
4. `?offset={N}` (offset-based, less common)
5. LightSpeed: `/page{N}.html?<existing-query>` — `suffix-replace` style (Mistake 26)

For each: fetch page 2, extract products, compare against page 1.
- **Pass (testA: zero overlap)**: page 2 products are all DIFFERENT from page 1 products → pagination works for this pattern.
- **Fail**: page 2 returns same products as page 1, OR returns 0 products → pattern is wrong.

Pick the first passing pattern.

**For path-style pagination on Drupal classifieds:** `0-indexed`, last page has partial items, `firstPageHasParam: false`.

**For LightSpeed (Mistake 26):** `?page=N` is silently ignored. Use `suffix-replace` with the sort baked into both `match` and `template`.

**For Wix (Mistake 27):** `?page=N` on subcategory leaks back to global `/shop`. Use ONLY `/shop` as catalogUrl with `?page=N`.

**For Volusion (Mistake 24):** Pagination requires `?searching=Y` alongside the page param.

**Record:**
```jsonc
"paginationPattern": {
  "type": "query|path|offset-query|suffix-replace|api-page|api-offset|null",
  "template": "page" /* query: param NAME only, NOT '?page={N}' */ | "/page/{N}" /* path */ | "page{N}.html?sort=newest" /* suffix-replace */,
  "perPage": <int from page 1 product count>,
  "firstPageHasParam": <bool>,
  "startPage": 1,
  "zeroIndexed": <bool>
},
"perPage": <same as paginationPattern.perPage>
```

**Mistake 14 reminder:** `{N}` is UPPERCASE. `query.template` stores ONLY the param name (`'page'`, not `'?page={N}'`). `suffix-replace.match` is a literal string (not a regex).

**Anti-patterns:**
- Don't skip the page-1 vs page-2 zero-overlap test. The pattern can SEEM to work because the URL is accepted and returns products — but if those products are the same as page 1, the param is being ignored.
- Don't pick perPage from the highest-product-count URL — pick perPage from the canonical-sorted URL that the operator would use as runtime catalog.

**Helper:** [`backend/scripts/probe/geography-count/pagination-detect.ts`](../../../backend/scripts/probe/geography-count/pagination-detect.ts).

---

### Stage 6 — Sort Parameter Verification

**Output fields:** `sortParam`, `sortVerified`.

**Action:** Find the newest-first sort and prove it's honored.

**Step 6a — Read the `<select>`.** Fetch a catalog page; parse `<select name|id|class *= "sort|order"...>`. Read each `<option value="..." text="...">`. Filter to "newest-style" candidates by matching text/value against `/\b(new|latest|recent|date|created|published|added|posted|pub|newest)\b/i`. Per Mistake 2: NEVER guess param names — read the HTML.

**Step 6b — Detect path-form vs query-form.** If the catalogUrl already contains `/orderby/<value>/` in its path (Celerant pattern, Mistake 36), the site uses **path-form sort**. Otherwise it's **query-form**.

**Step 6c — Build counter-control.** Pick a value from the `<select>` that's clearly NOT newest-style (alpha A-Z, price low-to-high, popularity, etc.). This is the counter-control to prove the sort is honored.

**Step 6d — Fire the 3-outcome test (Mistake 29):**
- Fetch default URL → record first 3 product slugs (`defaultFirst3`).
- Fetch URL with newest candidate → record `sortedFirst3`.
- Fetch URL with counter-control → record `counterFirst3`.

| Outcome | Verdict | sortParam |
|---|---|---|
| `sortedFirst3 != defaultFirst3` | **honored** | the candidate (e.g. `?orderby=date`) |
| `sortedFirst3 == defaultFirst3` AND `counterFirst3 != defaultFirst3` | **honored-default-is-newest** (default IS sorted) | the candidate |
| `sortedFirst3 == defaultFirst3` AND `counterFirst3 == defaultFirst3` | **noop** (sort not honored) | null |

**For path-form** (Celerant): the URL form is `<base>/orderby/<value>/...`. Build counter-control by SWAPPING the path segment, not by adding a query param. If the swap changes the first product, sort is honored. Record `sortParam: ""` (empty string = path-baked, sortVerified=true).

**For Magento** (Mistake 20): merchant-customizable sort values. Use `<select>.option.value` verbatim — never assume `created_at`.

**For OpenCart** (Mistake 21): the visible `<select>` is incomplete. Also probe `?sort=p.date_added&order=DESC` and `?sort=p.product_id&order=DESC` directly.

**For Searchspring** (Mistake 25): real sort lives in URL hash (`#/sort:created_at:desc`). `sortParam: ""` and bake the hash into `catalogUrls`.

**For Shopify** (Mistake 32): use `published_at`, NOT `created_at`. Test BOTH for monotonicity if confused.

**For BigCommerce Stencil** (Mistake 29): default = "Featured" can equal newest by coincidence → false negative. The counter-control test specifically catches this.

**Record:**
```jsonc
"sortParam": "?orderby=date" | "" | null,
"sortVerified": <bool — true if any of the three "honored" outcomes>
```

**Anti-patterns:**
- Don't claim "no sort possible" because no `<select>` exists (Mistake 18). Cross-reference DOM order against an independent newest-first signal (sitemap lastmod, RSS, recent-product slug).
- Don't apply a query-form sort param to a URL whose path already specifies sort — the query is ignored (this session's Mistake 36 manifestation).

**Helper:** [`backend/scripts/probe/navigation/sort-detect.ts`](../../../backend/scripts/probe/navigation/sort-detect.ts) — has both query-form and path-form (Celerant) detection paths.

---

### Stage 7 — Watermark Method

**Output field:** `crawlers.watermark.method`, `crawlers.watermark.reason` (required when `full-catalog-sweep`).

Three methods, in priority order:

#### Method A — `api-date-since-watermark`

Use when the platform's API supports a `date filter` (return only products created after a given timestamp).

Probes:
- **WooCommerce two-probe**: GET `<base>/wp-json/wp/v2/product?after=2099-01-01T00:00:00&per_page=1` (impossible future date) — expect `x-wp-total: 0`. THEN GET `<base>/wp-json/wp/v2/product?after=1999-01-01T00:00:00&per_page=1` — expect `x-wp-total ≈ globalProductCount`. Both must succeed for the filter to be considered honored.
- **Shopify**: GET `<base>/products.json?limit=3` — check that `published_at` exists on each product. If yes → Shopify uses `published_at` filter (Mistake 32).
- **WC Store API**: similar two-probe on `/wp-json/wc/store/v1/products?after=...`.

If filter honored → `method: 'api-date-since-watermark'`. Done.

#### Method B — `navigate-from-watermark`

Use when newest-first sort is verifiable AND a date source exists on the listing.

Triggers:
- **Stage 6 verdict** = `honored` or `honored-default-is-newest` (sort works).
- **Listing has a date source**: schema.org `datePublished`, posted-date class, or a clearly-numeric monotonic `sourceId` (auto-increment IDs).

For path-baked sort (`sortParam: ""`): Stage 6's counter-control swap already proved the sort is honored. No further date verification needed. Use `method: 'navigate-from-watermark'` with reason "Path-baked sort verified upstream via /orderby/<value>/ swap counter-control".

#### Method C — `full-catalog-sweep`

Fallback when neither API filter nor sort+date works.

Required: `reason` field explaining WHY (e.g. "No API date filter; <select> shows no newest-style options; DOM order doesn't match any independent newest-first signal").

**Anti-pattern:** Don't fall to Method C just because Method A failed. Try Method B first. Method C is the last resort.

**Helper:** [`backend/scripts/probe/navigation/watermark-method.ts`](../../../backend/scripts/probe/navigation/watermark-method.ts) — implements the A → B → C cascade.

---

### Stage 8 — Product Count

**Output fields:** `expectedProductCount`, `productCountMethod`.

Priority order (use the first that works):

| Order | Method | Source |
|---|---|---|
| 1 | `wc-store-api-header` | WC Store API: `GET /wp-json/wc/store/v1/products?per_page=1` — read `x-wp-total` header. Customer-visible only (not draft/hidden). Preferred for WC over WP REST. |
| 2 | `wp-rest-header` | WP REST fallback: `GET /wp-json/wp/v2/product?per_page=1` — read `x-wp-total`. Includes drafts/hidden — may overshoot. |
| 3 | `shopify-products-walk` | Shopify: walk `/products.json?limit=250&page=N` until empty; sum lengths. Most accurate. |
| 4 | `shopify-count-json` | Shopify Admin fallback: `GET /products/count.json` — usually 401, fallback to walk. |
| 5 | `ecwid-storefront-search` | Ecwid: `POST <ecwid-storefront-api>/catalog/search` body `{lang:'en', pagination:{offset:0,limit:1}}` — read `totalProductsCount`. |
| 6 | `klevu-api` | Klevu (rare): probe Klevu search API for total. |
| 7 | `bc-xmlsitemap` | BigCommerce: `/xmlsitemap.php` total count. |
| 8 | `magento-toolbar` | Magento: parse the toolbar `<p class="toolbar-amount">` for "X items". |
| 9 | `celerant-perpage-all-option` | Celerant: extract `<option value="N" ...>All</option>` from `<select id="perpage">` on a category page. **Canonical** — reflects active storefront-visible inventory. (`celerant-perpage-all` is the legacy label for the same source.) |
| 10 | `generic-product-sitemap` | Generic: count product URLs in `/sitemap.xml` after filtering through `NEGATIVE_PATTERNS`. |
| 11 | `wix-store-products-sitemap` | Wix-specific sitemap label. |
| 12 | `catalog-walk-only` | Last resort: total unique products from Stage 4d walk. |

**Anti-patterns:**
- Don't trust stored `expectedProductCount` from a prior audit (Mistake 13). Always re-derive.
- Don't use raw `<loc>` count from sitemap (Mistake 1). Filter through the product-URL pattern set.
- For Celerant: don't use `/perpage/9999` raw dump as canonical — the `<option>All</option>` value is the correct source. The dump includes special-order items the storefront hides.

**Reconcile after walking** (Mistake 36 cap detection): if `Stage 4d walked count > Stage 8 probe count × 1.05`, the probe under-counted (e.g. Celerant /perpage/9999 caps at some N). Replace `expectedProductCount` with the walked count and set `productCountMethod: 'catalog-walk-only'`.

**Helper:** [`backend/scripts/probe/geography-count/global-count.ts`](../../../backend/scripts/probe/geography-count/global-count.ts) — implements all 12 methods.

---

### Stage 9 — Final Assembly + Validator + Output

**Action:**

1. Assemble the candidate JSON in the shape from "Output target" above.
2. Set `lastVerified` to today's date (ISO `YYYY-MM-DD`).
3. Set `profileVersion: 1`.
4. Run the validator:
   ```typescript
   import { validateSiteProfile } from 'backend/src/services/profile-validator';
   const result = validateSiteProfile(profile);
   if (!result.valid) { /* result.failed lists required failures — STOP, fix, re-validate */ }
   ```
5. Write the candidate to disk:
   ```javascript
   const ts = new Date().toISOString().replace(/[:.]/g, '-');
   const domain = '<canonical domain>';
   fs.writeFileSync(`docs/site-audit/${domain}-${ts}.json`, JSON.stringify(profile, null, 2));
   fs.writeFileSync(`docs/site-audit/${domain}-${ts}-evidence.json`, JSON.stringify(rawEvidence, null, 2));
   ```
6. Print the path and the next-step pointer:
   ```
   Candidate: docs/site-audit/<domain>-<ts>.json
   Run review pipeline: npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/<domain>-<ts>.json
   ```

**The skill terminates here.** DB writes happen via [`backend/scripts/audit-review-pipeline.ts`](../../../backend/scripts/audit-review-pipeline.ts) (5-stage gate) + [`backend/scripts/enable-new-site.ts`](../../../backend/scripts/enable-new-site.ts) (DB insert) — operator runs both, AI does not.

---

## Calibration mode (running pre-bootstrap on an EXISTING site)

When the input domain already has a `MonitoredSite` row in DB, treat the run as **calibration**, NOT remediation. Steps:

1. Run the harness as if the site were new — Stages 1–9.
2. Read the existing `siteProfile` JSON from DB:
   ```sql
   SELECT siteProfile FROM "MonitoredSite" WHERE domain = '<domain>';
   ```
   (Helper: `node -e "const{PrismaClient}=require('@prisma/client');..."` from `backend/`.)
3. Diff the candidate's RUNTIME fields (NOT audit-trail residue — Rule B above) against the DB siteProfile:
   - `platform`, `adapterType`, `hasWaf`, `wafType`, `userAgentOverride`, `needsPlaywright`
   - `expectedProductCount`, `productCountMethod`
   - `catalogUrls` ← compare item-by-item to DB's `topLevelCategories.categories[].slug`
   - `paginationPattern`, `perPage`
   - `sortParam`, `sortVerified`
   - `crawlers.watermark.method`
   - `topLevelCategories.categories[].slug` ← documented catalog URL list
4. Any field where probe ≠ DB:
   - **DB might be stale** (count grew, site migrated platforms, WAF flipped). Date-stamp the DB profile via `lastVerified` and check freshness.
   - **Probe might be wrong**. Investigate — refine the harness, re-run.
5. Iterate. Each iteration improves the harness, not the candidate. The harness IS the deliverable; the candidate is a calibration artifact.

**Do NOT promote calibration output to DB.** That's a remediation flow, separate from this skill.

**Tier-1 ground-truth sites (canonical calibration targets):**
- canadafirstammo.ca — WooCommerce + Cloudflare passive
- aagcanada.ca — Shopify + Cloudflare passive
- theammosource.com — BC Stencil + Cloudflare passive
- bullseyenorth.com — Celerant ColdFusion + no WAF
- gunpost.ca — Drupal classifieds + Cloudflare active

---

## Anti-patterns (lessons from this session and prior incidents)

1. **Don't include `/all-products/...` aggregator URLs in `catalogUrls`.** The operator chose the per-category catalog URL list; aggregators overlap entirely.
2. **Don't trust DB-stored fields on re-audit.** Re-derive every runtime field from live HTML. DB might be 20+ days stale.
3. **Don't conflate "I ran walk-verify" with "I personally checked each page".** Walk-verify is a deduplication helper; it doesn't validate that products are real or that the URL matches the operator's intent. Cross-check key claims against the live site directly.
4. **Don't stop at the first viable nav match.** The catalog URLs are the FULL set of top-level categories.
5. **Don't drop categories for being "too small"** (Mistake 12). 1-product categories matter.
6. **Don't bias the host filter to apex when nav links are absolute www** (or vice versa). Strip `www.` before comparison.
7. **Don't skip the Stage 5 page-1 vs page-2 zero-overlap test.** A pagination URL being accepted ≠ pagination being honored.
8. **Don't apply query-form sort to a URL whose path already specifies sort.** Path-form (Celerant `/orderby/<value>/`) and query-form (`?orderby=<value>`) are mutually exclusive — use the right form.
9. **Don't stop at the first Stage 6 outcome.** Run the 3-outcome test (default + sorted + counter-control) — counter-control catches false negatives where default IS already newest-sorted.
10. **Don't trust `<option>All</option>` vs `/perpage/9999` interchangeably for Celerant.** The select-option value is canonical (storefront-visible); the dump may overshoot (special-order items).
11. **Don't write to DB.** Pre-bootstrap produces a candidate. Promotion is a separate operator-gated step.

---

## Lessons reference (cross-referenced from Stage anti-patterns)

These 38 lessons were extracted from real onboarding incidents across 60+ retail sites. Each numbered entry is cross-referenced from its relevant Stage above (e.g. "Mistake 36" inside Stage 6 means "see lesson 36 below"). The numbers are internal to this skill — they don't reference any external file. If you adopt this skill for a different project, the numbering still works.

| # | Mistake | One-line rule |
|---|---|---|
| 1 | Sitemap `<loc>` blind count | Filter to product URLs only — raw `<loc>` count over-counts (categories, feeds, nav). |
| 2 | Guessing sort param names | Read `<select>`'s `name` attr + `<option>`'s `value` verbatim; never guess. |
| 3 | Stale `wafType` from notes | Re-verify every re-audit via heavy 8-batch probe; don't trust stored tags. |
| 4 | Dismissing categories by name | Never drop a category by name without product keyword search. |
| 5 | Missing product categories | Start from taxonomy tree / sitemap, not guesswork. |
| 6 | Skipping retry on intermittent servers | Use module retries; don't declare a site dead on first 5xx. |
| 7 | "Site is dead" on hard 403 | Try UA ladder (5 UAs); use Playwright when needed before giving up. |
| 8 | Guessing page-1 = newest | Require sort verdict `honored` + zero-overlap pagination test before `navigate-from-watermark`. |
| 9 | catalogUrls treated as HTML fallback only | API-first sites still need catalogUrls — they're the runtime crawl path. |
| 10 | Hardcoding rotatable keys (Klevu etc.) | Self-heal extraction from HTML, not stored API keys. |
| 11 | Inheriting previous agent's diagnosis | Verify against live HTML; don't carry forward unverified claims. |
| 12 | Dropping a category by name | Walk + filter + check uniqueness before dropping anything. |
| 13 | Stored `expectedProductCount` | Always re-derive; never trust the stored value on re-audit. |
| 14 | Pagination template format | `{N}` UPPERCASE; `query.template` stores param NAME only (`'page'`, not `'?page={N}'`); `suffix-replace.match` is literal string. |
| 15 | Client-side-paginated single page | jPages/bootpag detected → `paginationPattern.type: null`. |
| 16 | AJAX rabbit holes | Plain GET first; don't chase embedded XHR endpoints. |
| 17 | Cursor not exposed | Cursor field must live in URL/HTML/API response — if hidden, can't paginate. |
| 18 | "No sort UI" ≠ "no sort possible" | Cross-reference DOM order against independent newest-first signal (sitemap lastmod, RSS, recent product). |
| 19 | SPA without Playwright test | Set `needsPlaywright: true`; production fallback auto-fires when static HTML >5KB returns 0 products. |
| 20 | Magento merchant-custom sort values | Read `<select>.option.value` verbatim — never assume `created_at`. |
| 21 | OpenCart hidden `p.date_added` | Visible `<select>` is incomplete; ALSO probe `?sort=p.date_added&order=DESC` directly. |
| 22 | Odoo generator meta + stored tags | Cross-check `<meta name="generator">` + multi-marker before trusting stored `platform`. |
| 23 | `hasWaf: false` from single 200 | Heavy 8-batch probe is mandatory — Cloudflare-passive looks identical to no-WAF on one request. |
| 24 | Volusion `searching=Y` | Required in URL alongside sort + pagination; site silently ignores otherwise. |
| 25 | Searchspring hash fragment | Real sort lives in URL hash (`#/sort:created_at:desc`) — not a query param. Bake into catalogUrl, `sortParam: ""`. |
| 26 | LightSpeed `?page=N` silent ignore | Use `suffix-replace` with sort baked into both `match` and `template` (e.g. `match: '?sort=newest', template: 'page{N}.html?sort=newest'`). |
| 27 | Wix sub-category leak | Sub-cat pagination leaks back to global `/shop` — use ONLY `/shop` as catalogUrl. |
| 28 | DB=0 stale-signal cascade | Re-verify EVERY stored field — platform, WAF, notes, sitemap, catalogUrls — when DB shows 0 indexed. |
| 29 | BC Stencil inflation + false-negative sort | Use Set-deduped count (raw page-1 doubles via hidden quick-view); 3-outcome counter-control test catches false-negative sorts. |
| 30 | SiteGround sgcaptcha + iPhone UA | `userAgentOverride` MUST be iPhone Safari; cookie-cache waits for URL to leave challenge path. |
| 31 | Ecwid `sortBy` camelCase | Drive Playwright UI to capture real API field names byte-for-byte; don't guess from public REST docs. |
| 32 | Shopify `published_at` not `created_at` | Use `published_at` for date filtering; test BOTH for monotonicity if confused. |
| 33 | Subagent API claims | Verify with one curl before trusting any subagent's "API returned X" claim. |
| 34 | `apiCrawlUsed` flag | Trace the specific empty-result failure mode at the catalog-crawler integration point. |
| 35 | Stored `wafType: 'sucuri'` | 0/3 verified correct in past audits — treat all stored types as unverified, re-classify. |
| 36 | Celerant malformed headers + path-form sort | `wafWorkaround.method: 'undici-fallback'`; sort is in URL PATH (`/orderby/<value>/`), not query param. Counter-control test = swap path segment. |
| 37 | Drupal classifieds facet trap + sitemap lag | Global URL, bare-form sort param, pagination-walk count (sitemap lags 25%). |
| 38 | JS-challenge WAF + Playwright fallback | Keep WC adapter (runtime `ensureCookies`); `wafWorkaround.method: 'cookie-cache'`; walk past tile-only parent categories. |

---

## Helper script inventory (project-specific examples)

The harness is self-contained — every Stage's instructions are above. Helper scripts are an OPTIONAL convenience: if your project has stable code that already implements the deterministic mechanics (8-batch WAF probe, platform detector composer, sitemap extractor, etc.), you can call them as personal tools. Otherwise drive each Stage by direct fetch.

The reference implementations in THIS project (FirearmAlert) live under `backend/scripts/probe/` — folder names `intake/`, `access-identity/`, `geography-count/`, `navigation/`, `shared/`. There's also a shell script `backend/scripts/heavy-waf-probe.sh` for the 8-batch probe. None of these are required to run the harness; they're reference code your AI can inspect or invoke if useful. **Do not run them as a pipeline** — drive Stage by Stage yourself.

For a NEW project adopting this skill: implement (or skip) helpers as needed. The skill itself depends on no specific files in `backend/`; only on your ability to fetch URLs, parse HTML, and run shell commands.
