# B4R1 Diff — canadasgunstore.ca (2026-05-19)

Candidate: `docs/site-audit/canadasgunstore.ca-2026-05-19T20-00-00Z-B4R1.json`
DB snapshot: `_audit_tmp/batch4-2026-05-19/canadasgunstore.ca-DB-snapshot.json`

## Convergent fields (R1 and DB agree)

| Field | Both |
|---|---|
| `hasWaf` | `false` |
| `hasCaptcha` | `false` |
| `adapterType` | `generic-retail` |
| `needsPlaywright` | `false` |
| `perPage` | `255` |
| `paginationPattern.type` | `offset-query` |
| `paginationPattern.template` | `top` |
| `paginationPattern.perPage` | `255` |
| `sortParam` | `null` |
| `crawlers.watermark.method` | `full-catalog-sweep` |
| `crawlers.maintain.verifyMethod` | `detail-page` |

## Divergences

| # | Field | Candidate (R1) | DB | WHY (1-line hypothesis) |
|---|---|---|---|---|
| 1 | `platform` | `activant-inet` | `custom` | DB pre-dates the platform detector; candidate identifies Activant/Epicor iNet from `/inet/` paths + `sagro_base_url` + `img2.activant-inet.com` CDN. More specific is better per the skill multi-marker rule. |
| 2 | `expectedProductCount` | `2385` | `2361` | Live count today is 2,385 (umbrella `outdoors---hunting-etc--|30` "found" text). DB 2361 is a 2026-04-06 snapshot — inventory drifted +24 over ~6 weeks. Skill Mistake 13 says "always re-derive". |
| 3 | `productCountMethod` | `{html-pagination, url, selector, regex, perPage:255}` | `{stream-page-count}` | DB uses runtime-internal `stream-page-count` (reads `streamState` DB table). Candidate uses live-site `html-pagination`. Both are valid; for a fresh pre-bootstrap candidate, live-site probe is canonical. |
| 4 | `catalogUrls` count | `[1 URL: umbrella /departments/outdoors---hunting-etc--|30.html]` | `[7 URLs: per-subclass FA/AMM/OPT/SHO/HNT/KT/CLO]` | DB picked per-subclass (parallelism, category isolation). Candidate picked umbrella (Rule C "smallest URL set"). Both prove 100% coverage. Genuine operator-policy choice the skill should surface. |
| 5 | `catalogUrls` URL encoding | `%7C` (URL-encoded from href) | literal `\|` | DB note explicitly says "pipe character is literal, NOT %7C". Both forms return 200, but DB convention is literal to avoid double-encoding through `new URL().toString()`. R1 took the raw href value. |
| 6 | `sortVerified` | `false` (added) | (not present) | DB lacks the field; candidate emits per skill Stage 6. Pure additive. |
| 7 | `wafType` | `null` | (not in siteProfile JSON) | DB stores `column_hasWaf:false` only. Candidate emits per skill (operator UI uses it). Additive. |
| 8 | `wafLastProbedAt` / `wafProbeMethod` / `wafProbeResult` / `wafProbeEvidence` | populated | absent | DB profile predates the 8-batch probe schema. Audit-trail block per Stage 2. |
| 9 | `extractionTested` / `extractionSample` | `true` + 3-product sample | absent | DB pre-dates Stage 4g spot-check; candidate adds proof block. |
| 10 | `ageGate` block | `{detected:false, type:null, bypassCookie:null}` | absent | Pure additive per Stage 3. |
| 11 | `searchUrl` | omitted | `"/search?q={keyword}"` | DB has a search URL the candidate didn't probe. R1 gap — should test `/search?q=`, `/inet/storefront/store.php?mode=search&keyword=`. |
| 12 | `crawlers.bootstrap` block | omitted (per skill) | `{single-continuous, apiEndpoints:null, htmlFallback:true}` | Skill explicitly removed (zero runtime consumers). Intentional difference. |
| 13 | `crawlers.maintain.cooldowns / tierShares / tierWindows` | absent | populated | Operator-tuned runtime scheduling; skill does not produce them. |
| 14 | `t1IntervalMin` / `budget` / `timeout` | absent | `20 / 40 / 15000` | Operator-tuned runtime fields; skill does not produce them. |
| 15 | `name` (display name) | absent | `"Canada's Gun Store"` | Skill doesn't emit display metadata. |
| 16 | `dataFlow.steps` | absent | populated | Operator audit-trail residue (Rule B); skill is runtime-only. |
| 17 | `notes` long-form string | absent (replaced by `auditNotes.*`) | populated | Rule B: freeform notes are audit-trail residue; skill puts them under structured `auditNotes`. |
| 18 | `topLevelCategories` block | populated (9 categories) | absent | New documentation block per Stage 4f. |
| 19 | `hasRateLimit` | absent | `false` | DB has this field; skill doesn't emit. Could be a useful runtime hint (skill could add). |
| 20 | `siteCategory` / `column_siteCategory` | absent | `"retailer"` | DB column + JSON field. Skill output is platform/adapter focused, doesn't classify site type. |

## Top 3 surprising divergences with WHY

1. **`catalogUrls` count: 1 (R1) vs 7 (DB)** — both cover 100% of 2,385 firearm-relevant products. **WHY**: R1 follows Rule C ("smallest URL set whose union covers 100%") to its literal endpoint — one umbrella URL is the minimum. DB chose 7 subclass URLs, likely for parallelism (each subclass = independent crawl job, isolation if one category times out). Rule C is silent on parallelism cost. The skill should surface this as an explicit operator choice via `auditNotes.catalogUrlsStrategy: "single-umbrella"` vs `"per-subclass"`, not just default to literal minimum.

2. **URL encoding: `%7C` (R1) vs literal `\|` (DB)** — both forms return 200. **WHY**: the DB note explicitly warns "pipe character is literal, NOT %7C" — an operator-discovered runtime gotcha (some URL builders re-encode `%7C` → `%257C`, breaking the request). R1 took the raw `<a href>` value (`%7C`) without testing whether the runtime URL builder double-encodes. Real R1 process bug — the skill should probe both forms end-to-end through `new URL().toString()` and pick the form that survives a round-trip.

3. **`searchUrl`: omitted (R1) vs `"/search?q={keyword}"` (DB)** — DB has a working search URL R1 didn't probe. **WHY**: skill Stage 3's `searchUrl` is listed as conditional, and R1 didn't test the keyword-search workflow. R1 gap — the harness should always probe a short list of common search patterns (`/search?q=test`, `/?s=test`, platform-specific paths like `/inet/storefront/store.php?mode=search&keyword=test`) and record whichever returns a results page.

## Blockers
None. All 9 required validator fields populated.

## R1 gaps to address in R2/R3/R4
- **Probe `searchUrl` candidates** — at least `/search?q=test` and `/inet/storefront/store.php?mode=search&keyword=test`. Confirm one returns a results page with the test keyword.
- **Probe URL-encoding compatibility** — does the production crawler's URL builder double-encode `%7C` → `%257C`? Test both literal `|` and `%7C` end-to-end through `new URL(href, base).toString()`.
- **Count-method comma bug** — `html-pagination` regex `(\d+)` mishandles `"2,385 found"` (parses as `2`). Page-multiplication regex `of\\s+(\\d+)` × perPage 255 returns 2550 (6.9% over walked 2385, outside the 5% drift gate). Operator may prefer either `perPage=254` (gives 2540 → 6.5% — still over) or a runtime patch to strip commas in the html-pagination probe. Document the tradeoff in `auditNotes.countMethodDrift`.
- **Decide `catalogUrls` strategy explicitly** — single umbrella vs 7 subclass. R2 should weigh parallelism + category isolation vs URL-set minimization with a written justification.
