# Site Investigation Issue Log

Tracks issues found by `investigate-site.js` across runs. Used to identify repeating patterns and regressions.

## How to read
- **NEW**: First time this issue appeared
- **RECURRING**: Same issue seen in previous run(s)
- **RESOLVED**: Issue was present before but is now fixed
- **EXPECTED**: Known limitation, not a bug
- **SCRIPT**: Investigation script limitation, not an app issue

---

## Run: 2026-03-25 05:00 UTC (10 sites, FULL 52-keyword mode)

### aagcanada.ca — PASS:17 WARN:1 FAIL:1
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| 10 dead + 1 sold products | HIGH | RECURRING | D2: 11 stale products (10 confirmed 404, 1 sold). Daily stale checker will auto-clean. |
| 3 expired cooldowns | MEDIUM | RECURRING | Scheduler should reset on next tick |
| Coverage 97% in 3d | — | PASS | Healthy |

### alflahertys.com — PASS:14 WARN:2 FAIL:2
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| Watermark never finds products | HIGH | RECURRING | A2: All 50 events found 0 products. T1 watermark runs but discovers nothing. Klevu API stream works for T2-T4 (86% coverage). Possible: watermark uses HTML scraping which finds 0 on Klevu-rendered pages. |
| 5 systematic price mismatches | HIGH | NEW | C3: Pages show multiple prices (variants/sale). DB stores one price, scraper picks a different one on re-check. |
| DB exceeds live by 448% | MEDIUM | RECURRING | D1: 1290 DB vs ~288 live. HTML pagination estimate is wrong (only counts one category). Not a real issue. |
| Tags 88% | MEDIUM | RECURRING | Some products missing tags from Klevu API |

### alsimmonsgunshop.com — PASS:16 WARN:3 FAIL:0
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| Coverage 35% in 3d | MEDIUM | RECURRING | Budget 60 for 1619 products. Daily auto-adjuster will handle. |
| "gun case" missing from DB | MEDIUM | NEW | 1 live result not in DB yet |
| No issues | — | PASS | Clean site. Previously had T4 stuck 14 days — now RESOLVED by scheduler fix. |

### budgetshootersupply.ca — PASS:15 WARN:3 FAIL:1
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| 4 confirmed dead products | HIGH | RECURRING | D2: BARNES .308, Missouri Bullet, SPEER .308, WILSON WSM. Daily stale checker will auto-clean. |
| Coverage 40% in 3d | MEDIUM | RECURRING | Budget 90 for 2717 products. Appropriate tier. |
| 2 stock mismatches | MEDIUM | NEW | WILSON WSM and Eagle Copper Shot show in_stock in DB but OOS on live site |

### bullseyenorth.com — PASS:13 WARN:3 FAIL:1
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| All UAs blocked by WAF | HIGH | SCRIPT | B2: "Parse Error: Invalid header token". Investigation script cannot access site directly. Crawler uses Playwright and works (6 new products in 3d). |
| Coverage 3% in 3d (0% in 24h) | MEDIUM | RECURRING | 1253 products across 9 streams. Low throughput despite 7 total pages. Possible: WAF slows Playwright significantly. |
| 15 expired cooldowns | MEDIUM | RECURRING | 9 streams × 3 tiers = 27 tier states, 15 have expired cooldowns. Scheduler fix deployed but needs investigation. |
| 98% watermark crawls find 0 | MEDIUM | RECURRING | Low turnover + WAF throttling |

### canadafirstammo.ca — PASS:15 WARN:1 FAIL:3
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| Watermark never finds products | HIGH | RECURRING | A2: 50 events, 0 products found. Site genuinely hasn't added new products since Dec 2025. |
| Price coverage 42% | HIGH | EXPECTED | 830/962 products are OOS. WooCommerce removes price for OOS items. Only 132 in-stock items have prices. |
| Coverage 52% in 3d | HIGH | RECURRING | T2-T4 running but coverage stuck. Previously had T4 stuck — scheduler fix should resolve. |
| Watermark 26 days old | MEDIUM | EXPECTED | No new products on site since Dec 2025 |

### gunpost.ca — PASS:13 WARN:2 FAIL:3
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| 12 systematic title/price errors | HIGH | RECURRING | C3: Expired classifieds return "Page not Found" (soft-404). DB has stale data. Daily stale checker will auto-clean. |
| sourceId 11% | HIGH | RECURRING | Was 7% → 9% → 11%. Slowly filling as crawler visits detail pages through Cloudflare. |
| 3 dead + 17 sold in sample | HIGH | RECURRING | D2: 85% of stale products are sold/deleted. Daily stale checker needed. |
| Coverage 16% in 3d | MEDIUM | RECURRING | 19,477 products across 1692 pages. At 180/hr, full cycle ~28h. Expected. |

### gotenda.com — PASS:13 WARN:2 FAIL:3
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| 200 stock mismatches | HIGH | SCRIPT | C2: Script calls Store API without WAF cookies → gets 307 → sees 0 in-stock. Crawler uses cookies and works. |
| Stock known 62%, Price 61%, Tags 55% | HIGH | NEW | Just switched from generic-retail to woocommerce adapter. Old HTML-scraped data missing fields. WooCommerce API will fill in as crawler runs full cycles. |
| API returns 307 | HIGH | SCRIPT | B2: Script doesn't use WAF cookies. Crawler handles this via waf-cookie-manager. |
| Coverage 73% in 3d | — | IMPROVING | Was 4% yesterday → 73% today. WooCommerce API working well. |

### g4cgunstore.com — PASS:10 WARN:2 FAIL:4
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| No stream state | HIGH | NEW | Just cleared streams for adapter switch. Scheduler will re-detect HTML streams on next tick. |
| Watermark finds 0 products | HIGH | RECURRING | A2: 50 events, 0 found. Generic-retail adapter may need site-specific selectors for g4c's WooCommerce theme. |
| Adapter mismatch detected | HIGH | EXPECTED | B1: Script detects woocommerce but we intentionally set generic-retail because API is hard-blocked (403 Wordfence + Cloudflare SGCaptcha). |
| Tags 0% | HIGH | RECURRING | Generic-retail adapter doesn't extract WooCommerce tags from HTML |
| Coverage 0% in 3d | HIGH | NEW | Streams just reset. Will recover after re-detection. |

### solelyoutdoors.com — PASS:6 WARN:0 FAIL:8
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| 0 products, no streams, no watermark | HIGH | EXPECTED | Just onboarded. First crawl cycle hasn't run yet. Lightspeed Nova theme — new .product-grid selector added. |

---

## Pattern Tracking

### Recurring Patterns (seen across multiple runs)
| Pattern | Sites Affected | Root Cause | Status |
|---------|---------------|------------|--------|
| **Expired cooldowns not resetting** | bullseyenorth (15), aagcanada (3), alflahertys (3) | Scheduler fix deployed but backend may need restart | MONITORING |
| **Dead/sold products in DB** | aagcanada (11), budgetshooter (4), gunpost (20+) | Daily stale checker deployed, waiting for first 4AM run | PENDING |
| **Low crawler coverage** | bullseyenorth (3%), alsimmons (35%), budget (40%) | Budget auto-adjuster will help. Some sites have WAF throttling. | MONITORING |
| **Investigation script can't access WAF sites** | bullseyenorth, gotenda, g4c | Script uses plain HTTP, not Playwright/cookies. Known limitation. | ACCEPTED |
| **Watermark never finds products** | alflahertys, canadafirst | alfla: Klevu JS renders products (HTML scraping finds nothing). canada: genuinely no new products. | INVESTIGATING |
| **sourceId filling slowly** | gunpost (11%) | Crawler must visit individual detail pages for node ID. 1692 pages at 180/hr. | EXPECTED |

### Improvements Since Last Run (2026-03-24)
| Change | Impact |
|--------|--------|
| Scheduler stuck-tier recovery on ALL sites | alsimmons T4 no longer stuck (was 14 days) |
| canadafirst T4 no longer stuck | Was stuck 2 days, scheduler reset it |
| HTML entity decoding in C3 | False title mismatches eliminated (was 9 on alflahertys, now 0) |
| WAF cookie manager for gotenda | Coverage jumped 4% → 73% in 24h |
| Alflahertys Klevu API stream | Proper tier partitioning (was 6 broken HTML streams) |
| gunpost sourceId | 7% → 11% (improving) |

---

## Run: 2026-03-25 07:00 UTC (10 sites, FULL mode, WAF-aware script)

Script now uses `scrapeWithAdapter()` for C1, Playwright for WAF HTML, cookies for WooCommerce APIs.

### aagcanada.ca — P:17 W:1 F:1 | C1: 30/54 keywords, 237 DB / 126 live
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| 10 dead + 1 sold products | HIGH | RECURRING | D2: Same 11 stale products. Daily stale checker not yet run (first 4AM). |

### alflahertys.com — P:14 W:2 F:2 | C1: 31/54 keywords, 1916 DB / 0 live
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| ALL live search = 0 | HIGH | RECURRING | C1: scrapeWithAdapter still returns 0. Klevu search needs investigation — adapter may not implement searchViaApi. |
| 9 price mismatches | HIGH | RECURRING | C3: Multi-variant pages show multiple prices. |
| Watermark finds 0 | HIGH | RECURRING | A2: 50 events, 0 products. |

### alsimmonsgunshop.com — P:16 W:3 F:0 | C1: 31/54 keywords, 1413 DB / 153 live
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| "gun case" missing | MEDIUM | RECURRING | 1 live result, 0 in DB. |
| Coverage 35% | MEDIUM | RECURRING | Budget auto-adjuster pending. |

### budgetshootersupply.ca — P:15 W:3 F:1 | C1: 28/54 keywords, 2063 DB / 681 live
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| 4 dead products | HIGH | RECURRING | Same 4 products. Daily stale checker pending. |
| 2 stock mismatches | MEDIUM | NEW | WILSON WSM + Eagle Copper. |

### bullseyenorth.com — P:12 W:3 F:3 | C1: 41/54 keywords, 833 DB / 0 live
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| ALL live search = 0 | HIGH | RECURRING | C1 ran with OLD script (before scrapeWithAdapter fix). NEEDS RE-TEST. |
| 3 price mismatches | HIGH | NEW | PRE-ORDER items showing wrong price. |
| Watermark finds 0 | HIGH | RECURRING | 50 events, 0 products. WAF site. |

### canadafirstammo.ca — P:15 W:1 F:3 | C1: 43/54 keywords, 1188 DB / 53 live
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| 42% price coverage | HIGH | EXPECTED | 830/962 OOS items have no price. |
| Watermark finds 0 | HIGH | EXPECTED | No new products since Dec 2025. |

### gunpost.ca — P:13 W:1 F:4 | C1: 52/54 keywords, 6047 DB / 0 live
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| 48% DB coverage (19k vs 40k live) | HIGH | NEW | D1: Missing ~21K listings. Crawler needs more cycles. |
| 3 dead + 17 sold | HIGH | RECURRING | D2: 85% of stale sample is sold/deleted. |
| sourceId 11% | HIGH | RECURRING | Slowly improving. |
| 0 live search | HIGH | EXPECTED | Classifieds search not in scrapeWithAdapter. |

### gotenda.com — P:12 W:4 F:3 | C1: 46/54 keywords, 4386 DB / 2749 live
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| Type 81 (0db/8live), Ruger PC Carbine (0db/8live), Ruger 10/22 (5db/98live) | HIGH | NEW | Real product gaps — crawler hasn't indexed these yet. |
| Stock known 59%, Price 58% | HIGH | NEW | Old generic-retail data missing fields. Filling as WooCommerce API runs. |
| 6 stock mismatches | HIGH | IMPROVED | Was 200 (script limitation) → now 6 real mismatches. |

### g4cgunstore.com — P:11 W:2 F:4 | C1: 29/54 keywords, 1386 DB / 0 live
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| Cloudflare blocks Playwright too | HIGH | NEW | Even scrapeWithAdapter can't search. Different WAF than Sucuri. |
| Tiers not partitioned | HIGH | RECURRING | All streams [1+]. |
| 0% tags | HIGH | RECURRING | generic-retail doesn't extract WooCommerce tags from HTML. |

### solelyoutdoors.com — P:14 W:0 F:2 | C1: 6/54 keywords, 8 DB / 296 live
| Issue | Severity | Status | Details |
|-------|----------|--------|---------|
| 35 keywords MISSING (site has products, DB has 0) | HIGH | NEW | scrapeWithAdapter found 296 live products. Crawler has only 12 in DB. No stream state. |
| No stream state | HIGH | RECURRING | Scheduler hasn't detected streams. |

### Pattern Changes
| Pattern | Previous Status | Current Status | Change |
|---------|----------------|----------------|--------|
| WAF sites 0 live results | ACCEPTED (script limitation) | PARTIALLY RESOLVED | gotenda now works (2749 live). bullseyenorth needs re-test. g4c still blocked (Cloudflare). |
| gotenda stock mismatches | 200 (script blocked) | 6 (real mismatches) | IMPROVED — cookies working |
| solelyoutdoors coverage | 0 products (just onboarded) | 12 DB vs 296 live — scraper finds products but crawler not indexing | DEGRADED — needs stream detection |
| gunpost coverage | Not measured | 48% (19k vs 40k) | NEW baseline — need more crawl cycles |
