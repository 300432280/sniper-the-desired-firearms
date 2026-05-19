# Diff: B4R1 Candidate vs DB siteProfile — wolverinesupplies.com

- **Candidate**: `docs/site-audit/wolverinesupplies.com-2026-05-15T18-43-52Z-B4R1.json` (B4R1 blind run, 2026-05-15)
- **DB siteProfile lastVerified**: `2026-04-11T01:07:09.759Z` (5 weeks stale)
- **Validator**: candidate `valid=true, score=100, 0 failed`

## Field-by-field diff with one-line WHY

| Field | Candidate | DB | WHY divergent |
|---|---|---|---|
| `hasWaf` (column) | `false` | `true` | DB column set conservatively true because cf-ray is present; skill operational rule says cloudflare-passive = `false`. Both files agree `wafType: cloudflare-passive`. |
| `expectedProductCount` | `8173` (sitemap) | `5739` (category-walk-dedupe) | DB used "browsable products"; sitemap is canonical for inventory tracking per skill rule (OOS hidden on BC category pages). |
| `productCountMethod` | `{method:"sitemap", url:"..."}` (object) | `"category-walk-dedupe"` (bare string) | DB uses a bare string method NOT in `product-count-probe.ts` switch — falls through to `default: return null` -> runtime count probe silently disabled. Candidate uses canonical method object. |
| `catalogUrls` count | 15 | 14 | Candidate includes `/training/` (returns 200 with 0 products — kept per skill rule "empty != dead"); DB excludes. |
| `catalogUrls` form | `https://.../<cat>/?limit=250` (absolute + limit baked) | `/<cat>/` (relative, default 100) | Candidate baked `?limit=250` after probing up to `?limit=2500` clean (full /parts/ 1206 products in 5s); DB uses bare paths so runtime defaults to BC's perPage=100. |
| `perPage` | `250` | `100` | Candidate verified `?limit=250` honored with zero page-1/page-2 overlap; DB conservative default. |
| `paginationPattern.template` | `"page"` | `param: "page"` | Key-name drift: candidate matches skill schema (`template`); DB uses non-schema key `param`. |
| `paginationPattern.startPage` | `1` | `firstPage: 1` | Key-name drift: candidate matches skill schema (`startPage`); DB uses non-schema key `firstPage`. |
| `crawlers.maintain.verifyMethod` | `"detail-page"` | absent | Candidate emits derived maintain config per skill Stage 3 table; DB omission silently disables maintain-phase verification (worker logs error and skips). |
| `crawlers.watermark.reason` | long-form evidence string | `"note": "Default sort is already newest..."` | Schema key drift: candidate uses skill-canonical `reason`; DB uses ad-hoc `note`. Neither field is REQUIRED here (only when `full-catalog-sweep`). |
| `bcStoreId` | absent | `"1003335859"` | Skill schema only enumerates `ecwidStoreId` as the platform-extra; `bcStoreId` is not in the conditional outputs table. DB carries it; candidate dropped it. |
| `ageGate` | explicit `{detected:false, type:null, bypassCookie:null}` | absent | Candidate emits the explicit-null object per skill schema; DB omits. |
| `extractionTested` | `true` with sample | absent | Candidate emits per skill Stage 4g; DB has no extraction proof. |
| `userAgentOverride` | `null` (explicit) | absent | Candidate emits explicit null; DB omits. |
| `lastVerified` | `2026-05-15` | `2026-04-11T01:07:09.759Z` | 5-week staleness on DB; candidate refreshes. |

## Per-category count drift (candidate vs DB stats — normal inventory churn over 5 weeks)

| Category | Candidate | DB | Drift |
|---|---|---|---|
| firearms | 629 | 641 | -12 |
| ammunition | 462 | 444 | +18 |
| AIRGUNSM | 8 | 4 | +4 |
| optics | 942 | 960 | -18 |
| parts | 1206 | 1221 | -15 |
| reloading | 264 | 265 | -1 |
| apparel | 131 | 130 | +1 |
| surplus | 26 | 27 | -1 |
| used | 6 | 8 | -2 |
| outdoors | 202 | 197 | +5 |
| training | 0 | (excluded by DB) | new in candidate |
| gearandkit | 291 | 284 | +7 |
| FIREARMS-ACCESSORIES | 1157 | 1166 | -9 |
| storagemaintenance | 400 | 420 | -20 |
| gifts-gadgets-media-more | 34 | 34 | 0 |
| **Union walked** | **5697** | **5739** | -42 (normal churn) |

## Divergent field count

**15 divergent fields**, of which:
- 3 schema-key drifts on DB side (`param` vs `template`, `firstPage` vs `startPage`, `note` vs `reason`) — DB profile uses non-canonical keys.
- 3 runtime-impacting divergences (productCountMethod bare-string falls through to null; perPage 100 vs 250; missing crawlers.maintain.verifyMethod silently disables maintain verify).
- 2 inventory-count divergences (expectedProductCount sitemap vs walk; bcStoreId presence).
- 7 documentation/presence divergences (catalogUrls form, ageGate explicit object, extractionTested presence, etc.).

## Most surprising divergences

1. **`productCountMethod: "category-walk-dedupe"` (bare string) in DB is broken at runtime.** `product-count-probe.ts:204` only switches on objects with a `.method` key in a fixed enum; the bare string is neither in the enum nor an object. Switch hits `default: return null` — site has zero count-probe coverage at runtime despite the DB profile carrying the field. Skill Stage 8 explicitly warns about this anti-pattern.
2. **DB has `hasWaf: true` for a cloudflare-passive site.** Skill operational rule (Stage 2) says cloudflare-passive should be `hasWaf: false` so the runtime crawler doesn't drop perPage to 20 unnecessarily. DB's `hasWaf: true` likely throttles this site's crawl by ~80% with no security benefit.
3. **DB omits `crawlers.maintain.verifyMethod`.** Skill Stage 3 says: "without this field, the worker logs an error and skips verification entirely." For BC Stencil (no public store API), the correct value is `detail-page` — candidate emits it; DB doesn't.

## SKILL.md harness gaps (1-3)

1. **`bcStoreId` is missing from skill's conditional-output table.** Stage 3 enumerates `ecwidStoreId` for ecwid-* and `classifiedRules` for classifieds-*, but the BC Stencil store ID (visible in `x-bc-store-id` header + `cdn11.bigcommerce.com/s-<hash>` URL) is operationally useful for any future BC GraphQL probing. Skill should either add `bcStoreId` to the conditional outputs OR explicitly state "BC Stencil store IDs are intentionally not stored — record in auditNotes only." Currently there is a silent gap: the DB carries this field, the skill doesn't tell new audits to emit it.
2. **`paginationPattern` schema key inconsistency between skill and DB.** Skill canonical keys are `template`, `startPage`. Older DB profiles (this site included) use `param`, `firstPage`. The runtime URL builder at `catalog-crawler.ts:152` reads `pattern?.template` only — there is no `?? pattern.param` fallback. So DB profiles with the legacy `param` key silently fall back to default `"page"` (works by coincidence here but breaks for any site whose param name isn't `page`). Skill should add a calibration anti-pattern: "On every re-audit, rewrite `paginationPattern.param` -> `template`, `firstPage` -> `startPage` so the runtime URL builder doesn't fall back to defaults."
3. **`hasWaf: false` for cloudflare-passive needs operator-side guidance.** Skill says set `false` (operational), but a defensive operator (or older audit pass) sets `true` to be safe — costing crawler throughput. Skill should add a one-line note in Stage 2: "If an existing DB profile has `hasWaf: true` for a cloudflare-passive site (cf-ray present, all 8 batches 200, no challenges), lower it to `false` on calibration. The runtime cost of `hasWaf: true` is perPage drop to 20 and routing through the WAF cookie manager — a real ~5x throughput hit with no security benefit when the WAF doesn't actually challenge."
