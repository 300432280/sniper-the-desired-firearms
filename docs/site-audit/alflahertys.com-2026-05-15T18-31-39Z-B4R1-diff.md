# alflahertys.com — Candidate vs DB siteProfile diff (B4R1)

- Candidate: `docs/site-audit/alflahertys.com-2026-05-15T18-31-39Z-B4R1.json`
- DB source: `MonitoredSite{domain:'alflahertys.com'}.siteProfile` (read 2026-05-15)

## Top-level columns (MonitoredSite)

| Field | DB | Candidate | Diverged? | One-line WHY |
|---|---|---|---|---|
| `adapterType` | `generic-retail` | `generic-retail` | no | — |
| `hasWaf` | `true` | `false` | YES | DB stores legacy hasWaf=true with sucuri-cookie-cache; current 8-batch probe from THIS audit IP shows cloudflare-passive only (all 200, no sucuri/malcare/sgcaptcha markers). Per Stage 2 rule `hasWaf` is operational (set true only when WAF actively blocks). IP-dependent — operator must reconfirm from production crawler IP before promoting. |
| `hasCaptcha` | `false` | `false` | no | — |

## siteProfile fields

| Field | DB | Candidate | Diverged? | One-line WHY |
|---|---|---|---|---|
| `platform` | `bigcommerce-stencil` | `bigcommerce-stencil` | no | — |
| `adapter` / `adapterType` | `generic-retail` | `generic-retail` | no | — |
| `hasWaf` | `true` | `false` | YES | Same as top-level row above — operational reclassification on cloudflare-passive (Stage 2 rule). |
| `wafType` | `cloudflare-passive` | `cloudflare-passive` | no | — |
| `wafWorkaround.method` | `sucuri-cookie-cache` | (omitted) | YES | Skill Stage 3 emits `wafWorkaround` only for malformed-header Celerant-style cases; this site has no header parsing issue. The DB's `sucuri-cookie-cache` is residue from a prior Sucuri classification — no Sucuri markers found in any of 8 probe batches. Removing it is safe given current evidence; restore if production crawler IP sees real challenges. |
| `needsPlaywright` | `true` | `true` | no | — |
| `userAgentOverride` | (absent) | `null` | no | DB profile omits the field (treated as null); candidate explicitly sets null. Equivalent. |
| `perPage` | `20` | `100` | YES | DB conservative for HTML fallback / WAF rate-limit posture. Candidate verifies Klevu API silently caps at 100 (limit=250 returns only 100). Operator picks lowest reasonable value at runtime; baseline = "fewest requests for full coverage" per Stage 5 anti-pattern. |
| `timeout` | `30000` | (omitted) | YES | DB-side knob, not in skill's output schema. Operator preserves on promotion. |
| `budget` | `120` | (omitted) | YES | Same — DB-side knob. |
| `hasRateLimit` | `false` | (omitted) | YES | Same — DB-side knob. |
| `siteCategory` | `retailer` | (omitted) | YES | Same — DB-side knob. |
| `t1IntervalMin` | `15` | (omitted) | YES | Same — DB-side scheduler knob, set at promotion. |
| `notes` | "BigCommerce + Klevu JS overlay..." | (omitted) | YES | Skill's `auditNotes.stageNotes` carries the same info structured per-stage; `notes` is operator audit-trail residue per Rule B. |
| `name` | `Al Flaherty's` | (omitted) | YES | DB-side; not a siteProfile runtime field. |
| `domain` | `alflahertys.com` | (filename only) | n/a | Domain encoded in filename, not duplicated in body. |
| `expectedProductCount` | `5262` | `5264` | YES | DB value 2 stale (sitemap+Klevu both returned 5264 today). Sites grow; re-derive every audit per Mistake 13. |
| `productCountMethod.method` | `klevu-api-count` | `json-api-count` | YES | Both are valid (both exist in product-count-probe.ts switch — `case 'json-api-count'` at line 156, `case 'klevu-api-count'` at line 302). DB uses platform-specific name; candidate uses generic name. Equivalent at runtime — operator preference. |
| `productCountMethod.endpoint` | (same URL) | (same URL) | no | — |
| `productCountMethod.apiKey` | `klevu-170966446878517137` | (in `field` instead) | YES | DB passes apiKey directly; candidate uses generic json-api-count with `field` drill-path. klevu-api-count case in runtime probably re-uses apiConfig.klevuApiKey anyway. |
| `catalogUrls` | 6 URLs (firearms, ammunition, optics, stocks-parts-barrels-kits, storage-transportation, als-bargains) | 9 URLs (same 6 + tactical-accessories, archery-and-airguns, knives-tools-and-lights) | YES | DB list is missing 3 nav top-level categories that exist on the homepage. Since the runtime walks via Klevu wildcard (not per-category HTML), this is documentation completeness only — does not affect coverage in practice. Candidate documents the full top-level set. |
| `sortParam` | `?sort=newest` | `null` | YES | DB stores an HTML BC-Stencil sort param. But: (a) BC HTML category pages return 0 products (Klevu hydrates client-side) so the HTML sort param is unreachable; (b) Klevu API rejects NEWEST/DATE_DESC enums (HTTP 500). Stored value is moot — not honored by either path. |
| `sortVerified` | (absent) | `false` | YES | DB never recorded — skill explicitly sets false. |
| `paginationPattern` | (absent) | `{type:'api-offset', template:'offset={N}', perPage:100, ...}` | YES | DB has no paginationPattern key at all; runtime crawler computes from `perPage` + Klevu offset internally. Candidate makes it explicit per Stage 5 contract. |
| `crawlers.watermark.method` | `full-catalog-sweep` | `full-catalog-sweep` | no | — |
| `crawlers.watermark.reason` | (absent) | (detailed reason cite Klevu sort 500) | YES | DB has `crawlers.watermark.notes` instead — same content, different key name. Skill Stage 7 mandates `reason` field; DB uses `notes`. |
| `crawlers.watermark.notes` | "No date-based sort..." | (omitted, content in `reason`) | YES | Key rename — DB `notes` -> candidate `reason` per Stage 7 contract. |
| `crawlers.bootstrap.apiEndpoints` | `null` | `{klevu:<url>, klevuApiKey:<key>}` | YES | DB null; candidate populates with the actual Klevu endpoint and key (which DB stores under top-level `apiConfig` — same data, different nest). Stage 3 contract: `bootstrap.apiEndpoints` documents the API the bootstrap crawler hits. |
| `crawlers.bootstrap.method` | `single-continuous` | (omitted) | YES | DB-side scheduler/orchestrator hint; not in skill's output schema. |
| `crawlers.bootstrap.htmlFallback` | `true` | (omitted) | YES | Same — DB hint not in skill schema. |
| `crawlers.maintain.verifyMethod` | `detail-page` | `detail-page` | no | — |
| `crawlers.maintain.verifyEndpoint` | (absent) | `null` | no | DB omits; candidate explicitly nulls. Equivalent. |
| `crawlers.maintain.method` | `db-verification` | (omitted) | YES | DB hint; not in skill schema. |
| `crawlers.maintain.cooldowns` / `tierShares` / `tierWindows` | (DB scheduler config) | (omitted) | YES | DB-side scheduler knobs; skill doesn't emit. |
| `dataFlow.steps` | 2 entries (Klevu Search API, Klevu Count API) | (omitted) | YES | DB operator-curated documentation, not a runtime field. Rule B — skill emits only runtime fields. |
| `apiConfig.klevuApiKey` | (same) | (same) | no | — |
| `apiConfig.klevuEndpoint` | (same) | (same) | no | — |
| `apiConfig.klevuCategoryPaths` | 8 entries | 8 entries (same) | no | Verbatim copy preserved. |
| `searchUrl` | `/search.php?search_query={keyword}` | (same) | no | — |
| `extractionTested` | (absent) | `true` | YES | Skill mandates per Stage 4g; DB never recorded. |
| `extractionSample` | (absent) | 3 products with title/url/price/stock | YES | Skill mandates per Stage 4g evidence requirement. |
| `lastVerified` | `2026-04-06` | `2026-05-15` | YES | Audit date update. |
| `profileVersion` | (absent) | `1` | YES | Skill mandates per Stage 9. |
| `auditNotes` | (absent) | populated (runId, probeIp, fieldConfidence, stageNotes) | YES | Skill emits per Stage 9. |
| `wafLastProbedAt` / `wafProbeMethod` / `wafProbeResult` / `wafProbeEvidence` | (absent) | populated | YES | Skill Stage 2 outputs; DB never recorded. |
| `ageGate` | (absent) | `{detected:false, type:null, bypassCookie:null}` | YES | Skill Stage 3 mandates the object; DB never recorded (implicitly no age-gate). |
| `topLevelCategories` | (absent) | populated | YES | Skill Stage 4 recommended output; DB never recorded (raw `catalogUrls` only). |

## Divergent-field count
**24** fields diverge (mix of operational reclassification, DB-side scheduler knobs the skill schema doesn't carry, and skill-emitted evidence fields the DB doesn't store).

## Most surprising divergences

1. **`hasWaf: true -> false` + `wafWorkaround` removal.** DB profile carries a `sucuri-cookie-cache` workaround AND `hasWaf: true`, but `wafType: 'cloudflare-passive'`. Today's 8-batch probe sees zero Sucuri markers anywhere — no `x-sucuri-id` header, no `sucuri_cloudproxy_js` body, no challenge HTML. The DB record appears to be stale residue from an earlier mis-classification where the audit IP got challenged, OR the site genuinely changed CDN posture. IP-dependent — the candidate downgrades but flags `medium` confidence and asks the operator to reconfirm from production IP.

2. **`perPage: 20 -> 100`.** DB stays conservative; Stage 5 mandates probing the verified maximum. Klevu silently caps at 100 (limit=250 still returns only 100), so 100 is the verified ceiling. 5x fewer requests for the same coverage if the site keeps tolerating it.

3. **`sortParam: '?sort=newest' -> null`.** Stored DB sort param is doubly unreachable: (a) BC HTML category pages return 0 products (Klevu hydrates client-side, so any HTML sort is moot); (b) Klevu API itself rejects `NEWEST`/`DATE_DESC`/`NAME_ASCENDING` sort enums with HTTP 500 — only `RELEVANCE` and `PRICE_ASC` are honored on this Klevu instance. The stored `?sort=newest` is decorative, not functional. (Watermark method `full-catalog-sweep` is the same in both — that part of the DB record is correct.)

## SKILL.md / harness gaps

1. **Stage 4 (extractionSample) does not handle the BC-Stencil + Klevu pattern explicitly.** The static HTML for every BC category page returns 0 products; without context this falsely reads as "all catalog URLs broken" and could push an auditor toward `full-catalog-sweep` for the wrong reason. The skill should add a note: "If the platform is `bigcommerce-stencil` AND `js.klevu.com/.../category-page.js` is in the homepage script list, page-1 HTML extraction returns 0 by design — verify Klevu API works (POST `<klevuEndpoint>` body `{context:{apiKeys:[<key>]}, recordQueries:[{settings:{query:{term:'*'},limit:1,offset:0,sort:'RELEVANCE'}}]}`), use API count as `expectedProductCount`, preserve HTML category URLs as `catalogUrls` start points for the HTML fallback (where they return 0 — acceptable)." Currently auditors must re-derive this from `generic-retail.ts:362-446`.

2. **Stage 6 omits the "Klevu sort enum is constrained" lesson.** Klevu accepts `RELEVANCE` and `PRICE_ASC` on this instance but rejects `NEWEST`/`DATE_DESC`/`NAME_ASCENDING` with HTTP 500. SKILL.md Stage 6 walks through Magento/OpenCart/Searchspring/Shopify quirks but never mentions Klevu. Add: "Klevu instances vary in supported sort enums per merchant. Test each candidate value with a 1-record probe; expect 500 'Invalid request or server error' on unsupported enums."

3. **Stage 8 table treats `klevu-api-count` (method 10) and `json-api-count` (method 2) as distinct, but both exist in `product-count-probe.ts` switch and serve the same site.** The skill should document the choice criterion: prefer `klevu-api-count` when the runtime config wants apiKey as a top-level field (matches DB convention here); prefer `json-api-count` when the operator wants the generic drill-path. Both are correct but the diff cost of randomly picking one is high (B4R1 picked `json-api-count` and produced a divergent field that's actually equivalent).
