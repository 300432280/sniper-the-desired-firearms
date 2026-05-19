# Pre-Bootstrap Output — sfrc.ca

> **Result: FAILURE — Stage 1 abort.** The domain `sfrc.ca` no longer hosts a firearms retail site. Both apex (`sfrc.ca`) and `www.sfrc.ca` 301-redirect to `https://lamontagnegf.ca/`, a static "Lamontagne — Groupe financier" landing page for a Quebec financial services firm in Thetford Mines, QC. No e-commerce content remains on any path. WAF probe ran cleanly against the destination (no WAF, nginx, all 200s) but the destination is not the target — the target site is defunct/repurposed.

---

## 1. At a glance

| What | Value |
|---|---|
| Site platform + adapter | **n/a — domain repurposed (not a firearms retailer anymore)** |
| Protections summary | n/a — destination has no WAF, but destination is irrelevant |
| Catalog size summary | **0 products** — no e-commerce content at destination |
| Page-walking summary | n/a — Stage 4+ never reached |
| Sort summary | n/a |
| New-item crawl method | n/a |
| Maintain verify method | n/a |

---

## 2. Identity

| field | value |
|---|---|
| `platform` | `null` (no platform fingerprints applicable — destination is a hand-coded static page, not a commerce platform) |
| `adapterType` | `null` |

The `https://www.sfrc.ca/` and `https://sfrc.ca/` hosts both 301-redirect to `https://lamontagnegf.ca/`. The destination body is a 4,382-byte hand-coded static HTML page for a financial services firm; there is no Shopify / Woo / BigCommerce / Celerant / Wix / Lightspeed / Drupal-Commerce / etc. fingerprint. Markup includes `<title>Lamontagne — Groupe financier</title>`, `og:url=https://lamontagnegf.ca/`, French-language content listing insurance brokerage, mortgage brokerage, investment products (REER/CELI/etc.), and estate planning services.

---

## 3. Access — getting in safely

| field | value | meaning |
|---|---|---|
| `hasWaf` | **`false`** (for destination — irrelevant) | All 8 batches of heavy-waf-probe returned 200 against `lamontagnegf.ca` with consistent ~110ms timing, no challenge bodies, no `cf-ray`, no `x-sucuri`, no Incapsula, no SiteGround, no rate-limit triggers. |
| `wafType` | `null` | No WAF markers present on destination. |
| `wafLastProbedAt` | `2026-05-09T14:11:05.844Z` | |
| `wafProbeMethod` | `heavy-8-batch` | |
| `hasCaptcha` | `false` | No `recaptcha`, `hcaptcha`, or `turnstile` script tags in destination body. |
| `captchaType` | `null` | |
| `ageGate.detected` | `false` | Not a firearms site, no age-gate present. |
| `userAgentOverride` | `null` | n/a |
| `needsPlaywright` | `false` | n/a |

> **Probe evidence summary:** Heavy 8-batch WAF probe ran from canonical destination `https://lamontagnegf.ca/` (because pre-flight detected the apex redirect). Results: BATCH 1 (single-GET) — all 200 / `Server: nginx` only / no `cf-ray` / no `x-sucuri`. BATCH 2 (multi-UA) — desktop / mobile / bot / curl all 200, identical 4382-byte body. BATCH 3 (rapid 10-burst) — all 200, no rate-limit. BATCH 4 (honeypot paths) — `/wp-admin/`, `/wp-login.php`, `/xmlrpc.php`, `/.env`, `/.git/config`, `/phpinfo.php` all return 404 (`548 BYTES`) — origin is not WordPress, so honeypots simply 404 rather than being WAF-blocked. BATCHES 5-8 (barebones / SQLi / XSS / no-UA) — all 200, no rule firings. **Destination has no WAF and is a static nginx site. This signal is irrelevant to the original target `sfrc.ca` because `sfrc.ca` no longer serves any commerce content.**

---

## 4. Catalog discovery — where the products are

**Not reached.** No catalog exists. Five legacy firearm-shaped paths probed:

| Probed path | Result |
|---|---|
| `https://www.sfrc.ca/shop` | 301 -> `https://lamontagnegf.ca/shop` (same landing page, no shop) |
| `https://www.sfrc.ca/products` | 301 -> `https://lamontagnegf.ca/products` (same landing page) |
| `https://www.sfrc.ca/store` | 301 -> `https://lamontagnegf.ca/store` (same landing page) |
| `https://www.sfrc.ca/wp-json/wp/v2/product?per_page=1` | 301 -> equivalent path on lamontagnegf.ca (no WP REST at destination) |
| `https://www.sfrc.ca/sitemap.xml` | 301 -> `https://lamontagnegf.ca/sitemap.xml` (404 at destination) |

`extractionTested = false` (n/a — no extractable catalog exists).

---

## 5. Pagination & sort — how to traverse

**Not reached.**

---

## 6. Inventory size

| field | value |
|---|---|
| `expectedProductCount` | `0` |
| `productCountMethod` | `null` (no count source applicable) |

> **Source:** Direct inspection of the destination homepage HTML (4382 bytes, hand-coded static page). The body lists business services in `<ul>` form (insurance/mortgage/investment categories) but contains zero product cards, zero `add-to-cart` markers, zero pricing, and zero linked product URLs. The only `<a href>` outbound links are: a Google Maps embed for the operator's office address, a `mailto:` link, and a `tel:` link.

---

## 7. Crawler config — runtime behavior

**Not reached.** No crawler configuration is meaningful for a defunct domain.

| Phase | field | value | what it means |
|---|---|---|---|
| watermark | `crawlers.watermark.method` | `null` | n/a |
| bootstrap | `crawlers.bootstrap.apiEndpoints` | `null` | n/a |
| maintain | `crawlers.maintain.verifyMethod` | `null` | n/a |
| maintain | `crawlers.maintain.verifyEndpoint` | `null` | n/a |

> **Watermark reason:** "Domain `sfrc.ca` is defunct as a firearms retailer. It now serves a static financial-services landing page at `lamontagnegf.ca`. There is no inventory to watermark, no API to bootstrap, and no detail-page to maintain-verify."

---

## 8. Platform extras

| field | value |
|---|---|
| `classifiedRules` | `null` (not a classifieds site) |
| `ecwidStoreId` | `null` (not an Ecwid site) |

---

## 9. Provenance

| field | value |
|---|---|
| `profileVersion` | `1` |
| `lastVerified` | `2026-05-09` |
| `result` | `FAILURE` |
| `abortStage` | `1` |
| `abortReason` | `domain-repurposed-non-firearms` |
| `auditNotes.runId` | `sfrc.ca-2026-05-09T14-11-05-844Z` |
| `auditNotes.watchdogPriorVerdict` | unknown — task instructions forbade reading prior audit / DB / siteProfile for this site |

### Field confidence

| field | confidence | basis |
|---|---|---|
| Domain status | **high** | 301 chain confirmed via two independent curls (HEAD + GET-follow). Body byte-identical between apex and www (`cmp -s` match). |
| Destination identity | **high** | Body contains operator's full business name, French-language services list, postal address, phone, copyright year — actively-served business, not a registrar parking page. |
| Absence of firearm content | **high** | 5 firearm-retail-shaped paths tested (shop/products/store/wp-json/sitemap); all 301-redirect into the same financial-services landing page with no commerce content. |
| WAF status of destination | **high** | Heavy 8-batch probe ran cleanly. But this signal is **not relevant** to the original target — recorded for completeness only. |

### Stage notes

1. **Stage 1 (canonical URL):** `https://www.sfrc.ca/` returns `301 Location: https://lamontagnegf.ca/` (`Server: nginx`); GET-follow lands at a 200 / 4382-byte static page titled "Lamontagne — Groupe financier". Apex `https://sfrc.ca/` returns identical body (`cmp -s` match). The destination is a different business entity (Quebec financial services firm in Thetford Mines, QC). **Aborting harness here per the SKILL Stage-1 "site dead" rule, generalized: the original target is functionally dead even though DNS resolves.**
2. **Stage 2 (WAF probe):** Ran the 8-batch heavy probe for completeness. Probe target was rewritten by pre-flight to `https://lamontagnegf.ca/` (the canonical destination). All 8 batches returned 200, no WAF markers. Destination would classify as `hasWaf: false` if it were the actual target, but it is not.
3. **Stages 3-9:** Not executed. No platform exists at the destination, no catalog, no products, no crawler config to derive.

### Judgment calls

- The SKILL's Stage-1 abort triggers list "site dead, DNS dead, all responses challenge with no body". The literal text doesn't include "domain re-purposed". I extended the abort rule to this case because the spirit of the gate is the same: **there is no firearms retail site at this domain to onboard**. The user's task brief explicitly anticipated this — "even a 'site dead, abort with FAILURE artifact' outcome is a valid calibration result."
- I did not bypass Hard Rule 1 (no reading prior `docs/site-verification/sfrc*` or `docs/site-audit/sfrc*` files), Hard Rule 2 (no DB query), Hard Rule 3 (no reading existing siteProfile), or Hard Rule 4 (no code/DB/SKILL.md modifications). The verdict is built only from live curls + heavy-waf-probe output produced this run.
- I did not run a Playwright fallback (Mistake 19) because the issue is not "static HTML returns 0 products" — it's "static HTML returns a different business's landing page". Playwright would render the same 4382-byte page; rendering doesn't change the redirect target or insert firearm content.
- I did not run a UA ladder (Mistake 7 / persona rule 1) because all 4 UAs in BATCH 2 (desktop / mobile / bot / curl) returned identical 4382-byte landing-page responses. UA-rotation does not change the DNS / redirect destination.

### Recommendation

Mark `sfrc.ca` as defunct in the seed list. If the operator wants firearm-retail data from a former SFRC location, the operator must re-locate the business by name on a currently-active domain (the SFRC initials are unknown — the brief itself notes the site "may be defunct" and "was previously removed from the project's seed list"). Pre-bootstrap cannot manufacture a profile against a domain that no longer hosts firearms retail content.
