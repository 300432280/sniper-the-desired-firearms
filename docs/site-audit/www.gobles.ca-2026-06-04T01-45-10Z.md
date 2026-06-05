# Pre-Bootstrap Output — www.gobles.ca

> **Wave-2 R1 (blind), gentle-WAF-only.** Validator: **22/22 pass, 0 fail, 0 warn**. Lightspeed eCom (shop 619639), static server-rendered HTML, no Playwright needed. Cloudflare **passive** (no challenge). No CAPTCHA, no age-gate. **~3,876 products** (live sitemap). **0%-coverage root cause = the site is parked: `isEnabled=false`, bootstrap never started — NOT a technical blocker.** Catalog is plainly fetchable via plain HTTP.

---

## 1. At a glance

| What | Value |
|---|---|
| Platform / adapter | `lightspeed-ecom` / **`generic-retail`** |
| Protections | hasWaf **`false`** (CF passive), hasCaptcha `false`, ageGate `false` |
| Catalog size | **~3,876** products (sitemap) |
| Page walking | `suffix-replace` `page{N}.html?limit=100&sort=newest`, **perPage 100** |
| Sort | `?sort=newest` — **verified honored** (3-outcome counter-control) |
| New-item crawl | **`navigate-from-watermark`** |
| Maintain verify | `detail-page` (no Store API on Lightspeed) |

---

## 2. Identity

| field | value |
|---|---|
| `platform` | `lightspeed-ecom` |
| `adapterType` | `generic-retail` |

Lightspeed eCom (Shoplightspeed) confirmed via `cdn.shoplightspeed.com` + `webshopapp.com` CDN refs, the `Lightspeed Netherlands B.V.` generator comment, and `.product-element` product cards. Lightspeed has no public catalog API and is handled by the `generic-retail` adapter's `.product-element` selector path — the standard mapping for non-WC/Shopify retail.

---

## 3. Access — getting in safely

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** | Cloudflare in front but passive — cf-ray + `__cf_bm` on all 200s, no challenge |
| `wafType` | `cloudflare-passive` | informational; crawler routes on `hasWaf` only |
| `wafProbeMethod` | `gentle-single-get` | **gentle-only per IP-ban constraint — NOT the 8-batch probe** |
| `hasCaptcha` | `false` | no reCAPTCHA/hCaptcha/Turnstile markers |
| `captchaType` | `null` | — |
| `ageGate.detected` | `false` | no age-gate interstitial |
| `userAgentOverride` | `null` | desktop Chrome UA works |
| `needsPlaywright` | **`false`** | static HTML renders products directly |

> Apex `gobles.ca` 301s to `www.gobles.ca` (canonical tag agrees). All probed pages returned 200 with `server: cloudflare`, `cf-ray` present, `__cf_bm` bot-management cookie set — characteristic of CF passive (present, not blocking). No Sucuri headers, no challenge body. **This was a single-GET gentle probe; rapid-burst / honeypot / multi-UA matrix were NOT run. Operator must re-confirm WAF from the production crawler IP before promotion.**

---

## 4. Catalog discovery — where the products are

**Parent-tile trap (B15) confirmed and NON-UNIFORM on this site:**

| Top category | Parent renders products? | catalogUrls strategy |
|---|---|---|
| `/firearms/` | **NO** (0 via `.product-element`; brand+type tile hub) | use TYPE leaves (centerfire/rimfire/shotguns/combination/muzzleloading/lever-action/surplus/pellet-pal) |
| `/knives/` | **NO** (0; brand tile hub) | use 20 brand leaves |
| `/ammunition/` | YES (24/page + pageN.html) | parent URL directly |
| `/optics/`, `/accessories/`, `/reloading/`, `/field-gear/`, `/maintenance-storage/`, `/excalibur-archery/` | YES | parent URL directly |

`catalogUrls` total: **51 URLs** — 24 firearms type-leaves + 7 product-rendering parents + 20 knives brand-leaves. (`/catalog/` is a brand/category index hub, returns 0 products — NOT a usable view-all aggregator.)

**Extraction sample** (title+url verified live; price/stock are detail-page-level, not captured in R1 listing probe):

| url | title | stockStatus |
|---|---|---|
| `/benelli-lupo-bolt-action-65-creedmoor-24-barrel-sy.html` | Benelli Lupo Bolt Action 6.5 Creedmoor | `unknown` |
| `/browning-a-bolt-stalker-bolt-action-243-win-22-bar.html` | Browning A-Bolt Stalker 243 Win | `unknown` |
| `/cci-22lr-sub-sonic-40gr-clean-22-blue-polycoat-100.html` | CCI 22LR Sub-Sonic 40gr | `unknown` |

`extractionTested = true` (title + absolute url populate; >=24 cards per productive page).

> **catalogUrls coverage/overlap NOT walk-verified (gentle R1).** This candidate switches firearms to the TYPE-leaf tree (vs the DB's brand-leaf list) for minimal overlap. Whether the type-leaf tree reaches 100% of firearms must be walk-and-dedup confirmed by R2/operator before the brand leaves are dropped.

---

## 5. Pagination & sort — how to traverse

| field | value | meaning |
|---|---|---|
| `paginationPattern.type` | `suffix-replace` | Lightspeed `pageN.html`, NOT `?page=N` (Mistake 26) |
| `paginationPattern.template` | `page{N}.html?limit=100&sort=newest` | `rel=next` ignores limit, so bake `?limit=100` into the suffix |
| `perPage` | **`100`** | `?limit=100` returns 100 cards; site caps at 100 (`?limit=250` rejected -> 24 default) |
| `firstPageHasParam` | `true` | page 1 needs `?limit=100&sort=newest` |
| `startPage` / `zeroIndexed` | `1` / `false` | — |
| `sortParam` | `?sort=newest` | |
| `sortVerified` | **`true`** | |

> Sort verified via 3-outcome counter-control on `/firearms/browning/` with cache-bust: `?sort=newest` first4 (Maxus/Silver/BAR semi-autos) != default first4 (A-Bolt rifles); `?sort=name` == default -> default order is by name, `?sort=newest` is honored. Pagination verified: page1 INT page2 = **0 overlap**. NOTE: the wrong param `?order=date` is a NOOP — only `?sort=...` is honored (read the right param, Mistake 2/26).

---

## 6. Inventory size

| field | value |
|---|---|
| `expectedProductCount` | **`3,876`** |
| `productCountMethod` | `{generic-product-sitemap, url:/sitemap.xml, pattern:\.html$}` |

> Live `/sitemap.xml` = 6,500 `<loc>` entries; 3,876 match the flat product form `/<slug>.html` (`\.html$`, `\.html(?:$|[?#])`, and `^/<slug>.html$` all agree on 3,876; zero pageN.html in sitemap). DB's stored `3770`/`3577` are stale (April 2026 snapshot, ~2.8% drift). Re-derived live per Mistake 13.

---

## 7. Crawler config — runtime behavior

| Phase | field | value | what it means |
|---|---|---|---|
| watermark | `crawlers.watermark.method` | `navigate-from-watermark` | sort=newest honored -> walk newest-first |
| maintain | `crawlers.maintain.verifyMethod` | `detail-page` | Lightspeed has no Store API; Playwright detail-page |
| maintain | `crawlers.maintain.verifyEndpoint` | `null` | — |

> Watermark reason: `?sort=newest` honored (3-outcome counter-control) + `pageN.html` suffix pagination (0-overlap) make newest-first navigation viable. `/index.rss` ("New products", 50 items w/ pubDate) is an independent newest-first cross-check.

---

## 8. Platform extras

| field | value |
|---|---|
| `classifiedRules` | n/a (not a classifieds site) |
| `ecwidStoreId` | n/a |
| Lightspeed shop id | `619639` (in `auditNotes.shopId`) |
| `searchUrl` | DB `/search?q={keyword}` — **UNVERIFIED**, needs B3 junk-keyword diff (deferred under gentle constraint) |

---

## 9. Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-06-04` |
| `runId` | `wave2-r1-blind-2026-06-03` |
| prior audits | `www.gobles.ca-2026-05-23T18-00-00Z-B6R1.json`, `...-B6R2.json` |

**fieldConfidence**

| field | confidence |
|---|---|
| platform / adapterType | high |
| hasWaf | medium (gentle probe — re-confirm from prod IP) |
| needsPlaywright | high |
| paginationPattern / perPage | high |
| sortParam / watermarkMethod | high |
| expectedProductCount | high (live sitemap) |
| catalogUrls | medium (per-URL live-gated; coverage/overlap NOT walk-verified) |

**Stage notes**
1. Canonical: apex 301 -> `www.gobles.ca`; canonical tag agrees.
2. WAF: CF passive (gentle single-GET only; 8-batch NOT run per constraint).
3. Platform: `lightspeed-ecom` -> `generic-retail`; static HTML, no age-gate.
4. Catalog: parent-tile trap non-uniform — `/firearms/` & `/knives/` are tile hubs (0 products), 7 other parents render products. 51 catalogUrls.
5. Pagination: `suffix-replace` `pageN.html`; perPage 100 (`?limit=100` honored, caps at 100).
6. Sort: `?sort=newest` verified honored (counter-control); `?order=` is a NOOP.
7. Watermark: `navigate-from-watermark` (sort + pagination both honored).
8. Count: 3,876 via sitemap `\.html$` filter (live).
9. Maintain: `detail-page` (no Lightspeed Store API).

> **0%-coverage diagnosis:** DB `isEnabled=false`, `crawlPhase=bootstrap`, `bootstrapStartedAt=null`, 0 products. The site was **never enabled** — there is no WAF block, no SPA-needs-Playwright, no wrong-host issue. The existing DB profile is sound (correct platform/pagination/sort, uses leaves to dodge tile parents). Secondary issue once enabled: DB catalogUrls had **2 dead (404) knives URLs** (`/knives/browning-4908428/`, `/knives/boker-4908434/`) — fixed in this candidate to `/knives/browning/`, `/knives/boker/`.
