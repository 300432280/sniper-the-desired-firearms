# B5R3 Counter-Investigation — gagnonsports.com

**Round:** 3 of 4 (adversarial — attack R2)
**Date:** 2026-05-23T23:00:00Z
**Mission:** Disprove R2's reversals (hasWaf=false, perPage=100, /firearms/* tree, /sale/.../new-used-guns/ add, html-pagination)
**Method:** 50-burst sustained walk per ACTUAL 4 production UAs from `backend/src/services/scraper/http-client.ts:9-14`; live re-walk; slug-level dedup; pagination shape probe.
**Constraint:** 800ms delay, no DB writes.
**Artifacts:** `_audit_tmp/gagnon-b5r3.js`, `_audit_tmp/gagnon-b5r3-out.txt` (T1), `_audit_tmp/gagnon-b5r3-out2.txt` (T2-T4 with corrected regex).

---

## CRITICAL NEW FINDING — apex vs www host divergence

R2's script targeted `gagnonsports.com` (apex). The **canonical host is `www.gagnonsports.com`** (Cloudflare-fronted, status=200 across all production UAs). The apex `gagnonsports.com` is served by a **different openresty origin** returning:
- `403 Forbidden` for Win-Chrome / Mac-Safari UAs (50/50 each)
- `404 Not Found` for Linux-Firefox / Win-Edge UAs (50/50 each)

**`siteUrl` MUST be `https://www.gagnonsports.com`**. If DB stores `gagnonsports.com` apex, the crawler hits openresty (403/404) not Cloudflare (200). R1+R2 both blind to this — it dominates every other field because hasWaf=false is meaningless if the crawler points at the wrong origin.

---

## T1 — hasWaf 50-burst per actual production UA pool (corrected to www)

| UA (from `http-client.ts:9-14`) | 200s | 403/429/503 | CF-challenge | avgMs |
|---|---|---|---|---|
| win-chrome (idx 0) | 50/50 | 0 | 0 | 300 |
| mac-safari (idx 1) | 50/50 | 0 | 0 | 301 |
| linux-firefox (idx 2) | 50/50 | 0 | 0 | 299 |
| win-edge (idx 3) | 50/50 | 0 | 0 | 302 |

200/200 across the FULL production pool against `www.gagnonsports.com`. R2 tested 5 UAs but mixed in `iphone-safari` + `android-chrome` UAs not in `USER_AGENTS` at `http-client.ts:9-14`, and missed `win-edge`. R3 corrects this. **CF passive, not gating. hasWaf=false confirmed (with host caveat).**

## T2 — /firearms/* leaf re-walk (different time vs R2)

| URL | R2 count | R3 count | Δ |
|---|---|---|---|
| /firearms/new-firearms/centerfire-rifles/ | 47 | 47 | 0 |
| /firearms/new-firearms/rimfire-rifles/ | 30 | 30 | 0 |
| /firearms/new-firearms/shotguns/ | 74 | 74 | 0 |
| /firearms/new-firearms/air-guns/ | 16 | 16 | 0 |
| /firearms/used-firearms/used-rifles/ | 42 | 42 | 0 |
| /firearms/used-firearms/used-shotguns/ | 19 | 19 | 0 |
| **Total** | **228** | **228** | **0** |

R2 counts reproduce exactly. /firearms/* tree inclusion (6 productive leaves) confirmed.

## T3 — /sale/.../new-used-guns/ Rule-C dedup proof (R2's admitted weakness)

Slug-level overlap of /sale/.../new-used-guns/ vs union of used-rifles + used-shotguns:

```
saleCount: 31
overlapWithUsedFirearms: 6  (only 6 of 31 are also in /firearms/used-*)
uniqueToSale: 25            (25 firearm products NOT reachable via /firearms/* tree)
```

**R2's call to INCLUDE is RIGHT but R2's REASONING is wrong.** R2 hand-waved "likely overlap is dedup-handled". Actual: 25/31 (81%) are UNIQUE to the sale URL. Dropping it costs 25 firearm products of real coverage — not a Rule-C technicality. Sample unique slugs include `beretta-a400-xtreme-plus-synthetic-...`, `copy-of-browning-bar-mark-4-hunter-30-06-...`. The "copy-of-" prefix suggests new SKUs derived from existing catalog entries — distinct slugs that URL-level dedup will not collapse.

## T4 — productCountMethod=html-pagination shape gate

`product-count-probe.ts:222-230` (case `'html-pagination'`) requires `m.url` + `m.selector` + `m.regex` to extract last-page-number text from a CSS-selector match. Live `/collection/` HTML inspection:

- Pagination class found: `class="page-filters first"` only — **no** `pagination`/`pager` class with a last-page link.
- Only `<link rel="next" href=".../collection/page2.html"/>` exists; NO `rel="last"`, NO full page-number list, NO "Page X of Y" text.
- LightSpeed URL convention is path-segment `/collection/pageN.html`, NOT `?page=N` query param.
- No total-product count in head/meta.

**Bug both R1 and R2 missed**: the canonical `html-pagination` shape cannot be satisfied on the first /collection/ page — there is no element whose text contains the last page number. The probe at L222-230 will return `null` (last selector match empty → `parseHtmlPaginationCount('', regex, perPage)` → null). R2 dismissed DB's `sitemap-flat` as non-canonical but did not verify `html-pagination` actually resolves. Suggest `sitemap` (canonical, in 11-method list at L110-122) instead.

## T5 — perPage 100

R2's side-by-side timing (p100 285ms vs p24 280ms; 1.8% noise) accepted. R3 did not contradict (50-burst at p=24 produced 0 blocks; no evidence p=100 would behave differently). **No counter.**

---

## Field-by-field counter-verdicts

| Field | R2 | R3 counter-verdict | Severity |
|---|---|---|---|
| **siteUrl host** | `gagnonsports.com` (implicit apex) | **MUST be `www.gagnonsports.com`** (apex returns 403/404) | **BLOCKING** |
| hasWaf | false | false **(only if siteUrl is www)** | confirmed |
| wafWorkaround | null | null (www host) | confirmed |
| userAgentOverride | null | null (4/4 production UAs clean on www) | confirmed |
| perPage | 100 | 100 (R2's timing accepted) | confirmed |
| /firearms/* 6 leaves | INCLUDE | INCLUDE — 228 products reproduce exactly | confirmed |
| /sale/.../new-used-guns/ | INCLUDE (dedup handles overlap) | INCLUDE — **25/31 are UNIQUE not "overlap"** | confirmed (reasoning corrected) |
| /previously-owned-merchandise/ | INCLUDE | not re-tested; 1 product is marginal | accept R2 |
| productCountMethod=html-pagination | accepted | **shape-valid but probe returns null** — no last-page selector exists | **NEW BUG** |
| expectedProductCount 2706 | within 5% gate | not re-validated | accept R2 |

## Where R2 was WRONG

1. **Missed canonical-host issue.** R2 ran against apex; apex returns 403/404. Dominates everything else.
2. **/sale/.../new-used-guns/ reasoning.** Not "overlap dedup-handled" — 25/31 are unique. The URL is more load-bearing than R2 stated.
3. **productCountMethod=html-pagination not functionally verified.** Probe will return null. Neither R1 nor R2 tested the probe end-to-end.

## Where R2 was RIGHT

1. /firearms/* tree exists, 228 products, DB note is stale.
2. hasWaf=false against www-host, full production UA pool clean.
3. perPage=100 vs 24 timing within noise.
4. /sale/.../new-used-guns/ INCLUDE (right call, wrong reasoning).

## Recommendation for R4 synthesis

- **MANDATORY**: confirm DB `siteUrl` is `https://www.gagnonsports.com`, not apex. Higher priority than any catalogUrl/perPage change.
- Accept R2's catalogUrls but **document that /sale/.../new-used-guns/ contributes 25 unique firearm products, not overlap-dedup**.
- **Replace productCountMethod with `sitemap` or set to null**; current `html-pagination` shape cannot return a count on this site.
- DB defensive iPhone UA can be dropped; 4/4 production UAs clean on www.
