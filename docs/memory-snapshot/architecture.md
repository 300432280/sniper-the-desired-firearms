# Architecture Notes

## Key Files

### Backend
- `backend/prisma/schema.prisma` — ProductIndex has `tags` column (comma-separated, from Shopify)
- `backend/src/services/keyword-matcher.ts` — `matchesKeyword()` (left-boundary only), `searchProductIndex()` (live query), `matchNewProducts()` (crawl-time matching)
- `backend/src/services/scraper/adapters/shopify.ts` — `fetchCatalogPage()` captures tags from `/products.json`, normalizes URLs via `decodeURIComponent()`
- `backend/src/services/watermark-crawler.ts` — saves `tags` in ProductIndex upsert
- `backend/src/services/catalog-crawler.ts` — saves `tags` in ProductIndex upsert
- `backend/src/routes/searches.ts` — `/matches/:searchId` enriches with `stockStatus` from ProductIndex join
- `backend/src/routes/admin.ts` — admin API including site-issues
- `backend/src/scripts/seed-keywords.ts` — keyword alias groups (THE canonical place for aliases)
- `backend/src/scripts/seed-sites.ts` — monitored site seeds with hasWaf flags

### Frontend
- `frontend/src/components/AlertCard.tsx` — dashboard card with sort buttons, stock badges in MatchRow/ScanResultRow
- `frontend/src/components/AlertDetailPanel.tsx` — detail page with sort buttons, stock badges

## v2 Catalog Architecture
- Zero HTTP scraping for keyword matching — all via ProductIndex SQL queries
- Crawlers (watermark/catalog) index products into ProductIndex
- `matchNewProducts()` runs after each crawl batch → creates Match records → triggers notifications
- `searchProductIndex()` runs on "Scan Now" → live query with alias expansion
- Match records are a snapshot — not updated retroactively when aliases/logic change

## WooCommerce Dual API Behavior
- **WP REST API** (`/wp-json/wp/v2/product`): All published products. No price, no stock. Use `_embed=wp:featuredmedia,wp:term` to get thumbnails AND category names. NEVER use `_fields` with `_embed` — it strips `_embedded` data.
- **Store API** (`/wp-json/wc/store/v1/products`): Has price, stock, images, categories. Supports `stock_status=outofstock` filter to return OOS products WITH prices.
- **Store API `include` param**: Accepts comma-separated product IDs — use this to enrich WP REST results (especially during date-filtered crawls where pagination doesn't align).
- **OOS products ARE in Store API** — just need `stock_status=outofstock` filter. Without it, only in-stock products are returned. (Confirmed on canadafirstammo.ca: 134 in-stock + 828 OOS all returned with prices.)
- **Two-pass enrichment pattern**: Always do two Store API calls per chunk — one default (in-stock) + one with `stock_status=outofstock` — to cover all products.
- **Stock status field**: Always use `is_in_stock`, NEVER `is_purchasable`. `is_purchasable` means "valid product type that can be added to cart" — it's `true` even for out-of-stock products. This caused a bug where OOS products showed as in_stock.
- **Three upsert locations** that can overwrite good data: `catalog-crawler.ts`, `watermark-crawler.ts`, `worker.ts` — ALL must use conditional updates (only write stock/price/thumbnail if new value is real, not null/unknown).
- **Tags vs sourceCategory**: Both fields must be populated. `tags` = comma-separated category names (stored in DB), `sourceCategory` = same data used by product-classifier. WP REST `wp:term` provides category names as fallback; Store API provides richer data.

## Site Verification Guidelines
- Always cross-check DB in_stock count vs Store API total
- Verify conditions that contribute to "out of stock" carefully per-site — don't assume all WooCommerce sites behave identically
- Script: `backend/scripts/investigate-site.js` — comprehensive site investigation (15 probes, 30 keywords)
- Script: `backend/scripts/verify-site.js` — legacy verification (superseded by investigate-site.js)

## Stale Product Detection (2026-03-24)
- `backend/src/services/stale-detector.ts` — daily BullMQ job (4 AM UTC)
- Cross-tier safe window: MIN(all tier lastCycleStartedAt) — only flags products missed by ALL tiers
- Detail page verification: sold (CSS class) → out_of_stock, 404 → isActive=false, alive → update lastSeenAt
- Sold items re-checked after 5 days (gunpost removes sold listings after ~3 days)
- Schema: `staleSince`, `staleVerifiedAt` on ProductIndex
- StreamTierState: `lastCycleStartedAt`, `lastCycleCompletedAt` for cross-tier coordination

## Catalog Crawler Redesign (Planned)

### Phase 1 Fixes (Completed 2026-03-09)
- **Pagination skip bug fixed**: `catalog-crawler.ts` saves `currentPageUrl` when tokens run out mid-pagination; resumes from exact page on next tick
- **WooCommerce `modified_after`**: T2-4 now use `modified_after`/`modified_before` + `orderby=modified` — catches restocks, price changes
- **Shopify `updated_at_min`**: T2-4 now pass `updated_at_min`/`updated_at_max` to `/products.json` — catches inventory updates
- **Per-site crawl tuning**: `crawlTuning` JSON column + `crawl-tuning.ts` helper + admin panel with live formula preview

### Remaining Problems (Phase 2+)
- HTML-based sites: Tiers 2-4 all crawl the same category URLs from scratch (triplicating work)
- No date filtering for HTML sites (API sites now fixed with modification-date filtering)

### Planned Design: Per-Stream Tier Structure

**Stream detection (find best partition of all site products):**
1. Try single stream first: API endpoint or single "all products" HTML page with date sort
   → If covers all products with dates: use 1 stream (best case)
2. If no single stream: detect all available partitioning patterns on the site:
   - Category-based: /firearms, /ammunition, /knives (N streams)
   - Price-based: $10-100, $100-1000, $1000+ (M streams)
   - Brand-based, alphabetical, etc.
3. Score each pattern and pick best:
   a. Domain relevance (strongest factor): does pattern include domain keywords?
      (e.g., "firearms", "ammunition" → high relevance for firearms industry)
      → Prefer even if slightly more streams than alternatives
   b. Stream count: fewer streams = more tokens per stream = better
   c. Coverage: must cover all products on the site
   d. Date sortability: can each stream be sorted by newest?
   Example: category pattern with 4 streams including "firearms" beats
   price pattern with 3 streams — domain relevance outweighs stream count

**Tier engine (general-purpose, reusable across industries):**
- Accepts: list of streams + token budget + priority function
- Tier 1: find the stored watermark (via date filter or URL scan), then walk FROM watermark TOWARD newest, indexing new products. The walk direction of T1's actual work is watermark→newest — not newest→watermark. The newest→watermark scan is only a locator step in the URL-anchored variant (Method B); it is not T1's primary operation.
- Tier 2: watermark → page N (refresh recent, 5hr cooldown)
- Tier 3: page N → page M (refresh aging, 9hr cooldown)
- Tier 4: page M → end (refresh archive, 17hr cooldown)
- Classification comes from stream identity (URL path) — works for all tiers
- Default rotation: staleness-based (most stale stream goes next)

**Domain priority plugin (decoupled from engine):**
- Firearms industry: firearms streams (3x weight) > ammunition (2x) > rest (1x)
- Ties broken by staleness
- Plugin is separate from general engine — can be swapped for other industries

**Token allocation across streams:**
- Tokens allocated per-site at tier level (T1: 70%, T2/T3/T4: 35/35/30 of remainder)
- Each tier concentrates tokens on one stream at a time (round-robin/priority)
- Don't spread thin across all streams — go deep on one, then rotate

**Key files to modify:**
- `backend/src/services/catalog-crawler.ts` — main refactor target
- `backend/src/services/token-budget.ts` — stream-aware allocation
- `backend/src/services/watermark-crawler.ts` — per-stream watermark tracking
- New: stream priority plugin (decoupled from engine)

## User Preferences
- No body_html storage (copyright risk) — tags only
- Price sort: single cycling button (Price → Price ↑ → Price ↓)
- Don't create throwaway scripts — use proper seed/migration files
- PM2 process: `firearm-alert-backend`
