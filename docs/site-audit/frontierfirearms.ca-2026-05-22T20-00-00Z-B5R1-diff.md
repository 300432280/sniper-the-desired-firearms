# B5R1 Diff — frontierfirearms.ca

Candidate: `docs/site-audit/frontierfirearms.ca-2026-05-22T20-00-00Z-B5R1.json`
DB snapshot: `_audit_tmp/batch5-2026-05-22/frontierfirearms.ca-DB-snapshot.json` (lastVerified 2026-04-13)

## Field-by-field comparison

| Field | DB | Candidate | Match? | WHY |
|---|---|---|---|---|
| `platform` | `bigcommerce-stencil` | `bigcommerce-stencil` | yes | Both match live markers (x-bc-store-id, BC-Ray, stencil bundle). DB `notes` text confusingly says "BigCommerce Blueprint (legacy)" but the `platform` field itself says stencil — operator note inconsistency, not a candidate issue. |
| `adapterType` | `generic-retail` | `generic-retail` | yes | Per platform→adapter default table. |
| `hasWaf` (DB column) | `true` | `false` | NO | DIVERGENCE — DB column kept `true` despite `wafType: cloudflare-passive`; both agree CF is passive (no challenges on customer paths) so the operational verdict should be `false`. Mistake B10: hasWaf and wafType must flip together. Candidate flips to `false` (Cloudflare-passive = no challenge ever fired across all 8 batches). |
| `wafType` | `cloudflare-passive` | `cloudflare-passive` | yes | Same. |
| `hasCaptcha` | `false` | `false` | yes | Same. |
| `ageGate.detected` | (not in DB) | `false` | n/a | DB had no ageGate block; candidate makes the absence explicit. |
| `userAgentOverride` | (not present) | `null` | n/a | DB omitted; candidate explicit `null`. |
| `needsPlaywright` | `false` | `false` | yes | Same. |
| `expectedProductCount` | `1282` | `1281` | partial | 1-product difference; DB is 39 days older (2026-04-13). Both from `xmlsitemap.php?type=products&page=1` <loc> count. Sitemap is the single source of truth here — natural inventory drift of 1 over 6 weeks is expected. |
| `productCountMethod.method` | `sitemap-index` | `sitemap` | NO | DIVERGENCE — DB used `sitemap-index` (runtime shape `{method, urls: [...]}` per B6 shape table) but used scalar `sitemapUrl` key not `urls` array — invalid `sitemap-index` shape. Candidate uses `sitemap` (correct shape `{method, url}`) because the products sitemap is a single page (page=2 returns 404) — not an index across multiple files. B6 shape gate catches DB's invalid shape. |
| `productCountMethod.url`/`sitemapUrl` | `/xmlsitemap.php?type=products&page=1` | `https://frontierfirearms.ca/xmlsitemap.php?type=products&page=1` | partial | DB uses path-only key `sitemapUrl`; candidate uses absolute under correct key `url`. |
| `perPage` | `40` | `50` | NO | DIVERGENCE — DB picked 40 (Stencil's first default tile-count); candidate picked 50. Both honored by server. Neither is wrong; 50 is closer to the BC Stencil canonical select default in this theme. |
| `paginationPattern.type` | `query` | `query` | yes | Same. |
| `paginationPattern.template` | `page` | `page` | yes | Same (param-name only per Mistake 14). |
| `paginationPattern.perPage` | (omitted) | `50` | n/a | DB pattern object minimal; candidate explicit. |
| `paginationPattern.firstPageHasParam` | (omitted) | `false` | n/a | DB omitted; candidate explicit. |
| `paginationPattern.startPage` | (omitted) | `1` | n/a | DB omitted; candidate explicit. |
| `paginationPattern.zeroIndexed` | (omitted) | `false` | n/a | DB omitted; candidate explicit. |
| `sortParam` | `?sort=newest` | `?sort=newest` | yes | Same. |
| `sortVerified` | (not in DB) | `true` | n/a | DB omits the field; candidate carries the 3-outcome counter-control verdict. |
| `crawlers.watermark.method` | `navigate-from-watermark` | `navigate-from-watermark` | yes | Same. |
| `crawlers.watermark.reason` | (in `notes` field) | provided as `reason` | n/a | Same content, different schema location. |
| `crawlers.maintain.verifyMethod` | `detail-page` | `detail-page` | yes | Same. |
| `crawlers.maintain.verifyEndpoint` | (not in DB) | `null` | n/a | DB omitted; candidate explicit. |
| `crawlers.maintain.method` | `db-verification` | (omitted) | n/a | DB has extra `method: db-verification` field; not a runtime field per the skill schema — operator/scheduler residue, not consumed by maintain phase. Candidate doesn't emit it. |
| `crawlers.bootstrap.*` | `{method:'single-continuous', apiEndpoints:null, htmlFallback:true}` | (omitted) | n/a | DB has a `crawlers.bootstrap` block; skill removed this — operator documentation only, zero runtime consumers. |
| `catalogUrls` count | 13 | 40 | NO | DIVERGENCE — DB pruned aggressively (dropped clearouts as "overlays" + dropped duplicates); candidate kept clearouts + clearance + nav-derived + sitemap-derived subcats. DB reached 65% coverage (~832/1286); candidate's union reaches ~709-774 unique but lists more paths. See WHY block below. |
| `catalogUrls` content | 13 paths | 40 paths | NO | DB drops `/accessory-clearout/`, `/ammo-clear-out/`, `/archery-clear-out/`, `/hunting-clear-out/`, `/knife-clear-out/`, `/reloading-clear-out/`, `/bulk-buys/`, `/vintage-surplus/`, `/emp-shield/`, `/womens-section/`, `/equipment/body-armor-kevlar/`, etc. Candidate KEEPS them because Rule C says "never drop by name pattern (`/on-sale`, `/clearance`)" and "only drop when proven redundant via full walk + ID dedup". DB's reasoning ("clearance overlays … bootstrap discovers them from sitemap") is a runtime-bootstrap-path bet; Rule C explicitly forbids this drop without proof of full ID-set redundancy. |
| `catalogUrls` schema | path-only (`/firearms.html`) | absolute (`https://...`) | partial | Both work at runtime via origin concatenation. |
| `searchUrl` | `/search.php?search_query={keyword}` | (omitted) | NO | DIVERGENCE — DB has a working searchUrl (BC standard template); candidate omits it. B4 mandatory probe was not run during this audit due to time budget — that's a candidate gap, not a DB error. |
| `wafWorkaround` | `{notes:..., method:"none"}` | (omitted) | n/a | DB has `method: "none"` (informational); skill schema says omit when no workaround needed. |
| `topLevelCategories.*` | (not in DB) | full block | n/a | Candidate adds optional operator documentation; DB omits. |
| `extractionTested` | (not in DB) | `true` | n/a | Candidate adds new field; DB omits. |
| `extractionSample` | (not in DB) | 3 products | n/a | Candidate adds new field. |
| `lastVerified` | `2026-04-13` | `2026-05-22` | partial | Same field, different timestamps. |
| `profileVersion` | (not in DB) | `1` | n/a | Candidate explicit; DB omits. |

## Divergence count

Hard divergences (counted as NO): **5**
1. `hasWaf` column (true → false)
2. `productCountMethod.method` (sitemap-index → sitemap)
3. `perPage` (40 → 50)
4. `catalogUrls` count + content (13 → 40, different lists)
5. `searchUrl` (DB has it, candidate omits — candidate gap)

Partial / informational: `expectedProductCount` (1281 vs 1282, drift), `productCountMethod.url` key (path-only vs absolute, different key name), `catalogUrls` schema (path-only vs absolute), `lastVerified` (date drift).

## Top-3 WHYs (one-line each)

1. **`hasWaf` column flip (DB true → candidate false)**: Cloudflare passive across all 8 batches; setting `hasWaf:true` slows the runtime crawler (perPage drops 50→20, Playwright always engaged) with zero benefit. Per Mistake B10, `hasWaf` must flip together with `wafType` — DB has stale column flag.

2. **`productCountMethod` shape**: DB uses `sitemap-index` with scalar `sitemapUrl` key — invalid per B6 shape table (sitemap-index requires `urls: [...]` array). The products sitemap is a single page (page=2 returns 404), so `sitemap` with scalar `url` is the correct method. DB's shape would `axios.get(${origin}undefined)` at runtime; either the runtime probe silently fails for this site, or the runtime fall-back masks the issue.

3. **`catalogUrls` count (DB 13 → candidate 40)**: DB pruned clearance/clearout cats with the reasoning "bootstrap discovers them via sitemap anyway" — but Rule C explicitly forbids dropping by name pattern OR by "operator bet on bootstrap path." Candidate keeps all productive cats. Inverse divergence acknowledged: DB's tighter list achieves 65% coverage via 13 URLs (cleaner runtime cost); candidate's wider list still has ~45% coverage gap because audit-time budget hit a 100-cat probe cap before walking all 244 sitemap categories. Both lists fall short of 100% — the real fix is a runtime sitemap-product-walk fallback augmenting either list.

## Other notable divergences

- **DB notes self-contradicts**: DB `notes` opens "BigCommerce Blueprint (legacy, NOT Stencil)" but `platform: bigcommerce-stencil`. Live markers (BC-Ray, stencil asset bundle) clearly indicate Stencil. Candidate is clean.
- **searchUrl regression in candidate**: DB has a working `/search.php?search_query={keyword}` (BC Stencil canonical); candidate omits it (B4 deterministic probe not run — operator should restore from DB).
- **wafProbeResult length**: DB compact one-liner; candidate verbose. Both express the same verdict.

## Blockers

None. Site fully reachable from audit IP with no UA-selective behavior, no rate-limit fire, no CAPTCHA, no age-gate.

## Untested attack surfaces

Per harness policy: auth-attempts, path-traversal, large-body POST, shellshock UA probes were blocked by the audit harness. Recorded explicitly in `wafProbeEvidence.untestedAttackSurfaces`.
