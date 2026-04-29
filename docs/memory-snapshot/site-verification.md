# Site Verification Checklist

Lessons learned from aagcanada.ca verification. Apply to every future site check.

## Step-by-Step Process

### 1. Count comparison (DB vs live API)
For Shopify sites, compare `products.json` API counts against ProductIndex:
- Query ProductIndex for keyword matches (title + tags)
- Query Shopify `/products.json` for the same keyword
- If counts differ, investigate why

### 2. Check word-boundary filtering
`matchesKeyword()` in `keyword-matcher.ts` only checks LEFT boundary (no alphanumeric before).
- Right side is unrestricted — "german" matches "Germany", "sks" matches "SKS45"
- This was a bug previously (both sides checked), causing 14 instead of 16 results for "german"
- Always verify: does the word-boundary refinement step drop valid matches?

### 3. Check keyword aliases
- Aliases live in `src/scripts/seed-keywords.ts` — NEVER create one-off scripts for this
- Variants like "tm22" / "tm-22" must be in the alias seed file
- **Critical**: Match records are NOT retroactively created when aliases are added. Existing products won't appear in Match History until either:
  - User does "Scan Now" (uses `searchProductIndex` with live alias expansion)
  - A backfill is run to create missing Match records
  - The next crawl picks up the product again

### 4. Check tags column
- Tags come from Shopify `products.json` API — comma-separated
- Do NOT store `body_html` in tags — copyright infringement risk (user decision)
- Keyword matcher searches both `title` AND `tags` via SQL ILIKE, then refines with `matchesKeyword()`

### 5. Check for URL duplicates
- Shopify handles with Unicode chars (e.g., Chinese characters) can create duplicates:
  one URL decoded (`/products/改良型`), one percent-encoded (`/products/%E6%94%B9`)
- Shopify adapter now normalizes via `decodeURIComponent()` before storing
- Run dedup check: group by decoded URL, deactivate duplicates

### 6. Two frontend components need matching features
- `AlertCard.tsx` — dashboard cards (compact view)
- `AlertDetailPanel.tsx` — search detail page (full view with "BACK TO ALERTS")
- Both must have: sort buttons, stock badges, match history, scan results
- Easy to miss one — always check both

## Common Pitfalls
- **PM2 DLL lock on Windows**: Must `pm2 stop` before `prisma generate`, then rebuild, then restart
- **Throwaway scripts**: Don't create them. Use seed files, or run inline node -e commands for quick checks
- **Match History vs Scan Now**: Match History shows stored Match records (may be stale). Scan Now does live ProductIndex query with current aliases/matching logic
- **Stock badges need backend enrichment**: `/matches/:searchId` endpoint must join with ProductIndex to get `stockStatus`
