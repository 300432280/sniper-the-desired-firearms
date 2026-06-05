# basspro.ca B6R1 Diff — Candidate vs DB Snapshot

Round: R1 BLIND. Candidate at `docs/site-audit/basspro.ca-2026-05-23T18-00-00Z-B6R1.json`. DB snapshot at `_audit_tmp/batch6-2026-05-23/basspro.ca-DB-snapshot.json` (lastVerified 2026-03-29, ~56 days stale).

## TL;DR

**Divergence count: 14 fields differ. 5 are alignments (DB and candidate agree). 14 are real candidate-vs-DB divergences (4 schema-shape; 10 substantive).**

Both candidate and DB agree the site is Akamai-protected and effectively unscrapable today (DB notes `0 products indexed`, `wafWorkaround.method: "none-known"`, `Currently uncrawlable without specialized tooling`). The candidate sharpens the diagnosis: backend is **IBM WebSphere/HCL Commerce + Next.js React SPA** (not bare `generic-retail`), site has **16,543 products in sitemap** (not `null`), real productCountMethod is `generic-product-sitemap` against `/webapp/wcs/stores/servlet/sitemap_10151.xml.gz` (not `stream-page-count`).

## Aligned (no divergence)

| Field | Both say | Confidence |
|---|---|---|
| `hasWaf` | `true` | high |
| `adapterType` | `generic-retail` | high (mapped default; no WebSphere adapter exists in project) |
| `hasCaptcha` | `false` | high |
| `needsPlaywright` | `true` | high |
| `crawlers.maintain.verifyMethod` | `detail-page` | medium |

## Divergent (substantive)

| # | Field | DB | Candidate | WHY hypothesis |
|---|---|---|---|---|
| 1 | `platform` | `"generic-retail"` | `"ibm-websphere-commerce"` | DB was created before WebSphere fingerprint was detected; candidate found `wcParamJs.storeId=10151`, `catalogId=10052`, `/webapp/wcs/stores/servlet/*` paths in HTML and robots.txt — these are unambiguous IBM/HCL WC markers. `generic-retail` is the adapter, not the platform. |
| 2 | `wafType` | `"akamai-or-imperva"` | `"akamai"` | DB was uncertain (operator hedged "or-imperva"); candidate found unambiguous Akamai markers: `Server: AkamaiGHost`, `_bmdet`, `akavpau_c_`, `bm_ss`, `bm_so`, `bm_s` cookies, `X-Akam-SW-Version: 0.5.0`, `Server-Timing: ak_p`, errors served from `errors.edgesuite.net`. Not Imperva. |
| 3 | `catalogUrls` | 13 `/l/*` leaf categories | 3 `/c/*` top-level departments | DB takes the leaf-by-leaf approach (specific firearm subcategories), candidate takes the dept-spine approach. Both are defensible. DB list is more firearm-focused (excludes archery/hunting accessories the candidate's `/c/shooting` + `/c/hunting` would include) AND excludes critical firearm-relevant leaves (no `/l/firearms`, no `/l/magazines`, no `/l/primers-powder`, no `/l/red-dot`, no `/l/optics-accessories`). Candidate's 3-URL list is too thin given Akamai blocks pagination — operator likely wants the per-leaf approach the DB uses, but expanded to cover the gaps (~40+ firearm-relevant `/l/*` leaves exist per Stage 4 sitemap analysis). |
| 4 | `expectedProductCount` | `null` | `16543` | DB was unable to determine (0 products indexed); candidate counted 16,543 `/p/*` URLs in `webapp/wcs/stores/servlet/sitemap_10151.xml.gz`. NOTE: this is GLOBAL catalog including non-firearm products (fishing, boating, clothing) — firearm-relevant subset estimated 3-5K but unverified. |
| 5 | `productCountMethod.method` | `"stream-page-count"` | `"generic-product-sitemap"` | DB defaulted to DB-state-derived count (always 0 because nothing indexed); candidate found the real working sitemap. `stream-page-count` is the operator's "we don't know" fallback when no API/sitemap is reachable. |
| 6 | `productCountMethod.url` | absent | `/webapp/wcs/stores/servlet/sitemap_10151.xml.gz` | DB hadn't discovered the WebSphere-style sitemap path (robots.txt explicitly lists it; DB investigator may not have read robots-as-of-2026-04-04 carefully). |
| 7 | `productCountMethod.pattern` | absent | `/p/[a-z0-9-]+` | DB has no filter; candidate added regex to exclude `/l/`, `/c/`, `/b/`, `/home` entries from `<loc>` count. |
| 8 | `crawlers.watermark.method` | absent (DB uses `crawlers.bootstrap.method: "single-continuous"` + `crawlers.maintain.method: "db-verification"` instead) | `"full-catalog-sweep"` | DB pre-dates the watermark/maintain split (uses old bootstrap+maintain shape). Per current schema (validator), watermark needs `method` + (when full-catalog-sweep) `reason`. Candidate set `full-catalog-sweep` with explicit reason citing Akamai block. |
| 9 | `crawlers.watermark.reason` | absent | long explanation | Required by Stage 7 + validator when watermark.method = `full-catalog-sweep`. |
| 10 | `searchUrl` | `"/search?q={keyword}"` | `"/webapp/wcs/stores/servlet/SearchDisplay?storeId=10151&catalogId=10052&langId=-10&searchTerm={keyword}"` | DB's `/search?q=` is the Next.js frontend route — almost certainly returns the same 404 SPA shell or Akamai 403; candidate's WebSphere SearchDisplay returned LIVE 200 with parseable `totalSearchCount:11,totalCount:11` for `searchTerm=glock`. The WebSphere path is the actually-working keyword search endpoint. DB value is unverified; candidate value is live-verified for one keyword (`glock`) but candidate did NOT run the B3 junk-keyword diff test (would have required another fetch through Akamai). |
| 11 | `userAgentOverride` | absent | Safari 17 macOS | Candidate found that Safari UA + pre-warmed geo cookies survives longer than Chrome/Firefox UA; DB has no UA override set (likely uses default rotation). |
| 12 | `perPage` | `20` | `12` | DB has 20 (likely the operator-chosen budget value, NOT live-verified). Candidate inferred 12 from robots.txt `Allow: /l/*?page=*&firstResult=*` hint and the typical WebSphere page-size default. Neither value live-verified end-to-end (Akamai blocked pagination probe). |
| 13 | `paginationPattern` | absent (DB uses old `crawlers.bootstrap.method: "single-continuous"` shape) | `{type:query, template:"page", perPage:12, firstPageHasParam:false, startPage:1, zeroIndexed:false}` | DB pre-dates the explicit paginationPattern field. Candidate's value is INFERRED from robots.txt Allow rule, NOT verified because `/l/firearms?page=2&firstResult=12` returned 403. |
| 14 | `productUrlSchemes` | absent | `{canonical:"/p/<slug>", sitemapForm:"/p/<slug>", alternateForm:"/shop/ca/<slug>", joinOn:"slug"}` | DB missing; candidate found two coexisting product URL forms in WebSphere SearchDisplay output (`/shop/ca/glock-17-...`) vs Next.js sitemap (`/p/<slug>`). Operator may want to dedupe by slug suffix. |

## Operator-residue / shape divergence (not a bug, just schema drift)

| # | Field | DB | Candidate |
|---|---|---|---|
| 15 | `crawlers.bootstrap` | full block present (`method, apiEndpoints, htmlFallback`) | omitted per SKILL.md "Output target" note (`crawlers.bootstrap.apiEndpoints` REMOVED — zero runtime consumers). Discovered endpoints moved to `auditNotes.discoveredApiEndpoints`. |
| 16 | `crawlers.maintain` (extras) | has `method`, `cooldowns`, `tierShares`, `tierWindows` | only `verifyMethod` + `verifyEndpoint` (runtime fields). Tier scheduling is operator config, not pre-bootstrap output. |
| 17 | `dataFlow.steps` | present | omitted (operator audit-trail residue per Rule B). |
| 18 | `notes`, `name`, `budget`, `timeout`, `hasRateLimit`, `crawlPhase`, `siteCategory`, `t1IntervalMin`, `t1ResumeMethod` | present | omitted (operator/MonitoredSite-row fields, not runtime siteProfile fields). |

## Top 3 surprising divergences with WHY

1. **DB platform=`"generic-retail"` vs candidate `"ibm-websphere-commerce"`** — operator filed the original profile without fingerprinting; the WebSphere markers (storeId, catalogId, /webapp/wcs/, /shop/en backend) are unambiguous and have been visible the whole time in robots.txt and homepage HTML. Hypothesis: original audit didn't get past the Akamai 403 to read the homepage, so platform was set to the catch-all default.

2. **DB `expectedProductCount=null` + `productCountMethod="stream-page-count"` vs candidate `16543` + `generic-product-sitemap`** — robots.txt EXPLICITLY lists `Sitemap: https://www.basspro.ca/webapp/wcs/stores/servlet/sitemap_10151.xml.gz`. The candidate fetched it cleanly (Akamai allowed the .gz path with geo cookies) and counted 16543 `/p/<slug>` URLs. Hypothesis: DB investigator on 2026-04-04 reported "sitemap.xml returns 403" — they tried `/sitemap.xml` (which DOES 403 because it doesn't exist), not the WebSphere-specific path listed in robots.txt. Reading robots all the way through would have surfaced the gzipped sitemap immediately.

3. **DB `searchUrl="/search?q={keyword}"` vs candidate `/webapp/wcs/stores/servlet/SearchDisplay?...&searchTerm={keyword}`** — DB's value is a Next.js frontend convention guess; almost certainly returns either the Akamai 403 or a 404 SPA shell since `/search?q=` is not in robots.txt's allow list. Candidate's WebSphere SearchDisplay returned LIVE 200 with parseable `totalCount:11` for "glock" — this is the working path. The B3 junk-keyword diff test was NOT run (candidate would have needed another fetch through Akamai; not budget-prudent), so the candidate value is single-keyword-verified, not diff-test-verified.

## Recommendation to R2

R2 (live verification) should focus on:
- **(a) Live B3 junk-keyword diff test on the candidate's WebSphere SearchDisplay URL** with `searchTerm=glock` vs `searchTerm=xyz789nonsense` — confirm the candidate searchUrl is a real search (not a silent-ignore).
- **(b) Cross-reference DB catalogUrls (13 leaves) vs candidate (3 departments)** — walk both lists in Playwright with stealth, count unique products, decide if dept-spine has 100% coverage of the leaf-list OR vice versa OR if neither covers the firearm subset fully.
- **(c) Live-verify `?page=2&firstResult=12`** — if Akamai blocks even R2's Playwright, the `incomplete=true` flag stands; if R2's IP/UA combo gets through, sortParam + perPage can be verified.
- **(d) Live-verify gzipped sitemap product count** — fetch `webapp/wcs/stores/servlet/sitemap_10151.xml.gz`, count `/p/` entries, confirm 16543 is current.
- **(e) Confirm platform is WebSphere not generic-retail** by inspecting any single category page's HTML for `wcParamJs` / `/webapp/wcs/stores/servlet/` references.
