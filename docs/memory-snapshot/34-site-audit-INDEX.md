---
name: 34-site-audit-INDEX
description: Searchable index of 34-site-audit-history.md (5832 lines). Read this FIRST; only read line ranges from the source file when investigating a specific site or pattern. Saves ~50K tokens of upfront reading.
type: reference
originSessionId: 0e25b91d-3faf-45c8-a84d-fc6dca43f333
---
# 34-Site Audit History — Searchable Index

## How to Use

1. **Find your site** in the per-site table → grab its `Lines` range
2. **Read only that range** from `34-site-audit-history.md` via `Read({ file_path, offset, limit })`
3. **For cross-cutting topics** (a Mistake pattern, a WAF type, a platform family) → use the lookup tables below
4. **Per-site summary** here is the 5-line cliff notes; full investigation notes live in the source file

Source file: `C:\Users\TNT\.claude\projects\d--VScode-Projects-firearm-alert\memory\34-site-audit-history.md` (5832 lines).

---

## Per-Site Quick Lookup

| # | Site | Lines | Platform | WAF | Real Count | Pagination | Sort | Watermark |
|---|---|---|---|---|---|---|---|---|
| 1 | alflahertys.com | 118-247 | BC Stencil + Klevu | Sucuri | 5,256 | (Klevu API) | none | full-catalog-sweep |
| 2 | bullseyenorth.com | 248-367 | Celerant ColdFusion | none | 3,059 | path `/page/N` | (no date sort) | full-catalog-sweep |
| 3 | canadasgunstore.ca | 368-547 | Activant/Epicor iNet | none | 2,361 | offset-query `?top=255` | (none works) | full-catalog-sweep |
| 4 | doctordeals.ca | 548-721 | WooCommerce | nginx UA filter | 965 | (WP REST API) | (API date) | api-date-since-watermark |
| 5 | durhamoutdoors.ca | 722-921 | CS-Cart legacy | CF passive | 388 | suffix `-N.html` | `?sortby=4` | navigate-from-watermark |
| 6 | ellwoodepps.com | 922-1082 | Magento 1.x | CF passive | 23,545 | query `?p` | `?dir=desc&order=news_from_date` | navigate-from-watermark |
| 7 | firearmsoutletcanada.com | 1083-1201 | BC Stencil | none | 3,260 | query `?page` perPage=250 | `?sort=newest` | navigate-from-watermark |
| 8 | frontierfirearms.ca | 1202-1364 | **BC Blueprint→Stencil migrated 2026-04-26** | CF passive | 1,286 | query `?page` perPage=40 | `?sort=newest` | navigate-from-watermark |
| 9 | fulcrum-outdoors.shoplightspeed.com | 1365-1510 | LightSpeed eCom | CF passive | 3,631 | suffix `pageN.html` | `?sort=newest` | navigate-from-watermark |
| 10 | g4cgunstore.com | 1511-1652 | WooCommerce | CF passive | 5,741 | path `/page/{N}` | `?orderby=date&order=desc` | api-date-since-watermark |
| 11 | gagnonsports.com | 1653-1817 | **LightSpeed eCom (NOT Classic — corrected 2026-04-26)** | CF passive | 2,613 | suffix `pageN.html` | `?sort=newest` | navigate-from-watermark |
| 12 | gotenda.com | 1818-1921 | WooCommerce | Sucuri | 16,440 | path `/page/{N}` | `?orderby=date&order=desc` | api-date-since-watermark |
| 13 | greatnorthgunco.ca | 1922-2044 | WooCommerce | none | 4,201 | path `/page/{N}` perPage=24 | `?orderby=date` | api-date-since-watermark |
| 14 | irunguns.ca | 2045-2173 | Custom PHP + jPages | Sucuri passive | 84 | **null** (single-page) | none | full-catalog-sweep |
| 15 | jobrookoutdoors.com | 2174-2269 | Shoplightspeed (NOT Shopify) | CF passive | 2,716 | suffix `pageN.html` | `?sort=newest` | navigate-from-watermark |
| 16 | liangjian.ca | 2270-2371 | GoDaddy OLS SPA + mysimplestore | none | 1,911 | query `?page` perPage=15 | `?sortOption=descend_by_created_at` | navigate-from-watermark |
| 17 | lockharttactical.com | 2372-2512 | HikaShop on Joomla | CF passive | 2,460 | offset `?limitstart=N` | (URL `/recent` IS sort) | navigate-from-watermark |
| 18 | londerosports.com | 2513-2654 | Magento 2.x | CF | 1,358 | query `?p` perPage=40 | `?product_list_order=new` | navigate-from-watermark |
| 19 | nordicmarksman.com | 2655-2851 | BC Stencil | CF passive | 4,605 | query `?page` perPage=20 | `?sort=newest` | navigate-from-watermark |
| 20 | northprosports.com | 2852-3000 | OpenCart | **none (Apache direct)** | 1,642 | query `?page` perPage=100 | `sort=p.date_added&order=DESC` | navigate-from-watermark |
| 21 | outfitters.goldnloan.com | 3001-3168 | **Odoo (NOT lightspeed — corrected)** | CF passive | 1,787 | path `/page/{N}` | `?order=create_date+desc` | navigate-from-watermark |
| 22 | precisionoptics.net | 3169-3351 | **Volusion (NOT 3dcart)** | CF passive + OWASP | 1,778 | query `?page` perPage=90 | `searching=Y&sort=3` | navigate-from-watermark |
| 23 | rdsc.ca | 3352-3554 | **Magento 2 (NOT bigcommerce)** | CF passive | 9,089 | query `?p` perPage=24 | `?product_list_order=new` | navigate-from-watermark |
| 24 | reliablegun.com | 3555-3742 | **nopCommerce (NOT custom)** | **CF active (1st in audit)** | 4,785 | query `?pagenumber` perPage=48 | `?orderby=15&pagesize=48` | navigate-from-watermark |
| 25 | sail.ca | 3743-3989 | Magento 2 + Searchspring overlay | none (Fastly only) | 18,480 site / 1,698 firearm | query `?page` perPage=24 | hash `#/sort:created_at:desc` | navigate-from-watermark |
| 26 | solelyoutdoors.com | 3990-4212 | LightSpeed eCom | CF passive | 900 | suffix `'page{N}.html?sort=newest'` | (sort baked in pagination) | navigate-from-watermark |
| 27 | store.prophetriver.com | 4213-4408 | BC Stencil | CF passive | 13,766 | query `?page` perPage=20 | `?sort=newest` | navigate-from-watermark |
| 28 | store.theshootingcentre.com | 4409-4596 | BC Stencil | CF passive + OWASP | 16,616 | query `?page` perPage=50 | `?sort=newest` (default=alphaasc) | navigate-from-watermark |
| 29 | surplusherbys.com | 4597-4786 | **Wix Stores (NOT generic-retail)** | none (Pepyaka edge) | 164 | query `?page` `/shop` only | none (React state only) | full-catalog-sweep |
| 30 | theammosource.com | 4787-5106 | BC Stencil | CF passive | 48,012 site / 2,437 firearm | query `?page` perPage=52 | `?sort=newest` 3-outcome verified | navigate-from-watermark |
| 31 | thegundealer.ca | 5107-5442 | WooCommerce | **sgcaptcha (1st in fleet)** | 11,044 | path `/shop/page/N` | `?orderby=date&order=desc` | api-date-since-watermark |
| 32 | triggersandbows.com | 5443-5721 | **Ecwid-on-WordPress** | none (LiteSpeed) | 4,914 | api-offset (POST body) | `sortBy:'addedTimeDesc'` (POST body) | navigate-from-watermark |
| 33 | truenortharms.com | 5718 (mention only) | BC Stencil | CF passive | 1,264 | query `?page` | `?sort=newest` | navigate-from-watermark |
| 34 | wolverinesupplies.com | 5722-5824 | BC Stencil | CF passive | 5,739 | query `?page` perPage=100 | `?sort=newest` (default=newest) | navigate-from-watermark |

**Bold** = correction discovered during audit (the previous platform tag / WAF flag was wrong).

---

## By Platform Family

| Family | Sites |
|---|---|
| **WooCommerce** | 4 (doctordeals), 10 (g4cgunstore), 12 (gotenda), 13 (greatnorthgunco), 31 (thegundealer) |
| **Shopify** | (none — only B1 aagcanada referenced in batch trailer at line 14-78) |
| **BigCommerce Stencil** | 1 (alflahertys+Klevu), 7 (firearmsoutletcanada), 8 (frontierfirearms migrated), 19 (nordicmarksman), 27 (prophetriver), 28 (theshootingcentre), 30 (theammosource), 33 (truenortharms), 34 (wolverinesupplies) |
| **BigCommerce Blueprint** | (8 originally, migrated to Stencil) |
| **Magento 1.x** | 6 (ellwoodepps) |
| **Magento 2.x** | 18 (londerosports), 23 (rdsc), 25 (sail + Searchspring) |
| **LightSpeed eCom** | 9 (fulcrum-outdoors), 11 (gagnonsports — corrected from Classic), 15 (jobrookoutdoors — Shoplightspeed not Shopify), 26 (solelyoutdoors) |
| **Celerant ColdFusion** | 2 (bullseyenorth) |
| **OpenCart** | 20 (northprosports) |
| **Odoo** | 21 (outfitters.goldnloan) |
| **Volusion** | 22 (precisionoptics) |
| **nopCommerce** | 24 (reliablegun) |
| **Activant/Epicor iNet** | 3 (canadasgunstore) |
| **CS-Cart legacy** | 5 (durhamoutdoors) |
| **HikaShop on Joomla** | 17 (lockharttactical) |
| **GoDaddy OLS SPA** | 16 (liangjian) |
| **Wix Stores Thunderbolt** | 29 (surplusherbys) |
| **Ecwid-on-WordPress** | 32 (triggersandbows) |
| **Custom PHP + jPages** | 14 (irunguns) |

---

## By WAF

| WAF Type | Sites | Notes |
|---|---|---|
| **None (verified via heavy 8-batch probe)** | 2 (bullseyenorth), 3 (canadasgunstore), 20 (northprosports — Apache direct), 25 (sail — Fastly CDN only), 29 (surplusherbys — Pepyaka/Wix edge), 32 (triggersandbows — LiteSpeed) | Confirmed-no-WAF after heavy probe; 5/34 sites are genuinely WAF-free |
| **Cloudflare passive** | 5, 6, 8, 9, 10, 11, 13, 17, 19, 21, 23, 26, 27, 30, 33, 34 + others | Most common — 16+ sites; cf-ray on every 200, no challenges |
| **Cloudflare passive + OWASP rules** | 22 (precisionoptics — UNION SELECT, XSS, honeypots), 28 (theshootingcentre — UNION SELECT + XSS) | CF + active OWASP managed rules on dangerous paths |
| **Cloudflare active** | 24 (reliablegun — bot UA blocked + honeypots 403 + XSS 302) | First active CF in fleet; needsPlaywright mandatory |
| **Sucuri** | 1 (alflahertys), 12 (gotenda — 16K WC), 14 (irunguns — passive) | Cookie-cache flow via waf-cookie-manager |
| **sgcaptcha (SiteGround)** | 31 (thegundealer) | First & only sgcaptcha in fleet; 7-test regression harness `tgd-7tests.ts` |
| **nginx UA filter** | 4 (doctordeals) | iPhone UA bypasses |

---

## By Issue / Mistake (Canonical Examples)

| Mistake | Description | Canonical Site(s) |
|---|---|---|
| **1** | Counting sitemap `<loc>` blindly | 5 (durhamoutdoors — 442 sitemap, 147 real) |
| **2** | Guessing sort param names | 5 (durhamoutdoors — `?sortby=4` was hidden in `<select id="sortby">`) |
| **3** | Trusting stale `wafType` notes | 4 (doctordeals — said sucuri, was nginx UA filter) |
| **4** | Dismissing categories by name | 4 (doctordeals — "Sights" contains scopes/red dots) |
| **5** | Missing product categories | 4 (doctordeals — missed Parts, Accessories) |
| **7** | Believing "site dead" on hard 403 | 4 (doctordeals — iPhone UA bypassed instantly) |
| **8** | Guessing page-1=newest | 3 (canadasgunstore — page 1 has OLDEST products) |
| **9** | Catalog URLs are HTML fallback | 4 (doctordeals — WP REST sees all 965, catalogUrls are for HTML stream) |
| **11** | Trusting prior agent's root-cause | 6 (ellwoodepps — bug was URL filter, not selector; 7-line `generic-retail.ts:444-451` fix unlocked 19,725 products) |
| **12** | Dropping "non-firearm" categories | 9 (fulcrum-outdoors `/camping/` — 2 unique gun lights) |
| **13** | Trusting stored `expectedProductCount` | 9 (fulcrum-outdoors — 3,629 was a guess; real 3,631) |
| **14** | paginationPattern template format bugs | 8 (frontierfirearms — `?page={n}` literal), 11 (gagnonsports — lowercase `{n}`, `match:'/$'` literal) |
| **15** | jPages client-side single-page catalog | 14 (irunguns — `paginationPattern: null`) |
| **16** | Following AJAX rabbit hole | 14 (irunguns — embedded SQL POST was a dead-end; plain GET works) |
| **17** | Cursor watermark with non-exposed column | 14 (irunguns — `p.id` server-internal only) |
| **18** | "No sort UI" ≠ "no sort possible" | 14 (irunguns — DOM-order = `p.id DESC` newest-first verified) |
| **19** | Declaring SPA "blocked" without testing Playwright | 16 (liangjian — production fallback already works) |
| **19 sub** | Drive Playwright as a real user (click controls) | 16 (liangjian — sort dropdown is `[data-aid="PRODUCT_SORT_DROPDOWN"]`, not `<select>`) |
| **20** | Magento merchant-customizable sort values | 18 (londerosports — `value="new"` not `created_at`) |
| **21** | OpenCart visible dropdown is incomplete | 20 (northprosports — `?sort=p.date_added&order=DESC` works server-side though hidden) |
| **22** | Stored platform tags need verification | 21 (outfitters.goldnloan — said lightspeed, was Odoo) |
| **23** | `hasWaf:false` after single 200 response | 19 (nordicmarksman), 20 (northprosports), 21 (outfitters) — all needed heavy 8-batch probe |
| **24** | Volusion `?searching=Y` activation flag | 22 (precisionoptics) |
| **25** | Searchspring hash-fragment overlay | 25 (sail — `#/sort:created_at:desc`) |
| **26** | LightSpeed eCom dual-path suffix-replace with sortParam baked in | 26 (solelyoutdoors — `match:'?sort=newest', template:'page{N}.html?sort=newest'`) |
| **27** | Wix sub-cat pagination leak | 29 (surplusherbys — `/shop` only) |
| **28** | DB=0 sites need ALL stale signals re-verified | 29 (surplusherbys — 3 stale signals: platform/hasCaptcha/notes all wrong) |
| **29** | BC Stencil 3-outcome counter-control + double-render | 30 (theammosource — alphaasc to distinguish honored-default-is-newest from no-op) |
| **30** | sgcaptcha iPhone UA + waf-cookie-manager wait fix | 31 (thegundealer) |
| **31** | Ecwid storefront API real field names (sortBy, camelCase, POST body) | 32 (triggersandbows) |
| **32** | Shopify `published_at` not `created_at` | All 4 fleet Shopify sites (B1 aagcanada referenced) |
| **33** | Subagent API claims need verification curl | (general — no specific site) |
| **34** | apiCrawlUsed flag prevents HTML fallback when API empty | (general — `catalog-crawler.ts:266-327`) |
| **35** | 0/3 stored `wafType:'sucuri'` were actually Sucuri | canadafirstammo, doubletapsports, hical (Batch B) |
| **36** | Celerant HPE malformed headers + WAF parser false-positive | 2 (bullseyenorth) |
| **37** | Drupal classifieds facet-URL trap + sitemap lag | gunpost (referenced — not in main 34) |
| **38** | gotenda Sucuri Playwright fallback + sub-cat tile | 12 (gotenda) |
| **39** | Theme name ≠ platform name | 8 (frontierfirearms — BC Blueprint→Stencil migration), 11 (gagnonsports — Classic→eCom mislabel) |

---

## Cross-Cutting Architectural Findings

### Generic infrastructure built across audit (cumulative)

- **Pagination types** added: `path` (Site 2), `offset-query` (Site 3), `suffix-replace` (Site 5)
- **`userAgentOverride` profile field** added: Site 4 (doctordeals iPhone UA)
- **`crawlers.watermark.method` rename + 3 methods**: Site 1+3 (alflahertys + canadasgunstore — full-catalog-sweep)
- **`crawlFullCatalogSweep` function** in watermark-crawler.ts: Site 1 (~100 lines, OOS skip + back-in-stock detection)
- **Back-in-stock alert wiring** in keyword-matcher.ts: Site 1 (PRO email "BACK IN STOCK:" prefix)
- **Magento 1.x URL filter whitelist** at `generic-retail.ts:444-451`: Site 6 (unlocks 19,725 products on ellwoodepps)
- **Klevu key self-healing** at `klevu-key-resolver.ts`: Site 1
- **mysimplestore API branch** at `generic-retail.ts:316`: Site 16 (liangjian Phase 2 — 10x speedup)
- **Heavy 8-batch WAF probe canonical-host pre-flight**: Site 24 (reliablegun apex IIS / www CF split)
- **`waf-cookie-manager.ts` 15-line wait-strategy fix**: Site 31 (thegundealer sgcaptcha — domain-agnostic, helps CF/Sucuri/Incapsula too)

### Recurring pattern observations

- **Stale WAF flags / platform tags**: 12/24 sites had wrong `platform` OR `wafType` at onboarding. Always heavy-probe + grep HTML for generator/markers before trusting stored signals.
- **Missing paginationPattern**: 9/13 early-batch sites had it missing. Always set explicitly.
- **BC Stencil theme default sort varies per merchant**: 4 sites observed 3 different defaults (newest/featured/alphaasc). Cannot predict; always read `<select>` + use a measurably-different counter-control.
- **catalogUrls 100% coverage rule** (NEVER drop small categories): truenortharms 92% coverage rejected by user; 149 leaves accepted.

### Standard sub-agent prompt template

Lines 5064-5102 of source file have a template for dispatching site-audit subagents.

---

## When to Read the Source File

| Investigating... | Read lines |
|---|---|
| Specific site's full investigation | Per-site row above (e.g. Site 14 → 2045-2173) |
| Lessons learned format / standard prompt template | 5064-5102 |
| Batch B audit overview | 11-117 |
| Trailer summaries (latest changes) | 5825-5832 |

---

## Maintenance — CLAUDE'S RESPONSIBILITY (not the user's)

**This index is mine to keep current.** When I (Claude, in this or any future session) do any of the following, I update this index in the same turn — not "later," not "next session":

- **After completing a new site audit** → append per-site row + update by-platform / by-WAF / by-Mistake lookups in the same response that finalizes the audit
- **After discovering a platform-correction** (e.g. site was tagged X but is really Y) → bold the platform column entry like Site 8 / 11 / 21 / 22 / 23 / 24 / 25 / 29 / 32 already are
- **After observing a Mistake on a new site** → append to the Canonical Site(s) column for that Mistake
- **After building new generic infrastructure** → add to "Generic infrastructure built across audit"
- **After committing the audit work** → bump the line ranges in the per-site lookup table if the source file's `# SITE N/34` marker line numbers shifted

The user maintains the source-of-truth `34-site-audit-history.md` ONLY by virtue of asking me to do audits — they never edit either file directly. If I leave the index stale, future sessions waste tokens reading the source file unnecessarily AND make wrong decisions based on outdated cliff-notes.

This index is REGENERABLE from source by re-grepping `^# SITE \d+/34` markers + reading per-site sections — but the cost is ~50K tokens of source reading. Cheaper to keep it current incrementally.
