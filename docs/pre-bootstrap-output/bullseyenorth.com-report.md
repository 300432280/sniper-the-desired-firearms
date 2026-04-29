# Pre-Bootstrap Probe Report — bullseyenorth.com

**Run:** b2dfda11-9773-4c90-adca-5d79e07ebe18 at 2026-04-27T06:51:39.553Z

## Access & Identity
- Canonical origin: `https://bullseyenorth.com`
- WAF: `none` (hasWaf: false)
- Platform: `celerant-coldfusion`
- Access method: `axios-desktop`
- needsPlaywright: false

## Geography & Count
- Global count: **3276** via `celerant-perpage-all`
- catalogUrls (1): `https://bullseyenorth.com/all-products/browse/orderby/new-arrivals/perpage/36`
- Walked unique: 3240
- Drift: 1.10%

## Navigation
- Pagination: `path` perPage=36
- Sort: `none`
- Watermark method: **full-catalog-sweep**

## Next step

Review this report. If acceptable, run:
```
npx tsx backend/scripts/bootstrap.ts bullseyenorth.com
```
