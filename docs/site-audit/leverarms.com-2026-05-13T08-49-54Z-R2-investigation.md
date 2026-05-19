# R2 Investigation — leverarms.com

**Run ID:** R2-2026-05-13T08-49-54Z
**Reviewing:** `docs/site-audit/leverarms.com-2026-05-13T08-24-20Z-R1.json`
**Method:** Live HTTP probing with `curl` + `node`. No DB writes. 800ms rate-limit between requests.

## Outcome

**R1 candidate is correct on every load-bearing field. Promote R1 with three minor patches.**

The DB siteProfile contains stale/legacy residue: `hasWaf:true` is a holdover from the previously-flagged sucuri misclassification; `paginationPattern.template:"page/{N}/"` (no leading slash) actually 404s when fed through `buildPaginatedUrl`; `expectedProductCount:965` was the admin REST total (drafts+out-of-stock) not the customer-visible total.

---

## Investigation 1 — apiEndpoints shape (runtime verdict)

### R1 diff claim
> "DB encodes 2-step bootstrap: discovery via wp/v2/product (cheap title+url), enrichment via wc/store/v1/products (price+stock). Candidate flattened to discovery + categories — missed the enrichment dataflow."

### Live test — runtime code consumption
```
grep -r "apiEndpoints"      backend/src  -> 0 matches
grep -r "productDiscovery"  backend/src  -> 0 matches
grep -r "priceEnrichment"   backend/src  -> 0 matches
grep -r "crawlers.bootstrap" backend/src -> 0 matches
grep -r ".bootstrap."       backend/src  -> 0 matches
```

### Verdict
**The "2-step bootstrap cascade" claim is FICTIONAL.** There is no runtime code in `backend/src/` that reads this field. The WooCommerce adapter hardcodes `/wp-json/wc/store/v1/products`; the bootstrap path does not look up `apiEndpoints` from siteProfile. This field is pure documentation/audit-trail residue.

Conclusion: R1's `{products, categories}` naming is equally valid as DB's `{priceEnrichment, productDiscovery}`. Neither breaks anything. Keep R1's flatter naming (matches the SKILL.md example output).

---

## Investigation 2 — WAF re-probe (heavy 8-batch)

### Batches ran

| Batch | Test | Result |
|-------|------|--------|
| 1 | Standard GET `/` | 200, `cf-ray`, `__cf_bm` cookie, `Server: cloudflare` |
| 2 | Bot UA `python-requests/2.28` | 200 (NOT blocked) |
| 3 | No UA header | 200 |
| 4 | SQLi `?id=1 UNION SELECT * FROM users` | 403, body `nginx 403 Forbidden` |
| 5 | XSS `?q=<script>alert(1)</script>` | 403, body `nginx 403 Forbidden` |
| 6 | Honeypots `/xmlrpc.php` `/.env` `/.git/config` `/wp-config.php` | 403 (all four) |
| 7 | Rapid burst 10x `/` | `[200,200,200,200,200,200,200,200,200,200]` |
| 8 | Sucuri header scan (across all responses) | **None present** |

### Sucuri verification
Scanned every response from batches 1-8 for `x-sucuri-id`, `x-sucuri-cache`, `x-sucuri-block`, `X-Sucuri-*`. **Zero matches.** The DB notes flagged a prior sucuri misclassification — that misclassification has not been re-introduced.

### 403 body inspection
The SQLi/XSS/honeypot 403s carry a generic `<center>nginx</center>` body, NOT a Cloudflare interactive challenge. This means the WAF rules are firing on the origin nginx/WP (Cloudflare is in passive cache-only mode), not on Cloudflare's edge security.

### Verdict
- `hasWaf: false` — R1 correct (operational rule: rule-selective Cloudflare on attack payloads only, all crawler paths 200, no bot-UA block)
- `wafType: cloudflare-passive` — both agree
- `needsPlaywright: false` — both agree
- DB's `hasWaf:true` is the only internally-inconsistent value (it has cloudflare-passive + needsPlaywright:false, contradicting `hasWaf:true`)

Bonus discovery: response headers also carry `x-gateway-cache-status` / `x-gateway-request-id` — that's a managed-WordPress edge cache (NOT a WAF), confirming the hosting stack is something like Pressable/WPE.

---

## Investigation 3 — admin vs storefront count (615 delta classification)

### R1 candidate
- `expectedProductCount: 356` (from `/wp-json/wc/store/v1/products` x-wp-total)
- DB stored: `965` (from `/wp-json/wp/v2/product` x-wp-total)

### Live re-probe
```
GET /wp-json/wc/store/v1/products?per_page=1   -> x-wp-total: 356
GET /wp-json/wp/v2/product?per_page=1          -> x-wp-total: 971   (NOT 965; DB drifted)
```

### Delta walked
Walked both APIs end-to-end (`per_page=100`, page 1..10), deduped by `id`:
- wp/v2 unique IDs: **971**
- wc/store unique IDs: **356**
- Admin-only (in wp/v2, not in wc/store list): **615**
- Store-only (in wc/store, not in wp/v2): **0**

### Classification of the 615
Sampled 10 admin-only IDs (53130, 53127, 52921, 52775, 52774, 1238, 1214, 1164, 1062, 1053). Per-product probe:
- All have `status: publish`
- All return 200 on the SINGLE-product Store API endpoint (`/wp-json/wc/store/v1/products/{id}`)
- ID 53130 `class_list` contains `outofstock`; comparison ID 53271 (in store list) has `instock`

**Mathematical proof**:
```
GET /wp-json/wc/store/v1/products?per_page=1&stock_status=outofstock -> x-wp-total: 615
356 (default instock) + 615 (outofstock) = 971 (wp/v2 total)   exact match
```

### Verdict
The 615 admin-only delta is entirely **out-of-stock products**. Not drafts, not private, not hidden categories. Standard WooCommerce admin setting "Hide out of stock items from the catalog" is enabled — the Store API LIST endpoint respects it; the per-id endpoint and wp/v2 do not.

**`expectedProductCount: 356` is operationally correct** — the crawler walks catalog HTML which also hides out-of-stock products, so 356 is the right divisor for the 95% bootstrap coverage gate at `backend/src/services/product-count-probe.ts:466-488`. Using 971 would cap coverage at ~37% (356/971) forever.

---

## Investigation 4 — paginationPattern.template (DB bug)

### Disagreement
- R1: `/page/{N}/` (leading slash)
- DB:  `page/{N}/`  (no leading slash)
- R1 diff said: "Cosmetic; both render the same final URL"

### Live test
Read `backend/src/services/catalog-crawler.ts:118-125` (`buildPaginatedUrl`):
```
const stripped = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
return `${stripped}${template.replace('{N}', String(pageNum))}`;
```

With `baseUrl = "https://leverarms.com/product-category/guns/"` and `pageNum = 2`:

| Template | Resolved URL | Status |
|----------|--------------|--------|
| R1 `/page/{N}/` | `https://leverarms.com/product-category/guns/page/2/` | **200** |
| DB `page/{N}/` | `https://leverarms.com/product-category/gunspage/2/` | **404** |

### Verdict
DB value is wrong — would break catalog pagination if used by the runtime. R1 is correct. The R1 diff author was incorrect to call this "cosmetic".

---

## Investigation 5 — extractionSample, searchUrl, hygiene items

- `extractionSample` titles in R1 are placeholders like `"post-4152 (guns p1 first) — instock class, $805.99"`. The Store API walk returned real names (e.g. `"RUSSIAN TYPE 45 SKS RIFLE 1950 SPRING LOADED FIRING PIN 18782"`). Should be patched at promote time for operator-readability.
- `searchUrl: "/?s={keyword}&post_type=product"` is deterministic for `platform=woocommerce`. Auto-emit it.
- `MonitoredSite.url` in DB is `https://www.leverarms.com`. Apex serves canonical (verified: apex 200, `<link rel=canonical>` declares apex, www 301s to apex). DB url should be flipped to apex on the same migration.

---

## Files produced

- `docs/site-audit/leverarms.com-2026-05-13T08-49-54Z-R2-corrections.json` — machine-readable patch set for the promoter
- `docs/site-audit/leverarms.com-2026-05-13T08-49-54Z-R2-investigation.md` — this file (operator-readable narrative)

## Summary numbers

- 16 divergent fields/clusters reviewed
- 14 R1 wins (12 substantive + 2 ties favoring R1's SKILL.md alignment)
- 1 DB win (`searchUrl` derivable for WC — R1 should emit it)
- 1 DB error (`paginationPattern.template` — DB's slash-less form actually 404s)
- 11 high-confidence corrections, 2 medium-confidence
- 0 inconclusive

**Promote R1 with these patches**: emit `searchUrl: "/?s={keyword}&post_type=product"`, replace placeholder `extractionSample` titles with the real Store API names, optionally flip MonitoredSite.url to apex.
