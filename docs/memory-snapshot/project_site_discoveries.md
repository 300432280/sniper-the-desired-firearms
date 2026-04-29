---
name: project-site-discoveries
description: Per-site crawler issues discovered during 7-site investigation on 2026-03-22
type: project
---

## Site-Specific Discoveries (2026-03-22)

### bullseyenorth.com (generic-retail, ColdFusion CMS)
- ColdFusion sends malformed HTTP headers (trailing spaces) causing HPE_INVALID_HEADER_TOKEN
- Products are `<a class="product">` tags, not `<div class="product">` — needed selector addition
- 13 streams had duplicates (shop x2, generic fallbacks) — cleaned to 9
- **Fix:** hasWaf=true, added `a.product` selector, cleaned streams

### alflahertys.com (generic-retail, BigCommerce + Klevu)
- Products rendered entirely by Klevu JavaScript overlay — no server-side HTML product cards
- Even Playwright can't extract products (Klevu injects after networkidle)
- Klevu API key: `klevu-170966446878517137` (public, in page source)
- API endpoint: `https://uscs33v2.ksearchnet.com/cs/v2/search` with CATNAV queries
- 1,113 products available vs 347 in DB before fix
- 2 dead URLs (handguns, riflescopes → 404), 3 new valid URLs added
- **Fix:** Added fetchCatalogPage() with Klevu API, fixed URLs, cleaned dead streams

### aagcanada.ca (Shopify)
- Shopify public /products.json API silently ignores date filter params (updated_at_min/max)
- Date filters only work on authenticated Admin API — affects ALL 4 Shopify sites
- perPage was being set to 50 when 250 works (Shopify max) — 3.7x fewer pages needed
- **Fix:** Hardcoded perPage=250, removed fake date params, cleaned 11 ghost products

### alsimmonsgunshop.com, budgetshootersupply.ca (WooCommerce)
- Working correctly — both APIs healthy, watermark tracking properly
- Low product turnover (5-13 days between new listings) explains "watermark finds 0"
- Stale product stats are expected with limited token budget + large catalogs

### canadafirstammo.ca (WooCommerce)
- 86% of products are out-of-stock with $0 price in WooCommerce
- In-stock price coverage is 98% — the 57% overall was misleading
- 17 category page URLs were incorrectly stored as products (old code path)
- **Fix:** Cleaned category pages, nulled 153 fake $0 prices

### gunpost.ca (classifieds-gunpost, Drupal + Cloudflare)
- getNewArrivalsUrls() returned 3 URLs all mapping to stream ID "ads" — duplicate streams
- When unsorted /ads was picked, page ranges were meaningless (random order)
- 4,273 products >14 days unseen — deactivated
- **Fix:** Single sorted URL only, stream ID dedup in detector

## Cross-Cutting Patterns
- **Phantom success is normal for watermark crawls** — CrawlEvents only record Tier 1. Finding 0 products means no new listings, not a failure.
- **Stream ID collisions from URL paths** — fixed by joining all meaningful path segments
- **API sites (WooCommerce, Shopify) don't use page ranges** — tiers use date ranges instead. "Not partitioned" is expected for API streams.
- **Stream deduplication needed** — multiple URLs can map to same stream ID, causing duplicate tier entries
