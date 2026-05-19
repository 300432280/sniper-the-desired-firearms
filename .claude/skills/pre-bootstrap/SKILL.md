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

### Rule A — Helper-script scratch JSON is NOT the candidate

If discovery uses helper scripts that emit intermediate JSON (e.g. `docs/pre-bootstrap-output/<domain>-profile.json`), that's **scratch / evidence**, NOT the final candidate. The only candidate is the formal JSON written in Stage 9 to `docs/site-audit/<domain>-<ts>.json`. Don't conflate: scratch files contain raw probe output the consumer never reads; the candidate contains only the structured runtime fields the consuming application needs.

### Rule B — Audit-trail residue is NOT a target field

A profile contains TWO kinds of fields:
- **Runtime fields** the consuming application reads at execution time: `platform`, `adapterType`, `hasWaf`, `wafType`, `userAgentOverride`, `needsPlaywright`, `expectedProductCount`, `productCountMethod`, `catalogUrls`, `paginationPattern`, `perPage`, `sortParam`, `sortVerified`, `crawlers.watermark.method`, `crawlers.maintain.verifyMethod`, `crawlers.maintain.verifyEndpoint`, `lastVerified`, `profileVersion`. (`crawlers.bootstrap.apiEndpoints` is NOT in this list — see "Output target" note: zero runtime consumers; operator documentation only.)
- **Operator audit-trail residue** — documentation of how a human operator validated, NOT consumed at runtime: `walkProof`, `paginationVerified`, `sortIdJumpVerified`, `wafProbeEvidence` (long-form), `coverageNotes`, freeform `notes` strings, anything `<field>Verified` or `<field>Evidence` blocks.

This skill **only** produces runtime fields (plus a small `wafProbeEvidence` summary and optional `auditNotes`). Don't produce `walkProof` etc. — those are operator-added during review of this skill's output, not part of the skill's own deliverable.

### Rule C — `catalogUrls`: minimum URL count for 100% firearm-relevant product coverage

`catalogUrls` MUST cover **100% of the site's firearm-relevant products** using the **smallest number of URLs that achieves full coverage**. Two metrics, both required:
- **Coverage:** every firearm-relevant product the site sells is reachable by walking the URLs in this list.
- **Count:** as few URLs as possible to keep that coverage.

**Each entry is a START URL, not a one-shot fetch.** The runtime crawler treats each catalogUrls entry as a *starting point*: it fetches page 1, then constructs page-2/page-3/... via `paginationPattern` and walks until it runs out of products. So a single URL like `/shop/` may produce hundreds of page fetches behind the scenes; "minimum URL count" is about the number of START points the crawler tracks, not the total HTTP requests. Coverage proof must walk ALL pages of every candidate, then dedup.

**Rule C and `feedback_full_coverage.md` do NOT conflict — both say "firearm-relevant" verbatim.** Rule C above defines coverage as "100% of the site's firearm-relevant products" (see "smallest URL set whose union covers 100% of firearm-relevant products"). The memory file `feedback_full_coverage.md` also says catalogUrls must cover 100% of firearm-relevant products. Same scope, same wording. The skill follows Rule C as written: firearm-relevant inclusion list below, non-firearm-relevant exclusion list below. **Operator override path:** if the operator wants broader scope (e.g. include camping/outdoor for a cross-shop site that sells gun safes ALONGSIDE non-firearm camping gear), the operator documents the broader scope in `auditNotes.scopeOverride` — the skill itself never expands beyond firearm-relevant.

**Scope — firearm-relevant** = anything a firearms buyer might shop for on the site:
- **Include:** firearms (rifles/shotguns/handguns), ammunition, magazines, optics / scopes / mounts / sights, gun parts and accessories, holsters, reloading supplies, gun cleaning, gun-related knives (bayonets etc.), airsoft (firearm-shaped), tactical gear that overlaps gun ownership, ranging supplies, gun safes, hunting supplies that imply firearm use.
- **Exclude:** pure apparel, pure fishing, e-bikes / motorcycles / ATVs, outdoor cooking, industrial metals / soldering / lead-wire (when not gun-cleaning related), pure camping not gun-adjacent, books, toys, beauty/health.
- **Mixed categories** (firearm + non-firearm products in the same listing) → **include**. The firearm products in there must be reachable.

**Decision procedure (apply at end of Stage 4):**
1. Discover every URL the site exposes that returns a paginated product listing (taxonomy API, homepage nav, sitemap-derived, view-all probes).
2. **Walk every candidate URL through every page**, then collect the deduped set of product URLs / product IDs each candidate returns. Not page-1 samples — full walk.
3. Filter out URLs whose entire contents are non-firearm-relevant per the scope above.
4. Pick the **smallest URL set whose union covers 100% of firearm-relevant products**. If one URL like `/collections/all` or `/shop/` reaches 100%, use just that. If only a list of N category URLs reaches 100%, use the list.
5. Record the full per-category breakdown in `topLevelCategories.categories[]` for operator reference, regardless of which URLs ended up in `catalogUrls`.

**Constraints:**
- Discovery method is flexible — combine taxonomy API, nav crawl, sitemap, view-all probes as needed.
- Two hard constraints during discovery: efficient (don't probe needlessly) AND non-banning (≥800ms inter-request delay, no parallel hammering, standard browser UA).
- **NEVER drop a URL for being "too small" or "empty today"** (Mistake 12). A 1-product category may hold the only path to that product. An empty-today category (returns 200 with 0 products) may have products tomorrow.
- **Only drop a URL when proven redundant.** Proof = walk it, walk the rest, compare product-ID sets, confirm 100% of its products appear in the union of the others. "Shares page-1 with another" or "looks aggregator-ish" is NOT proof — most overlap classes only appear past page 1.
- **A 404 URL is dead, not empty.** Remove dead URLs from `catalogUrls`. (A URL that returns 200 with 0 products today is empty, not dead — keep it.)
- **NEVER drop a URL by name pattern** (`/on-sale`, `/clearance`, `/all`, `/collections/all`, etc.). Sometimes the aggregator IS the only 100%-coverage path — see Shopify dept-feed soft-cap in Stage 4.
- Verify coverage before declaring success: walked-unique total of firearm-relevant products must equal the firearm-relevant subset of Stage 8's count (or be within the 5% drift gate).

### Rule D — Validate every stage's output against live evidence

Each stage's output value must be backed by a live probe response captured during that stage's discovery. `tsc --noEmit` and module smoke tests are necessary but NOT sufficient — they don't catch wrong values. Cite the URL fetched, the response excerpt, the count, or the header line that justifies each value. Bugs accumulate fast when validation is deferred.

**Every quantitative claim** (counts, page numbers, perPage caps, "first product slug" comparisons) must be paired with the timestamp + raw response excerpt it came from. Without that pairing, the value cannot be reproduced or audited — and slides toward fabrication.

**Cite the runtime code path** when a value depends on how a consuming application will interpret it (e.g. `productCountMethod` consumed by a switch statement, `paginationPattern.type` consumed by a URL builder). The implementation is the source of truth; if the doc and the code disagree, the code wins.

---

## Output target — the formal `siteProfile` shape

Validated by [`backend/src/services/profile-validator.ts:43-80`](../../../backend/src/services/profile-validator.ts). 9 required fields, 7 recommended.

**Reference filled examples** — every Stage 9 run produces BOTH files in this exact shape:
- [`./example-output.json`](./example-output.json) — the machine-readable candidate JSON. Canonical shape for assembling siteProfile fields.
- [`./example-output.md`](./example-output.md) — the human-readable operator report. **Fixed 9-section format** specified in Stage 9; deviations break operator workflow.

Both files document a Celerant ColdFusion retailer (no WAF, no CAPTCHA, no age-gate, 8 per-category catalogUrls, path-baked sort).

Shape (with synthetic illustrative values):

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
  "wafWorkaround": { /* OPTIONAL — populate ONLY when the site emits malformed HTTP headers that Node-native fetch/axios cannot parse. Example: Celerant ColdFusion emits `X-Frame-Options : SAMEORIGIN` (space before colon). Triggers http-client.ts's curl-spawn fallback. Shape: {method:"curl-spawn", reason:"<one-line reason>"} */ },
  "hasCaptcha": <boolean>,
  "captchaType": "<recaptcha-v2|recaptcha-v3|hcaptcha|cloudflare-turnstile|null>",
  "ageGate": { "detected": <boolean>, "type": "<click-through|date-of-birth|cookie-set|null>", "bypassCookie": "<name=value or null>" },
  "userAgentOverride": "<UA string or null>",
  "needsPlaywright": <boolean>,
  "expectedProductCount": <positive int>,
  "productCountMethod": { /* discriminated-union object — see Stage 8 enum table. e.g. {method:"wp-rest-header", endpoint:"/wp-json/wc/store/v1/products", header:"x-wp-total"} */ },
  "catalogUrls": ["<absolute or path URLs that together cover 100% of products with minimum overlap — typically one URL per top-level category>"],
  "extractionTested": true,
  "sortParam": "<query-string fragment, empty string for path-baked, or null>",
  "sortVerified": <boolean>,
  "perPage": <int>,
  "paginationPattern": { "type": "<query|path|offset-query|suffix-replace|api-page|api-offset|null>", "template": "<...{N}...>", "perPage": <int>, "firstPageHasParam": <bool>, "startPage": <int>, "zeroIndexed": <bool> },
  "crawlers": {
    "watermark": { "method": "<api-date-since-watermark|navigate-from-watermark|full-catalog-sweep>", "reason": "<REQUIRED if full-catalog-sweep>" },
    /* `crawlers.bootstrap.apiEndpoints` REMOVED from required/recommended fields. Repo-wide grep across backend/src, frontend/src, and prisma/ returns zero runtime consumers. This is operator documentation only, not a runtime field. If you want to record the API endpoints used during discovery, put them in `auditNotes.discoveredApiEndpoints` — do NOT emit a `crawlers.bootstrap` block. */
    "maintain": { "verifyMethod": "<store-api|detail-page>", "verifyEndpoint": "<API path or null>" }
  },
  "classifiedRules": { "soldDetection": ["<pattern1>", "..."] },  /* OPTIONAL — only when adapterType = classifieds-* */
  "ecwidStoreId": "<numeric id or null>",  /* OPTIONAL — only when platform = ecwid-* */
  "productUrlSchemes": { /* OPTIONAL — populate when the same product is reachable via two URL forms (Celerant: sitemap form `/<brand>/<slug>-<id>` vs canonical `/shop/<slug>-<id>`). Adapter dedup MUST key on the numeric ID extracted from the URL, NOT the full URL string. Shape: {canonical:"<pattern>", sitemapForm:"<pattern>", joinOn:"numeric-id-suffix"} */ },
  "searchUrl": "<OPTIONAL — keyword-search URL template containing the placeholder `{keyword}` (e.g. '/all-products/browse/keyword/{keyword}'). Runtime callers MUST validate the substituted value is non-empty/non-whitespace before constructing the request; sites that interpret empty `{keyword}` as 'no filter' return the entire catalog (Celerant), triggering notification storms.>",
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
- **`<link rel="canonical" href="...">` in the homepage HTML.** Some sites return 200 on apex without redirecting but declare the canonical host via a `<link>` tag instead. Read this from the same homepage fetch — no extra request needed.

**Decision:**
- Both apex and www return 200 cleanly AND no canonical tag disagrees → canonical = apex (preserves user's input intent).
- Apex 200 BUT `<link rel="canonical">` points to www → canonical = www (the site's own declaration wins over the request host).
- Apex challenges, www clean → canonical = www.
- Both challenge → record as `hasWaf: true` and continue (Stage 2 will classify).
- Both fail with no body → site dead; abort with FAILURE artifact.

**Record:** `canonicalOrigin = "<protocol>//<host>"` (no trailing slash).

**Multilingual site canonical signal — `hreflang="x-default"`.** Bilingual sites (Canadian retailers in EN + FR, multilingual EU sites in DE/FR/IT, etc.) emit `<link rel="alternate" hreflang="x-default" href="...">` plus one `<link rel="alternate" hreflang="<locale>" href="...">` per locale. **`hreflang="x-default"` is the authoritative canonical signal** for the site overall — that URL is what the site declares as the "no locale chosen yet" landing. Use it (preferring it over `<link rel="canonical">` if they disagree). Other locale alternates (e.g. `hreflang="fr-CA"`) are NOT canonical — they are translation variants of the same content. Default the candidate to the x-default origin; document an operator override path in `auditNotes.canonicalLocaleOverride` if the operator wants the crawler to walk a specific locale (e.g. some shops have larger inventory on the FR side; operator chooses).

**Anti-patterns:**
- Don't assume www is canonical without testing. Some sites canonicalize on apex.
- Don't follow more than 5 redirects.
- Don't ignore `<link rel="canonical">` when both apex and www return 200 — the canonical tag is the site's authoritative declaration.

**Helper:** [`backend/scripts/probe/access-identity/canonical-host.ts`](../../../backend/scripts/probe/access-identity/canonical-host.ts) — implements this logic. Call its `resolveCanonicalHost()` if you want a deterministic shortcut.

---

### Stage 2 — WAF + CAPTCHA Probe + Workaround

**Output fields:** `hasWaf`, `wafType`, `wafLastProbedAt`, `wafProbeMethod`, `wafProbeResult`, `wafProbeEvidence`, `hasCaptcha`, `captchaType`, plus `userAgentOverride` and `needsPlaywright` (set later if WAF or CAPTCHA requires them).

**Action:** Run the 8-batch heavy probe — single-GET fingerprint, multi-UA, rapid burst, honeypot paths, suspicious-fingerprint, SQLi-shaped query, XSS-shaped query, no-UA. Each batch tests one signal. **Ships with this skill:** [`./heavy-waf-probe.sh`](./heavy-waf-probe.sh) — invoke as `bash <skill-dir>/heavy-waf-probe.sh <url>`. Generic — works for any site, any platform.

**Header-vs-body distinction (CRITICAL — Mistake 36 was misread).** The Mistake 36 fix narrowed HEADER parsing to BATCH 1 only (to avoid matching the interpretation-guide trailer). It did NOT narrow BODY scanning. Body markers for plugin-level WAFs (MalCare, Wordfence) appear ONLY in 403 response bodies, which fire in BATCHES 4 (rapid burst), 7 (honeypot paths), and 8 (bot UA / no-UA) — not BATCH 1. **Scan ALL 8 batches' response bodies for `MalCare WordPress Security Plugin`, `Wordfence`, `<meta http-equiv="refresh"...sgcaptcha`, `Incapsula incident ID`.** Header-only parse silently misses plugin-level WAFs.

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

**Decision — `hasWaf` is operational, not literal.** Set `hasWaf: true` ONLY when the WAF actively blocks or challenges the crawler. Setting it true has runtime cost: [`catalog-crawler.ts`](../../../backend/src/services/catalog-crawler.ts) drops perPage to 20 and routes through the WAF cookie manager. Cloudflare-passive (cf-ray + all 200 in every probe) does NOT need it.

- `cf-ray` AND any 5xx/challenge response → `hasWaf: true`, `wafType: 'cloudflare-active'`, `userAgentOverride: <iPhone Safari>`, `needsPlaywright: true`.
- Sucuri / sgcaptcha / Incapsula → `hasWaf: true`, `userAgentOverride: <iPhone Safari>`, `needsPlaywright: true` (Mistake 30 Fix B for sgcaptcha; same UA helps the others).
- **MalCare / Wordfence body markers anywhere in batches 2-8** (rapid burst, honeypots, bot UA) → `hasWaf: true`, `wafType: 'malcare'` or `'wordfence'`. Plugin-level WAFs only surface in 403 response bodies — they do not appear in BATCH 1.
- Rapid-burst 429/503 with no CDN headers → `hasWaf: true`, `wafType: 'rule-selective'` (origin rate-limit).
- Honeypot 403 + payload 403 BUT `/` returns 200 AND no CDN headers (LiteSpeed / mod_security pattern) → `hasWaf: false`. This is origin-app filtering, not a CDN WAF. Note in `auditNotes` so the operator knows path-selective filtering exists.
- `cf-ray` AND all 200 AND no plugin markers → `hasWaf: false`, `wafType: 'cloudflare-passive'` (record as informational — Cloudflare is in front but does not actively block; setting `hasWaf: true` would slow the crawler for no reason).
- All 200, no markers → `hasWaf: false`, `wafType: null`.

**CAPTCHA detection (separate from WAF type).** A site can have NO WAF but still gate forms behind a CAPTCHA, OR have a WAF AND a CAPTCHA challenge layer. Classify independently:

| Marker in homepage HTML | captchaType |
|---|---|
| `<script src="...google.com/recaptcha/api.js">` AND no `?render=` param | `recaptcha-v2` |
| `<script src="...google.com/recaptcha/api.js?render=...">` | `recaptcha-v3` |
| `<script src="...hcaptcha.com/1/api.js">` OR `class="h-captcha"` | `hcaptcha` |
| `<script src="...challenges.cloudflare.com/turnstile/...">` OR `class="cf-turnstile"` | `cloudflare-turnstile` |
| None of the above | `null` |

**`hasCaptcha` is operational, not literal.** Set `true` ONLY when the CAPTCHA gates the crawler's product-fetch path. Most firearm sites load reCAPTCHA-v3 site-wide via Contact Form 7 (the script tag appears on every page including the homepage) or only on `/wp-login.php` — neither blocks the catalog crawler. Record `captchaType` as informational, but set `hasCaptcha: false`.

To verify operationally: fetch the crawl paths (homepage, category page, product detail, REST/API endpoints used by the crawler) and check the responses. If they return 200 with product markup and no challenge body / interstitial, the CAPTCHA is NOT gating the crawler — set `hasCaptcha: false`. Script tag presence in HTML is insufficient evidence on its own.

`hasCaptcha` is independent of `hasWaf` — record both. `MonitoredSite.hasCaptcha` is a separate DB column from `hasWaf`.

**Record:**
- `hasWaf` is a DB COLUMN, not just a JSON field — production scheduler reads `site.hasWaf` at [`crawl-scheduler.ts:209,282,576`](../../../backend/src/services/crawl-scheduler.ts). The candidate JSON sets the JSON field; whoever promotes to DB also sets the column.
- `hasCaptcha` is also a DB column (`MonitoredSite.hasCaptcha`). Set it independently of `hasWaf`.
- `wafProbeMethod: 'heavy-8-batch'`, `wafProbeResult` = one-line summary.
- `wafProbeEvidence` = small subset (cfHeaders array, sucuriHeaders array, rapidBurstStatus, sqliRuleFired, xssRuleFired, honeypotPathsBlocked, botUaBlocked) — NOT the full 30KB body.

**Anti-patterns:**
- Don't rely on a single GET — Cloudflare-passive looks identical to no-WAF on one request. The 8-batch probe is mandatory (Mistake 23).
- Don't trust stored `wafType` from prior audits — re-classify every time (Mistake 35).
- Don't conflate CAPTCHA with WAF. A site can be `hasWaf: false` AND `hasCaptcha: true` (login forms gated by reCAPTCHA on otherwise-open catalog pages) or vice versa.

**WAF results are IP-dependent.** Cloudflare and other CDNs maintain per-IP reputation lists. The same probe from two different IPs can return wildly different verdicts: one IP gets blanket 403s ("Sorry, you have been blocked"), another walks the site cleanly. Record the audit IP in `auditNotes.probeIp` (or note it as scratch evidence) and treat the probe result as "from THIS IP". Before the operator promotes the candidate to DB, the WAF section MUST be re-confirmed from the production crawler's IP — otherwise `hasWaf: false` from an unblocked audit IP can wrongly disable WAF handling for a production crawler that IS blocked. When unsure, set `hasWaf: true` defensively and let the operator downgrade after live confirmation.

**`wafType` runtime vs operator-UI usage.** `wafType` is **cosmetic for the crawler runtime** — the only non-`null` runtime read is the presence check at [`profile-validator.ts:122-125`](../../../backend/src/services/profile-validator.ts) ("wafType should be set when hasWaf is true"). The crawler routes on `hasWaf` (boolean) alone, not on `wafType`. **But `wafType` IS consumed by the operator triage UI** at [`frontend/src/app/dashboard/admin/profiles/page.tsx`](../../../frontend/src/app/dashboard/admin/profiles/page.tsx) in 5 places (lines 13, 48, 356, 461, 496) — sort key, column display, sticky-key, diff key. The skill MUST still emit a correct `wafType` value even though runtime ignores it; operator triage depends on it to filter sites by WAF family. Setting it to `null` or wrong (e.g. `"cloudflare"` instead of `"cloudflare-passive"` vs `"cloudflare-active"`) clutters operator workflow.

**Helpers:**
- [`./heavy-waf-probe.sh`](./heavy-waf-probe.sh) — ships with this skill, the 8-batch shell script.
- [`backend/scripts/probe/access-identity/waf-detect.ts`](../../../backend/scripts/probe/access-identity/waf-detect.ts) — classifier that consumes the shell output.

---

### Stage 3 — Platform Identification (with age-gate / login-wall pre-check)

**Output fields:** `platform`, `adapterType`, `needsPlaywright` (refined from Stage 2), `ageGate` ({ detected, type, bypassCookie }).

**Action:** Fetch the canonical homepage with the right UA (iPhone for sgcaptcha/sucuri/incapsula/cf-active, desktop otherwise). **Before fingerprinting**, check whether the response is an age-gate / login-wall interstitial — if so, the markup belongs to the gate, not the real site, and platform fingerprinting will fail. Once past the gate, parse for platform fingerprints — markup signatures, header signatures, cookie signatures, generator meta.

**Age-gate / login-wall pre-check.** Common in firearm-adjacent retail. Detect before fingerprinting:

| Marker in response | Age-gate type | Bypass |
|---|---|---|
| `<button>I am 18 or older</button>` / `data-age-confirm` / "Are you of legal age" | `click-through` | POST or click-through sets a cookie like `age_verified=1`, `agegate=true`, `age_confirmed=yes`. Re-fetch homepage with that cookie. |
| `<form>` with `<input name="dob">` or 3 date selects requiring birthdate | `date-of-birth` | Submit a 1980-01-01 birthdate; capture the `Set-Cookie` response; re-fetch with cookie. |
| Response sets `age_verified=` / `agegate=` / `dob_verified=` cookie on first GET (no form needed) | `cookie-set` | Already bypassed — extract the cookie from Set-Cookie and use for all later fetches. |
| Login wall: `<form action="/login">` is the ENTIRE body (page < 5KB, has `password` input, no product markup) | n/a (mark in `notes`, not `ageGate`) | Cannot bypass without credentials. Set `requiresAuth: true` on the MonitoredSite row, abort discovery. |

If detected, record `ageGate: { detected: true, type: '...', bypassCookie: 'name=value' }` and use the bypass cookie for **all subsequent stage fetches** (Stages 4–8). If not detected, record `ageGate: { detected: false, type: null, bypassCookie: null }`.

**Anti-pattern:** Don't fingerprint the gate page. A platform detector run on a Shopify-built age-gate interstitial will return Shopify (correctly), but a Drupal site behind a custom age-gate will return wrong markers. Always bypass first, fingerprint second.

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

**Record:** `platform`, `adapterType`. Decide `needsPlaywright` per-site based on whether plain HTTP returns products at runtime:
- Plain HTTP fetch (axios / Node fetch) returns products on the crawl path → `needsPlaywright: false`.
- Plain HTTP returns empty body / 0 products / challenge page on the crawl path → `needsPlaywright: true`.

`needsPlaywright` is a RUNTIME field: does the production catalog crawler need a headless browser to extract products. Even when DISCOVERY uses Playwright (e.g. Ecwid Mistake 31 UI-drive to capture the POST body shape), runtime can still be plain Node if the captured API works at scale — verify with a 50+ sequential-request sustained walk (no rate-limit / IP-block / soft 200-empty responses). SPA detection is a HEURISTIC for "probably needs Playwright" — confirm by actually fetching the crawl path with plain HTTP before setting `true`.

**Derived: maintain-phase verify config.** Once `platform` is known, the maintain-phase verify endpoint is deterministic. Set both fields:

| platform | verifyMethod | verifyEndpoint |
|---|---|---|
| `woocommerce` | `store-api` | `/wp-json/wc/store/v1/products` |
| `shopify` | `detail-page` | null *(Shopify maintain uses Playwright detail-page; Admin API requires auth)* |
| anything else | `detail-page` | null |

```jsonc
"crawlers": {
  "maintain": { "verifyMethod": "store-api", "verifyEndpoint": "/wp-json/wc/store/v1/products" }
}
```

Why set this here: the maintain phase's [worker.ts:tryStoreApiVerify](../../../backend/src/services/worker.ts) reads `siteProfile.crawlers.maintain.verifyMethod` to decide between batch API verification (fast, ~1 req per 10 products) and per-product Playwright (slow). Without this field, the worker logs an error and skips verification entirely.

**Operator-policy tradeoff (REQUIRED — not a silent default):** the choice between `store-api` and any non-`store-api` value has real cost. The skill MUST NOT silently default to `store-api` for WC sites; the operator picks per-site based on whether silent OOS-restock misses are acceptable.

- `verifyMethod: "store-api"` → fast-path via batch API. Prevents wrongful deactivation (the 2026-04-03 incident fix); but if a product transitions to out-of-stock between crawls, the store-api path at [`worker.ts:549`](../../../backend/src/services/worker.ts) unconditionally calls `handledProductIds.push(product.id)` after batch verification, and the early-return at [`worker.ts:711`](../../../backend/src/services/worker.ts) short-circuits before the Playwright fallback for products the API never saw — **OOS-transition / restock detection dies silently for those products**.
- `verifyMethod` non-`store-api` truthy (`detail-page`, `json-ld`, anything else) → routes unconditionally to `verifyProductsViaPlaywright` at [`worker.ts:769`](../../../backend/src/services/worker.ts). Catches OOS transitions and 404 deletions correctly, but slower and costs more tokens.

Skill output MUST surface this choice in `auditNotes.verifyMethodPolicy` (e.g. `"store-api accepted; restock alerts not guaranteed"` or `"detail-page selected; restock alerts required"`) so the operator can confirm the tradeoff before promotion. Do NOT write `verifyMethod: "store-api"` without an explicit policy note.

**Conditional: platform-specific outputs.**

- **If `adapterType` starts with `classifieds-`** (e.g. `classifieds-gunpost`): also output `classifiedRules.soldDetection`. This is a list of regex/literal patterns the stale-detector uses to identify "sold" markers in the detail-page HTML. Discovery method: visit 1-2 sold listings on the site (find them via a "sold archive" link, "Recently Sold" filter, or by clicking through to a product whose listing card shows a SOLD badge), inspect the HTML, record the markers:

  ```jsonc
  "classifiedRules": {
    "soldDetection": [
      "class=field-sold",        // matches class="... field-sold ..."
      "field-sold Yes",          // matches literal "field-sold Yes" in HTML
      "SOLD"                     // case-insensitive literal "SOLD"
    ]
  }
  ```

  Pattern syntax (consumed by [stale-detector.ts:hasSoldIndicators](../../../backend/src/services/stale-detector.ts)):
  - `class=NAME` → matches an HTML class attribute containing `NAME` as a word.
  - Anything else → case-insensitive literal substring match (whitespace-flexible, regex-special-chars escaped).

  Without this field, the stale-detector falls back to generic `class="sold"` matching, which misses site-specific markers.

- **If `platform` matches `ecwid-*`** (e.g. `ecwid-on-wordpress`): output `ecwidStoreId`. Discoverable by reading the homepage's Ecwid bootstrap script (`<script>...ecwid_initial_data...storeId: 12345...</script>`) or from a `data-store-id` attribute on the storefront container. Used by Stage 8's count probe and by the Ecwid storefront API path in maintain.

- **If the site emits malformed HTTP headers that Node-native fetch/axios can't parse** (Celerant ColdFusion's `X-Frame-Options : SAMEORIGIN` is the canonical case): output `wafWorkaround: { method: "curl-spawn", reason: "<one-liner>" }`. Detect via a test fetch — if axios returns `HPE_INVALID_HEADER_TOKEN` / "Parse Error" AND native fetch returns the same, AND curl succeeds, the site needs the curl-spawn fallback in [http-client.ts](../../../backend/src/services/scraper/http-client.ts). Without this field, the production crawler may still work via the existing fallback chain (axios → fetch → curl-spawn), but recording it makes the operator aware and avoids silent latency from chained fallbacks.

- **If the same product is reachable via two URL forms** (Celerant: `/<brand>/<slug>-<id>` sitemap form vs `/shop/<slug>-<id>` canonical form): output `productUrlSchemes: { canonical, sitemapForm, joinOn: "numeric-id-suffix" }`. Discovery method: fetch a single product via each URL form and confirm both return the same product (same title, same price). Without this field, the watermark crawler may double-count products that appear under different forms.

- **If the site has a keyword-search URL** (used by the user-search workflow, NOT the catalog crawler): output `searchUrl` as a template containing the placeholder `{keyword}` (e.g. `/all-products/browse/keyword/{keyword}`). Discovery: open the site's search box, type a known keyword, copy the resulting URL, replace the keyword token with `{keyword}`. **Runtime contract:** any caller substituting `{keyword}` MUST validate the substituted value is non-empty and non-whitespace before issuing the request. Reason: on Celerant (bullseyenorth.com), passing an empty string returns the ENTIRE catalog as "results", which would generate thousands of false-positive notifications. If the site has no public search URL, omit the field entirely — don't invent one.

- **If `platform = "bigcommerce-stencil"` AND the site exposes a Storefront GraphQL token** (`window.GraphQLToken` or a `__BCSF__` global, typically a JWT): record `tokenCacheTtlMs` derived from the JWT's actual claims, NOT a 1h default. Decode the JWT (base64-decode the middle segment), read `eat` (expires-at) and `iat` (issued-at); set `tokenCacheTtlMs = (eat - iat) × 1000` (or `(eat - now) × 1000` if you want safety margin). Observed: oleysarmoury.com ships a 48-hour token (`eat - iat = 172800` → `tokenCacheTtlMs: 172_800_000`); defaulting to 1h means refetching the token 47 times unnecessarily per period. Record under `bigcommerce: { storefrontToken: "<jwt>", tokenCacheTtlMs: <int> }` or similar adapter-specific block.

**URL normalization rule for endpoint fields (apiEndpoint, verifyEndpoint, any `/wp-json/...` path):** strip locale prefixes (`/en/`, `/fr/`, `/en-CA/`, `/fr-CA/`, etc.) from URLs before storing in the candidate JSON. Runtime callers build their endpoint URL via `` `${origin}${endpointPath}` `` where `origin` comes from `new URL(siteUrl).origin` per WHATWG (host + protocol ONLY; pathname is dropped). Example: `https://example.com/en/wp-json/wc/store/v1/products` must be stored as `/wp-json/wc/store/v1/products` — the runtime concatenates `https://example.com` + the stored path, so a stored `/en/wp-json/...` becomes `https://example.com/en/wp-json/...` only by accident (and breaks on any site whose locale prefix isn't `/en/`). Strip the prefix; document the locale in `auditNotes.locale` if relevant.

**Anti-patterns:**
- Don't skip cross-checking — Mistake 22 (Odoo with stored "shopify" tag was wrong) and Mistake 39 (theme name ≠ platform name) both came from trusting one signal.
- Don't trust DB-stored `platform` on a re-audit; re-derive from live HTML.
- Don't omit `crawlers.maintain.verifyMethod` — the worker treats missing as a hard skip, not a default.
- **Use the canonical separator from the table above.** `bigcommerce-stencil` (hyphen), NOT `bigcommerce.stencil` (dot) or `bigcommerce_stencil` (underscore). Same rule for every multi-word platform tag (`celerant-coldfusion`, `lightspeed-ecom`, `forum-xenforo`, etc.) — match the table verbatim. Older DB profiles may use other separators; refresh them on next audit.

**Helpers:** [`backend/scripts/probe/access-identity/detectors/`](../../../backend/scripts/probe/access-identity/detectors/) — 18 detectors covering the platforms above. Each detector returns `{ detectorId, confidence, signals }`. The composer at [`platform-detect.ts`](../../../backend/scripts/probe/access-identity/platform-detect.ts) picks the highest-confidence match.

---

### Stage 4 — Catalog URL Discovery (THE HARDEST — most session time)

**Output fields:** `catalogUrls`, `topLevelCategories` (recommended).

**Goal:** A list of URLs that **together cover 100% of the site's products with minimum overlap** (Rule C above). The discovery method is flexible (API + nav + view-all + sitemap-derived); two hard constraints — efficient and non-banning.

**The shape of the answer:** **one catalog URL per top-level category** of the site (e.g. for a firearms retailer: `/firearms`, `/ammunition`, `/magazines`, `/optics`, `/accessories`, `/knives`, etc. — whatever the site's actual top-level categories are). NOT a single all-products convenience aggregator URL — those are excluded as overlapping subsets of the per-category list.

**Action — multi-source discovery** (run in parallel where possible, dedupe at the end):

#### 4a — Platform-API discovery (fastest when available)

Try the platform's taxonomy API:
- WooCommerce: `GET /wp-json/wp/v2/product_cat?per_page=100&hide_empty=false` → array of `{ id, slug, count, parent, link }`. Parent IDs let you build the tree; `count > 0` filters empty categories. **DO NOT** drop "small" categories (Mistake 12: even 1-product categories matter for full coverage).
- Shopify: `GET /collections.json?limit=250` → `{ collections: [{ handle, products_count }] }`. Visit each `/collections/<handle>`.
- BigCommerce GraphQL: typically locked behind auth; sitemap is the better source for BC sites.

**For WooCommerce specifically:** parent categories may or may not include their child products (theme-dependent — Minimog themes show subcategory tiles instead of products). Walk-test: page 1 of parent vs page 1 of one child. If child has products NOT in parent, include BOTH parent and child.

**WC API category-recursion warning (mandatory operator choice):** the two WC REST surfaces treat `category=N` differently and you MUST document which one your candidate's coverage proof used.
- **WC Store API** (`/wp-json/wc/store/v1/products?category=N`) **recurses into subcategories** — `category=N` returns products in N plus every descendant category. One probe covers the whole subtree.
- **WP REST core** (`/wp-json/wp/v2/product?product_cat=N`) **does NOT recurse** — `product_cat=N` returns ONLY products directly tagged with that exact term ID. Each subcategory must be probed independently.

The coverage gap is dramatic — observed 19× to ∞ across category subtrees tested (a parent with many subcats and no direct products returns 0 via WP REST but the full subtree count via Store API). If your candidate uses WP REST for category coverage AND the site has nested category trees, you MUST enumerate every leaf category, not just top-level parents. Document the chosen surface in `auditNotes.wcCategoryApi` (`"store-api"` or `"wp-rest-core"`) so the operator can confirm the coverage proof was built against the right surface.

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
- **Do NOT drop aggregator URLs by name.** `/all-products`, `/collections/all`, `/shop/`, `/everything`, etc. sometimes ARE the only 100%-coverage path (Shopify dept-feed soft-cap, Mistake 26 LightSpeed quirks, etc. — see 4h below). Discovery includes them; the walk-and-dedup result in 4d/4e decides whether to keep them.

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

#### 4d — Full walk + ID-level dedup (MANDATORY)

Page-1 samples are a hint, not proof. To know whether a candidate is redundant or covers unique products, **walk every page** of every candidate and compare by **product ID** (not slug, not first-3 products).

Steps:
1. For each candidate URL, walk page-by-page until the listing is exhausted (no products / 404 / last-page). Use the canonical UA + Stage 3 bypass cookie if applicable. Honor 800ms inter-request delay.
2. Collect the full set of product IDs (or canonical product URLs if IDs aren't exposed in the listing).
3. Per candidate, record the dedup'd ID set and its size.
4. Compute union across all candidates — that's the achievable coverage.
5. **Decide which candidates to drop using the union test:**
   - A candidate is **redundant** ONLY if walking it adds zero unique product IDs to the union of the others — i.e. every product it returns also appears in another URL on the list. Drop it.
   - A candidate that contributes even 1 unique product → KEEP it.
   - A candidate that returns 0 products today → KEEP it (empty ≠ dead; may have products tomorrow). Only drop if it 404s (truly dead).
6. The final list is the smallest URL set whose union equals the achievable coverage.

**Why a full walk is mandatory, not page-1 sampling:** most overlap classes only show up past page 1. Two categories with identical page-1 first products may diverge entirely on page 2+. Two categories with totally different page-1 products may share 99% of their later pages. Page-1 evidence routinely both over-drops (real unique products on page 2+ get discarded) and under-drops (true redundancies persist as "different page 1"). The blind audits on rangeviewsports, doubletapsports, westernmetal, dlaskarms, fulcrum, and groupepronature all got the catalogUrls wrong because they sampled page 1 instead of walking. Don't repeat that mistake.

**Rate-limit budget for the walk:** total fetches ≈ sum-of-pages across all candidates. For a 5000-product site at perPage=100, that's ~50 requests across 10 categories — minutes of audit time. Acceptable cost.

**Stop conditions:**
- Rate-limited / IP-blocked mid-walk → report `inconclusive` for that candidate. Do NOT pick a side from partial data.
- Site has 100k+ products and walking would take hours → walk a representative sample of categories AND use Stage 8's count probe as the ground-truth gate; defer to the 5% drift gate in 4e.

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

#### 4g — Extraction-quality spot-check

Before declaring Stage 4 done, prove the products extracted are *real* products with *useful data*, not noise that happens to look like product cards. Pick **3 random products** from page 1 of one productive catalog URL and verify all four fields populate via the platform's adapter logic:

| Field | Pass criteria |
|---|---|
| `title` | Non-empty string, > 5 chars, looks like a product name (not "Add to Cart" / "View Details" / category name) |
| `url` | Absolute URL on the same canonical host, distinct per product, `GET` returns 200 |
| `price` | Numeric and > 0 (or explicitly null + a `priceVisible: false` reason — some classifieds hide prices) |
| `stockStatus` | One of `'in_stock' \| 'out_of_stock' \| 'unknown'` (unknown is acceptable; missing the field entirely is not) |

**Pass:** all 3 sample products yield all 4 fields → record `extractionTested: true` plus a small evidence sample:

```jsonc
"extractionTested": true,
"extractionSample": [
  { "url": "https://example.com/product/abc-123", "title": "...", "price": 999.00, "stockStatus": "in_stock" },
  { "url": "...", "title": "...", "price": 49.95, "stockStatus": "out_of_stock" },
  { "url": "...", "title": "...", "price": null, "stockStatus": "unknown", "priceVisible": false }
]
```

**Fail:** any sample product missing a field (title empty, price NaN, URL relative or 404, stockStatus undefined) → the adapter is broken or the wrong adapter was picked in Stage 3. Loop back: re-check `adapterType`, re-run the 4c probe with explicit suffix retries, re-spot-check. Do not advance to Stage 5 until extraction passes.

**Anti-patterns:**
- Don't take "≥3 products extract" from Stage 4c as proof of extraction quality — a card might give a title and link but no price/stock, and the crawler will index broken records.
- Don't sample only the first 3 products in DOM order. Pick at random (e.g. positions 1, mid, last on page 1) so non-uniform layouts don't slip through.

#### 4h — Platform-specific catalog quirks (apply when relevant)

These quirks have bitten audits before. If your site matches a platform below, apply the quirk during 4a discovery + 4d walk-and-dedup:

- **Shopify dept-feed soft-cap.** `/collections/<handle>/products.json?limit=250&page=N` walks of department collections silently cap at ~16 pages × 24 ≈ 374 products per collection, **regardless** of the much larger `collection.products_count` metadata returned by `/collections.json`. If `products_count` is significantly larger than your walked count for a collection, the dept feed is incomplete. **The only path that returns 100% coverage is `/collections/all`.** Do NOT filter `/collections/all` out as "an aggregator" — for Shopify sites where dept feeds are soft-capped, it IS the catalog spine. Verify by walking dept feeds vs `/collections/all` and comparing dedup'd ID sets.
- **Shopify `/products.json` ignores `sort_by`.** Whatever value you send for `sort_by` on `/products.json` or `/collections/<slug>/products.json`, the response is published_at-descending by default. Sort is honored on HTML `/collections/<slug>` pages but NOT on the JSON walk. If your crawler walks the JSON for catalog and the HTML for watermark, this is fine — the JSON's natural order IS newest-first.
- **WooCommerce theme NOOP on `?orderby`.** Some WC themes (Shoptimizer is a known example) override the WordPress query loop and silently ignore the `?orderby` query param. The URL accepts the param without error but the response is the default order. Detect via the 3-outcome counter-control test in Stage 6 with a cache-bust nonce: if `default == ?orderby=date == ?orderby=title`, sort is NOOP → set `sortParam: null, sortVerified: false`. The watermark crawler can still find newest products via WP REST `?after=<ISO date>` filter (`crawlers.watermark.method: api-date-since-watermark`).
- **Ecwid `sortBy` body parameter and its quirks.** Sort lives in the POST body, not the URL. Verified values today: `addedTimeDesc` (newest-first; only date sort that works), `priceAsc`, `priceDesc`, `nameAsc`, `nameDesc`. **`addedTimeAsc` returns HTTP 400** (invalid value). **Empty `sortBy` also now returns 400** — the prior "We recommend" merchant-default no longer holds. Drive Playwright UI per Mistake 31 to capture the real POST body — don't guess from public REST docs.
- **Lightspeed eCom catalog URLs can 404 silently.** A category URL that worked yesterday may return 404 today as merchants reorganize. Always confirm each candidate catalogUrl returns 200 + non-empty product markup during 4c probe. Dead URLs (404) get removed; empty URLs (200 + 0 products) get kept.
- **Volusion product slugs are SKU-strings, not digits.** Volusion product URLs are `_p/<SKU>.htm` where `<SKU>` can be alphanumeric (e.g. `_p/dirtnap-22cm-80eldm.htm`, `_p/consign-cafft300wmblk.htm`) — NOT just numeric IDs. Any product-extraction regex MUST accept `_p/[A-Za-z0-9_-]+\.htm` (or broader `_p/[^/]+\.htm`), NOT `_p/\d+\.htm`. A numeric-only regex silently misses every SKU-style product and can falsely conclude "0 novel products" when walking secondary catalog URLs. Same risk on other platforms whose product URLs are slug-based (Shoplightspeed, Magento, Shopify) — always confirm the regex matches a real sample product URL during 4g extraction-quality check.

#### Anti-patterns (this session's lessons)

- **Don't include aggregator URLs unless they add unique product IDs OR are the only 100% path.** The decision is from the walk-and-dedup result, not from URL shape. `/collections/all` on a Shopify site with dept-feed soft-cap is the catalog spine; on a Shopify site without that quirk, it's redundant. Walk, then decide.
- **Don't stop at the first viable nav link.** Walk every productive candidate, ID-dedupe, then pick the minimum-cover set.
- **Don't drop categories for being "too small"** (Mistake 12) — even 1-product categories matter for 100% coverage.
- **Don't drop categories for being "empty today"** — a category returning 200 with 0 products may have products tomorrow. Only remove dead URLs (404).
- **Don't assume bare paths render product listings.** Celerant tile pages → 0 products extracted; needs `/browse/perpage/N` suffix retry.
- **Don't bias the host filter to apex when nav links use `www.`** (or vice versa) — strip `www.` before comparison.
- **Don't decide from page-1 evidence alone.** Page-1 sample is a hint; full walk + ID dedup is proof.
- **Don't claim "0 novel products" without citing the exact regex/selector used to extract product IDs.** A buggy regex (e.g. numeric-only `\d+` on a platform whose product URLs use SKU strings) silently produces false-redundancy verdicts — every product with a non-numeric ID is missed and the URL is wrongly declared redundant. Reproducibility test: paste a sample product URL into the regex and confirm it matches before trusting any "redundant" conclusion.
- **Beware the runtime break-on-zero in HTML catalog walks** ([`catalog-crawler.ts:358`](../../../backend/src/services/catalog-crawler.ts), the `if (products.length === 0) { ... break; }` branch at the non-WAF path around line 458-471). When a WooCommerce parent category renders subcategory tiles instead of products (Astra and Woodmart themes are the canonical example — they swap the loop template at the parent level), the parent URL returns 200 + 0 products and the runtime walker breaks immediately, never falling through to children. Stage 4 must walk every catalogUrl candidate fully and verify it returns actual product cards (not subcategory tiles). If a parent URL returns 0 products with full HTML and visible subcategory tiles, exclude the parent from `catalogUrls` and include the children individually — otherwise the runtime crawl will record the parent as "exhausted at page 1" and miss the entire subtree.

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

**Probe maximum verifiable `perPage` (REQUIRED).** Default page-1 product count is the floor, not the ceiling. Find and verify the highest perPage the site actually honors — fewer requests for the same coverage:

1. **Read the `<select name="limit">` (or equivalent) options** on a catalog page. Common selectors: `<select name="limit">`, `<select id="perpage">`, `<select id="limitsb">`. Record every option value.
2. **If a `<select>` exists:** pick the largest option value. Fetch the catalog URL with `?<param>=<largest>` and **count the products on the rendered page**. If the count equals the requested limit (or natural end-of-category), the limit is honored — record that as `perPage`.
3. **If a `<select>` doesn't exist (no UI control):** probe progressive limits — try `?limit=100`, `?limit=250`, `?limit=500`, `?limit=1000`, `?limit=2500`. Stop when (a) the response truncates (returned count < requested AND not end-of-category), (b) the server returns 4xx/5xx, or (c) latency spikes > 10s. **Use the largest verified value** — no upper cap. If `?limit=2500` returns 2500 cleanly, ship 2500.
4. **NEVER assume.** A `<select>` listing `1000` doesn't mean `?limit=1000` is honored — the server may silently cap at 250. Verify by counting actual products in the response.
5. **On rate-limit / WAF backoff during the probe:** drop to the last verified-clean value. Don't ship a limit the site already pushed back on.

Record both `perPage` and `paginationPattern.perPage` to the verified value. If the canonical-sorted catalogUrl is going to bake in the limit (Celerant-style `/perpage/N` or LightSpeed `?limit=N`), use the same verified value there too.

**Record:**
```jsonc
"paginationPattern": {
  "type": "query|path|offset-query|suffix-replace|api-page|api-offset|null",
  "template": "page" /* query: param NAME only, NOT '?page={N}' */ | "/page/{N}" /* path */ | "page{N}.html?sort=newest" /* suffix-replace */,
  "perPage": <int — verified maximum, NOT page-1 default>,
  "firstPageHasParam": <bool>,
  "startPage": 1,
  "zeroIndexed": <bool>
},
"perPage": <same as paginationPattern.perPage>
```

**Mistake 14 reminder:** `{N}` is UPPERCASE. `query.template` stores ONLY the param name (`'page'`, not `'?page={N}'`). `suffix-replace.match` is a literal string (not a regex).

**Path-template leading-slash validator (MANDATORY for `type: "path"`):** `paginationPattern.template` MUST start with `/` when `type` is `"path"`. The runtime URL builder at [`catalog-crawler.ts:121-125`](../../../backend/src/services/catalog-crawler.ts) strips the baseUrl's trailing slash via `baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl`, then concatenates `template` raw. A template like `"gunspage/{N}"` (no leading slash) produces `https://example.com/categorygunspage/2` (broken, 404). A template like `"/page/{N}"` correctly produces `https://example.com/category/page/2`. Before writing the candidate JSON, assert `paginationPattern.template.startsWith('/')` when `paginationPattern.type === 'path'`; reject and re-discover otherwise.

**Anti-patterns:**
- Don't skip the page-1 vs page-2 zero-overlap test. The pattern can SEEM to work because the URL is accepted and returns products — but if those products are the same as page 1, the param is being ignored.
- **Don't ship the page-1 default as `perPage`.** That's the floor. The skill MUST probe the maximum verifiable limit and ship that — the operator picks the lowest reasonable value at runtime if needed, but baseline is "fewest requests for full coverage."
- **Don't trust the `<select>` option list verbatim.** Always fetch with the chosen value and count products in the response to confirm the server honors it.
- **Any "X is optimal" / "X is faster" claim needs side-by-side timing at scale, not single-request math.** Comparing perPage=100 vs perPage=24 in one fetch and concluding "4× faster" ignores the reason the slow path may exist — rate-limit / IP-block / soft 200-empty kicks in after N requests on the fast path. Run BOTH paths end-to-end (e.g. 20+ pages each) and compare total wall time + product completeness before recommending the higher value.

**Helper:** [`backend/scripts/probe/geography-count/pagination-detect.ts`](../../../backend/scripts/probe/geography-count/pagination-detect.ts).

---

### Stage 6 — Sort Parameter Verification

**Output fields:** `sortParam`, `sortVerified`.

**Action:** Find the newest-first sort and prove it's honored.

**Step 6a — Read the `<select>`.** Fetch a catalog page; parse `<select name|id|class *= "sort|order"...>`. Read each `<option value="..." text="...">`. Filter to "newest-style" candidates by matching text/value against `/\b(new|latest|recent|date|created|published|added|posted|pub|newest)\b/i`. Per Mistake 2: NEVER guess param names — read the HTML.

**Step 6b — Detect path-form vs query-form.** If the catalogUrl already contains `/orderby/<value>/` in its path (Celerant pattern, Mistake 36), the site uses **path-form sort**. Otherwise it's **query-form**.

**Step 6c — Build counter-control.** Pick a value from the `<select>` that's clearly NOT newest-style (alpha A-Z, price low-to-high, popularity, etc.). This is the counter-control to prove the sort is honored.

**Step 6d — Fire the 3-outcome test (Mistake 29), with cache-bust:**

Append `&_=<random>` (or `&t=<timestamp>`) to each URL to defeat CDN / page caches. Without this, three byte-identical cached responses would falsely trigger a NOOP verdict.

- Fetch default URL → record first 3 product slugs (`defaultFirst3`).
- Fetch URL with newest candidate → record `sortedFirst3`.
- Fetch URL with counter-control → record `counterFirst3`.

| Outcome | Verdict | sortParam |
|---|---|---|
| `sortedFirst3 != defaultFirst3` | **honored** | the candidate (e.g. `?orderby=date`) |
| `sortedFirst3 == defaultFirst3` AND `counterFirst3 != defaultFirst3` | **honored-default-is-newest** (default IS sorted) | the candidate |
| `sortedFirst3 == defaultFirst3` AND `counterFirst3 == defaultFirst3` | **noop** (sort not honored — theme/SPA override) | null + `sortVerified: false` |

**NOOP fallback strategy.** When verdict is `noop`, the HTML sort is unusable, but the watermark crawler can still find newest products via an alternative:
- **WooCommerce** → WP REST `?after=<ISO date>` filter usually works even when HTML sort is NOOP. Verify with two-probe: `GET /wp-json/wp/v2/product?after=2099-01-01&per_page=1` should return `x-wp-total: 0`, AND `GET /wp-json/wp/v2/product?after=1999-01-01&per_page=1` should return ≈ global count. If both pass, set `crawlers.watermark.method: api-date-since-watermark`.
- **Shopify** → `/products.json` already returns published_at-descending by default; walk crawler sees newest first without sort. Set `crawlers.watermark.method: navigate-from-watermark`.
- **No working API filter AND no working HTML sort** → `crawlers.watermark.method: full-catalog-sweep` (last resort, requires the `reason` field).

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
- **WooCommerce two-probe**: GET `<base>/wp-json/wp/v2/product?modified_after=2099-01-01T00:00:00&per_page=1` (impossible future date) — expect `x-wp-total: 0`. THEN GET `<base>/wp-json/wp/v2/product?modified_after=1999-01-01T00:00:00&per_page=1` — expect `x-wp-total ≈ globalProductCount`. Both must succeed for the filter to be considered honored. **Use `modified_after`, NOT `after`** — the runtime WC adapter hardcodes `modified_after` at [`woocommerce.ts:337`](../../../backend/src/services/scraper/adapters/woocommerce.ts) to catch restocks/price changes, not just newly-published products. The two params return different result sets (observed: 44× divergence at a 7-day window). Documenting `?after=` in the candidate causes the probe to test one param while the runtime walks another.
- **Shopify**: GET `<base>/products.json?limit=3` — check that `published_at` exists on each product. If yes → Shopify uses `published_at` filter (Mistake 32).
- **WC Store API**: similar two-probe on `/wp-json/wc/store/v1/products?modified_after=...` (same param-name rule as above).

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

`productCountMethod` is a **discriminated-union object** in the siteProfile JSON, NOT a bare string. The runtime switch lives at [`backend/src/services/product-count-probe.ts`](../../../backend/src/services/product-count-probe.ts) and recognizes exactly these 11 methods. Writing a bare string or an unrecognized `method` value silently falls through to `default: return null` — the count probe is disabled for that site.

**Canonical methods (object shape required):**

| Order | `method` | Shape | Source |
|---|---|---|---|
| 1 | `wp-rest-header` | `{method, endpoint, header}` | WordPress REST: `GET <endpoint>?per_page=1` → read `<header>` (typically `x-wp-total`). Use endpoint `/wp-json/wc/store/v1/products` for WC (customer-visible, excludes drafts) or `/wp-json/wp/v2/product` (admin REST, includes drafts). |
| 2 | `json-api-count` | `{method, endpoint, field}` | Generic JSON: `GET <endpoint>` → drill into `<field>` (dot-path) for the count. Use for Searchspring `pagination.totalResults`, Shopify Admin `/products/count.json` (`count`), and similar. |
| 3 | `json-api-length` | `{method, endpoint, field, perPage}` | Single-page array count + page math. Use only when the API returns total via array length × pages, not a total field. |
| 4 | `html-pagination` | `{method, selector, perPage}` | HTML scrape: CSS selector for last-page link, multiply by perPage. Use for Magento toolbar (`<p class="toolbar-amount">`), Celerant `<select id="perpage">` last-option, BC pagination links. |
| 5 | `sitemap` | `{method, url}` | Count `<loc>` entries in one sitemap. Includes OOS / hidden — that's a feature for full-inventory tracking. |
| 6 | `sitemap-index` | `{method, urls: [...]}` | Multi-file sitemap (Magento, BigCommerce). Sum `<loc>` counts across files. |
| 7 | `generic-product-sitemap` | `{method, url, pattern?}` | Sitemap with regex filter on `<loc>` URLs — excludes category/non-product entries. Default pattern: `\.html?(?:$|[?#])`. Use for Magento 1 / Lightspeed eCom where one sitemap mixes URL types. |
| 8 | `shopify-products-walk` | `{method, endpoint?, perPage?, maxPages?}` | Walk `/products.json?limit=250&page=N` until empty; dedup by product `id`; return Set size. Most accurate for Shopify (use this, not `shopify-count-json` which usually 401s). |
| 9 | `ecwid-storefront-search` | `{method, endpoint, field?, lang?}` | Ecwid: `POST <endpoint>` body `{lang:'en', pagination:{offset:0,limit:1}}` → read `<field>` (default `totalProductsCount`). Use for ecwid-on-wordpress. |
| 10 | `klevu-api-count` | `{method, endpoint, apiKey}` | Klevu site-search API total. Rare. |
| 11 | `stream-page-count` | `{method}` (no config) | DB-based: count from `streamState` table. Used by some operator workflows; not typical for pre-bootstrap output. |

**Label-drift quick reference (canonical name on the right):**
| Old label seen in siteProfiles | Canonical method object |
|---|---|
| `"wc-store-api-header"` | `{method:"wp-rest-header", endpoint:"/wp-json/wc/store/v1/products", header:"x-wp-total"}` |
| `"sitemap-filtered"` | `{method:"generic-product-sitemap", url:"<sitemap-url>", pattern?:"<regex>"}` |
| `"api-probe"` / `"searchspring-totalresults"` | `{method:"json-api-count", endpoint:"<full URL>", field:"pagination.totalResults"}` |
| `"ecwid-storefront-api"` | `{method:"ecwid-storefront-search", endpoint:"<full /catalog/search URL>", field:"totalProductsCount", lang:"en"}` |
| `"shopify-products-json-walk"` | `{method:"shopify-products-walk", endpoint:"/products.json", perPage:250}` |
| `"bc-xmlsitemap"` | `{method:"sitemap", url:"/xmlsitemap.php?type=products"}` or `{method:"sitemap-index", urls:[...]}` if multi-page |
| `"magento-toolbar"` | `{method:"html-pagination", selector:"<toolbar selector>", perPage:<int>}` |
| `"celerant-perpage-all-option"` | `{method:"html-pagination", selector:"<perpage select last option>", perPage:1}` |
| `"wix-store-products-sitemap"` | `{method:"sitemap", url:"/store-products-sitemap.xml"}` |
| `"catalog-walk-only"` | Not a runtime method — see "Reconcile after walking" below. Not stored in siteProfile. |

**Priority order (try in order; pick first that works):**
1. Platform's customer-visible total (e.g. WC Store API `wp-rest-header`, Ecwid `ecwid-storefront-search`).
2. Platform's full inventory total (e.g. Shopify `shopify-products-walk`, sitemap variants).
3. HTML pagination scrape (`html-pagination`).
4. Last resort: walk-derived count from Stage 4d (not stored — see below).

**Anti-patterns:**
- Don't trust stored `expectedProductCount` from a prior audit (Mistake 13). Always re-derive.
- Don't write a bare string for `productCountMethod`. The runtime needs an object with `method` plus method-specific config.
- Don't write a method name not in the table above. The `default:` arm silently disables the probe — drift is invisible at runtime.
- **Before claiming any `productCountMethod` value, verify the `method` name exists in the runtime probe code's switch statement** ([`product-count-probe.ts`](../../../backend/src/services/product-count-probe.ts)). The documentation table and the implementation can diverge; the implementation is the source of truth. A method that's in this skill's table but missing from the switch falls through to `default: return null` and silently disables the count probe.
- **Validator gate (MANDATORY before writing Stage 9 output):** reject any `productCountMethod.method` value not in the runtime switch's 11 canonical cases ([`backend/src/services/product-count-probe.ts:148-451`](../../../backend/src/services/product-count-probe.ts)): `wp-rest-header`, `json-api-count`, `json-api-length`, `html-pagination`, `sitemap`, `sitemap-index`, `generic-product-sitemap`, `ecwid-storefront-search`, `shopify-products-walk`, `klevu-api-count`, `stream-page-count`. Any other string lands on `default: return null` (line 446-451) — count probe disabled silently. If your candidate's `productCountMethod.method` is not exactly one of these 11 strings, STOP and fix before Stage 9 assembly.
- Don't use raw `<loc>` count from sitemap (Mistake 1) when the sitemap mixes product and non-product URLs. Use `generic-product-sitemap` with a filter pattern instead.
- For Celerant: don't use `/perpage/9999` raw dump as canonical — the `<option>All</option>` value is the correct source. The dump includes special-order items the storefront hides.
- **Don't downrank a higher-priority method just because the count is higher than your walked count.** Sitemap-based methods include OOS / hidden / non-rendered products by design — that's a feature (back-in-stock alerts, full inventory tracking), not noise. If `sitemap = 16,000` but your category walk only saw 7,000, the sitemap is correct (BC Stencil hides OOS on category pages). Use the sitemap value.
- **Classifieds sticky/promoted listings inflate naive `pages × perPage` math.** Drupal classifieds (gunpost is the canonical case) render N regular listings PLUS K "sticky" or "promoted" listings on every page — and the K sticky listings rotate across pages. Naive count = `lastPage × perPage` triple-counts them. Example: gunpost renders 15 regular + 3 sticky per page; `1680 pages × 18 = 30,240`, but the actual unique listing count is `1680 × 15 + 3 = 25,203` (over-counts by ~5,040). Cross-check `html-pagination` totals against a facet-sum (sum of `?f[0]=c:N` counts across all top-level categories) or a province-sum (sum of `?province=X` counts across all provinces) — both should agree within 1%. If `pages × perPage` is significantly higher than the facet-sum, subtract the sticky multiplier or switch to facet-sum as the canonical count.
- **WC Store API combined stock-filter query syntax (OOS-inclusive totals).** When probing `/wp-json/wc/store/v1/products?per_page=1` for a count that includes both `instock` and `outofstock` rows, use the **bracketed-array syntax** `stock_status[0]=instock&stock_status[1]=outofstock`. WordPress's PHP query handler treats repeated bare keys (`?stock_status=instock&stock_status=outofstock`) as last-write-wins — the second value silently overwrites the first and you get only the OOS count, missing in-stock. The bracketed-array form preserves both values and returns the OOS-inclusive total in `x-wp-total`. If your `expectedProductCount` needs to match the watermark crawler's full-inventory walk (which sees both states), the `wp-rest-header` probe MUST use the bracketed form — store it in `productCountMethod.endpoint` as `/wp-json/wc/store/v1/products?stock_status[0]=instock&stock_status[1]=outofstock`.

**Reconcile after walking** (Mistake 36 cap detection): if `Stage 4d walked count > Stage 8 probe count × 1.05`, the probe under-counted (e.g. Celerant `/perpage/9999` caps at some N). Replace `expectedProductCount` with the walked count and set `productCountMethod: {method:"html-pagination", ...}` reflecting the per-page-derived method (or document as `auditNotes` that the runtime probe is unavailable). **This rule fires ONLY when walk > probe** (probe is short); the inverse (probe > walk because OOS is hidden on category pages) does NOT trigger this rule — keep the probe value.

**WooCommerce `expectedProductCount` source — conditional on which surface the watermark crawler walks:** the two WC REST surfaces return different totals (admin REST includes drafts / private / hidden products; Store API only customer-visible). Pick the count source to match the watermark surface, NOT the other way around — otherwise the 5% drift gate fails and the operator chases a phantom coverage gap.
- If `crawlers.watermark.method = "api-date-since-watermark"` AND the watermark walk uses WP REST core `/wp-json/wp/v2/product`, use the **admin total** as `expectedProductCount` (probe via `wp-rest-header` against `/wp-json/wp/v2/product`).
- If `siteProfile.storeApiOnly = true` (the WC adapter standalone Store API path at [`woocommerce.ts:347-349`](../../../backend/src/services/scraper/adapters/woocommerce.ts) fires when WP REST is 401-gated), use the **customer-visible total** (probe via `wp-rest-header` against `/wp-json/wc/store/v1/products`).
- The two totals can diverge 2.5×–10× on shops with significant draft / private / out-of-stock-hidden inventory. Pick to match the runtime surface; document the choice in `auditNotes.wcCountSurface`.

**Helper:** [`backend/scripts/probe/geography-count/global-count.ts`](../../../backend/scripts/probe/geography-count/global-count.ts) — implements all 12 methods.

---

### Stage 9 — Final Assembly + Validator + Output

**Two deliverables (both REQUIRED, every run):**
1. Machine-readable candidate JSON at `docs/site-audit/<domain>-<ts>.json` — consumed by the audit-review pipeline and (eventually) by the DB promotion script.
2. **Human-readable markdown report** at `docs/site-audit/<domain>-<ts>.md` — operator reads this to review what the skill found. Format is fixed (see below); deviations break operator workflow.

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
5. Write the candidate JSON to disk:
   ```javascript
   const ts = new Date().toISOString().replace(/[:.]/g, '-');
   const domain = '<canonical domain>';
   fs.writeFileSync(`docs/site-audit/${domain}-${ts}.json`, JSON.stringify(profile, null, 2));
   fs.writeFileSync(`docs/site-audit/${domain}-${ts}-evidence.json`, JSON.stringify(rawEvidence, null, 2));
   ```
6. Write the human-readable markdown report to disk at `docs/site-audit/${domain}-${ts}.md` using the **fixed format** specified below.
7. Print the paths and the next-step pointer:
   ```
   Candidate JSON:    docs/site-audit/<domain>-<ts>.json
   Operator report:   docs/site-audit/<domain>-<ts>.md
   Run review pipeline: npx tsx backend/scripts/audit-review-pipeline.ts docs/site-audit/<domain>-<ts>.json
   ```

**The skill terminates here.** DB writes happen via [`backend/scripts/audit-review-pipeline.ts`](../../../backend/scripts/audit-review-pipeline.ts) (5-stage gate) + [`backend/scripts/enable-new-site.ts`](../../../backend/scripts/enable-new-site.ts) (DB insert) — operator runs both, AI does not.

#### Markdown report format (REQUIRED — match this template exactly)

The report has 9 sections in this exact order. **Reference example:** [`./example-output.md`](./example-output.md) — follow that file's structure section-by-section, only swapping in the new site's values.

| # | Section | Contents |
|---|---|---|
| — | **Title + TL;DR blockquote** | `# Pre-Bootstrap Output — <domain>` followed by a `>` blockquote summarizing: result status (ready / blocked), validator pass count, top-line findings (WAF/CAPTCHA/age-gate status, total products, # of categories). |
| 1 | **At a glance** | Two-column table: "What" / "Value". Rows: site platform + adapter, protections summary, catalog size summary, page-walking summary, sort summary, new-item crawl method, maintain verify method. **Bold** the most important values. |
| 2 | **Identity** | Two-column table: `field` / value, for `platform` and `adapterType`. One sentence of prose explaining the platform→adapter choice. |
| 3 | **Access — getting in safely** | Three-column table: `field` / value / meaning. All Stage-2 outputs (`hasWaf`, `wafType`, `wafLastProbedAt`, `wafProbeMethod`, `hasCaptcha`, `captchaType`, `ageGate.detected`, `userAgentOverride`, `needsPlaywright`). Bold key true/false values. End with a `>` blockquote summarizing `wafProbeEvidence` in prose. |
| 4 | **Catalog discovery — where the products are** | Category table (per-category counts + path), prose `totalsSumCheck`, `extractionSample` table (3 products with title/price/stockStatus), and an `extractionTested = true` line. |
| 5 | **Pagination & sort — how to traverse** | Three-column table: `field` / value / meaning. All `paginationPattern.*` fields, `sortParam`, `sortVerified`. End with a `>` blockquote describing how sort was verified (counter-control swap result). |
| 6 | **Inventory size** | Two-column table: `field` / value, for `expectedProductCount` and `productCountMethod`. One `>` blockquote citing the source HTML / API for the count. |
| 7 | **Crawler config — runtime behavior** | Four-column table: Phase / `field` / value / what it means. Rows for `crawlers.watermark.method`, `crawlers.maintain.verifyMethod`, `crawlers.maintain.verifyEndpoint`. **Do NOT include a `crawlers.bootstrap.apiEndpoints` row** — that field is operator documentation only with zero runtime consumers (see Output target note). End with a `>` blockquote quoting the watermark `reason` field. |
| 8 | **Platform extras** | Two-column table listing `classifiedRules` and `ecwidStoreId` with reason omitted (or values when applicable). |
| 9 | **Provenance** | Tables for `profileVersion` / `lastVerified` / `auditNotes.*` metadata, then a `fieldConfidence` table, then a numbered list of all 9 `stageNotes` (one bullet per stage). |

**Format rules:**
- Use markdown tables (`|` syntax) — NOT plain text alignment.
- Wrap field names in backticks: `` `platform` ``, `` `crawlers.watermark.method` ``.
- Wrap string values in backticks: `` `"celerant-coldfusion"` `` or `` `null` ``.
- Bold (`**...**`) the headline value in each section (e.g. **`false`**, **`3,277`**, **`navigate-from-watermark`**).
- Use `>` blockquotes for prose findings (probe evidence, sort verification details, count source).
- Separator (`---`) between every major section.

**Anti-patterns:**
- Don't paraphrase field names. `crawlers.maintain.verifyMethod` stays as `crawlers.maintain.verifyMethod`, not "the maintain phase's verify method."
- Don't skip the `meaning` column in tables that have it — operator relies on it for fields they don't memorize.
- Don't replace tables with bullet lists. Tables enforce alignment of field/value/meaning.
- Don't add sections beyond the 9. The format is fixed so operators can scan-read it across many sites.

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
