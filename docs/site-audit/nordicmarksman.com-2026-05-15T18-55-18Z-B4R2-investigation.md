# nordicmarksman.com - Batch 4 / Round 2 Investigation

**Run**: B4R2-2026-05-15T18-55-18Z (live verification of B4R1 candidate)
**Reviewer-persona**: testing-api-tester
**Operator-IP / time**: R2 IP, 2026-05-15T18:52-18:56Z
**Constraint**: NO DB writes; 800ms+ delay between requests; "Inconclusive" preferred over "guessed"

---

## TL;DR

R1 candidate is correct on 5 of 6 high-risk fields. The one disagreement is `perPage`: R1 shipped 50 as a "conservative baseline" but the platform default returns 20 and no `?limit=50` data point was ever taken. The `sitemap` vs `sitemap-index` runtime bug is REAL and reproducible. WAF passive re-confirmed end-to-end. R1's 11 catalogUrls are all live, all sorting correctly newest-first, with coherent monotonicity.

---

## 1. WAF heavy-probe re-verdict (REQUIRED)

**Live 5-batch heavy probe at 2026-05-15T18:53Z, R2 IP, against `https://nordicmarksman.com`:**

| Batch | Test | Result |
|---|---|---|
| A | 10x homepage rapid burst, 100ms apart | 10/10 HTTP 200 (249-316ms) - no rate-limit, no challenge |
| B | SQLi `1' OR '1'='1`, UNION SELECT, `<script>alert(1)</script>` in `?id=`/`?q=` | 3/3 HTTP 200 - no WAF rule fires |
| C | `/wp-admin/`, `/wp-login.php`, `/.env`, `/.git/config` | 4/4 HTTP 403 - origin (BC has no WordPress paths; not a WAF action) |
| D | UA = `python-requests`, `curl`, empty, `Googlebot` | 4/4 HTTP 200 - no UA filter |
| E | Header dump (apex) | Only `Server: cloudflare`, `cf-cache-status: DYNAMIC`, `CF-RAY: 9fc459203f36f46c-YYZ`, `__cf_bm` cookie. **No** `cf-mitigated`, **no** challenge HTML, **no** `x-sucuri`, **no** `incap`, **no** `x-cdn`. |

**Verdict: `wafType: 'cloudflare-passive'`, `hasWaf: false`.**

Per `.claude/skills/pre-bootstrap/SKILL.md` Stage 2 rule - `cf-ray` header + all 200 status + no plugin markers + no rule firings = Cloudflare as CDN-only, no WAF action.

R1 agrees. DB self-contradicts (`hasWaf=true` AND `wafType='cloudflare-passive'`). The DB-true value is the root cause of `perPage=20` runtime throttle (catalog-crawler reads `hasWaf` to gate WAF-cookie-manager + delay path).

---

## 2. R1's 11 catalogUrls coverage verification (REQUIRED)

Walked each at 2026-05-15T18:52Z with 1s inter-request delay. UA = Chrome/131.

| catalogUrl | Status | `class="card*"`+`data-product-id` hits | First 3 pids (`?sort=newest`) |
|---|---|---|---|
| `/accessories/?sort=newest` | 200 | 261 | 21958, 21958, 21958 |
| `/ammunition/?sort=newest` | 200 | 242 | 21991, 21990, 21989 |
| `/apparel-and-gear/?sort=newest` | 200 | 241 | 21895, 21894, 21893 |
| `/biathlon/?sort=newest` | 200 | 265 | 21173, 21173, 21173 |
| `/cleaning/?sort=newest` | 200 | 241 | 21657, 21656, 21655 |
| `/firearms-and-stocks/?sort=newest` | 200 | 241 | 22002, 22001, 22000 |
| `/hunting-essentials/?sort=newest` | 200 | 251 | 21431, 21431, 21431 |
| `/optics-lights/?sort=newest` | 200 | 245 | 21872, 21871, 21870 |
| `/reloading/?sort=newest` | 200 | 245 | 21841, 21840, 21839 |
| `/shotguns/?sort=newest` | 200 | 241 | 22002, 22001, 22000 |
| `/spare-parts/?sort=newest` | 200 | 241 | 21945, 21943, 21939 |

**All 11 pass.** Duplicated pid counts (e.g. biathlon `21173, 21173, 21173`) are the same product rendered 3x per card (image, title, link) on Stencil markup - verified by `grep | sort -u` returning 20 distinct pids per page. The shared first 3 pids between firearms-and-stocks and shotguns (22002,22001,22000 = canuck-pioneer-pump, commander-bronze, commander-green) confirm shotguns is a sub-category that lives inside firearms-and-stocks - overlap is intentional per Rule C (multi-category retail).

**R1 exclusions verified.**

- `/archery/`: 200, pids `21307,21306,21305`, bow/arrow non-firearm content - EXCLUDE OK per firearm-relevance rule.
- `/manufacturer/`: 200, 367KB, brand-tree aggregator (Browning/CZ/Glock pages each link to per-brand product subsets that already appear under product categories) - EXCLUDE OK per overlap rule.
- DB's `/categories.php` (the value R1 superseded): 200, 271KB, `<title>Categories - Nordic Marksman</title>` - this is the BC Stencil **category landing/index page**, listing categories with 20 featured products. It is **not** a per-category product listing. R1 correctly replaces it with the 11 per-category URLs.

**Sort monotonicity** (firearms-and-stocks):

- page 1 (sort=newest): 22002, 22001, 22000, 21999, 21998
- page 2 (sort=newest): 21918, 21917, 21916, 21915, 21913

Strictly descending pids, zero overlap. `?sort=newest` verified.

---

## 3. `sitemap` vs `sitemap-index` schema-mismatch runtime impact (REQUIRED)

### What DB stores

```json
"productCountMethod": {
  "method": "sitemap",
  "lastCount": 4605,
  "sitemapUrls": ["/xmlsitemap.php?type=products&page=1", "/xmlsitemap.php?type=products&page=2"]
}
```

### What the runtime code does

`backend/src/services/product-count-probe.ts:204-210` - case `'sitemap'`:

```ts
case 'sitemap': {
  const url = `${origin}${m.url}`;            // reads m.url (singular)
  const r = await axios.get(url, { headers, timeout: TIMEOUT, ...
  ...
  return count > 0 ? count : null;
}
```

`m.url` is `undefined` on the DB shape. URL evaluates to literal string `"https://nordicmarksman.comundefined/"`. axios DNS-fails with `ENOTFOUND nordicmarksman.comundefined`. Outer try/catch (lines 145-457) swallows the error and returns `null`.

### Live repro

`backend/_audit_tmp/test_nm_schema.ts` reproduced the failure at 2026-05-15T18:55Z:

```
URL computed by runtime: "https://nordicmarksman.comundefined/"
Error: getaddrinfo ENOTFOUND nordicmarksman.comundefined
```

### Why nothing is on fire today

`verifyBootstrapCoverage` (lines 466-488) short-circuits at line 477: it only invokes `probeExpectedProductCount` when stored `expectedProductCount` is `null`. DB has `expectedProductCount: 4605`, so the broken probe code path is never hit at steady state.

### When the bug bites

1. Operator clears `expectedProductCount` to force a re-count.
2. Any new site onboarded with the same wrong shape (which `pre-bootstrap` skill arguably did to this site originally).
3. Any reconcile/maintenance job that re-probes from scratch.

### Fix

R2 corrections.json sets `productCountMethod` to canonical multi-file shape that matches the `sitemap-index` switch arm at lines 212-224 (reads `m.urls` plural):

```json
"productCountMethod": {
  "method": "sitemap-index",
  "urls": ["/xmlsitemap.php?type=products&page=1", "/xmlsitemap.php?type=products&page=2"]
}
```

Live verification of the URL list: page=1 = 3023 `<loc>`, page=2 = 1688 `<loc>`, sum = **4711**.

---

## 4. Notable disagreement: `perPage`

R1 ships `perPage: 50`. DB has `perPage: 20`. Neither was directly verified.

Live verification 2026-05-15T18:54Z:

- `/accessories/` (no `?limit`): **20 unique** `data-product-id` - platform default
- `/accessories/?limit=2500`: **1438 unique** `data-product-id` - full category, honored
- `/firearms-and-stocks/?limit=500` (R1 claim): would return 441 (full firearms cat), honored

There is **no data point at limit=50**. R1's 50 is a guess between 20 (verified default) and 1438 (verified ceiling). R2 sets `perPage: 20` to match the platform default. Operator may raise to 100 if they want to halve request count (verified-honored range supports it), but that should be an explicit operator decision, not a candidate guess.

---

## 5. Files

- Candidate (R1): `docs/site-audit/nordicmarksman.com-2026-05-15T18-37-02Z-B4R1.json`
- R1 diff: `docs/site-audit/nordicmarksman.com-2026-05-15T18-37-02Z-B4R1-diff.md`
- R2 corrections: `docs/site-audit/nordicmarksman.com-2026-05-15T18-55-18Z-B4R2-corrections.json`
- R2 investigation: `docs/site-audit/nordicmarksman.com-2026-05-15T18-55-18Z-B4R2-investigation.md` (this file)
- Runtime repro script: `backend/_audit_tmp/test_nm_schema.ts`
- Code under review: `backend/src/services/product-count-probe.ts:148-224, 466-488`
- Caller: `backend/src/services/worker.ts:245-260`
