# Pre-Bootstrap Probe Report — bullseyenorth.com

**Run:** 3da5796b-995f-4558-bcce-895fec974f5a at 2026-05-04T08:54:00.506Z

## Access & Identity
- Canonical origin: `https://bullseyenorth.com`
- WAF: `none` (hasWaf: false)
- Platform: `celerant-coldfusion`
- Access method: `axios-desktop`
- needsPlaywright: false

## Geography & Count
- Global count: **3262** via `celerant-perpage-all`
- catalogUrls (10): `https://bullseyenorth.com/accessories/browse/orderby/new-arrivals/perpage/36`, `https://bullseyenorth.com/ammunition/browse/orderby/new-arrivals/perpage/36`, `https://bullseyenorth.com/firearms/browse/orderby/new-arrivals/perpage/36`, `https://bullseyenorth.com/knives/browse/orderby/new-arrivals/perpage/36`, `https://bullseyenorth.com/magazines/browse/orderby/new-arrivals/perpage/36`, ... (+5)
- Walked unique: 3196
- Drift: 2.02%

## Navigation
- Pagination: `path` perPage=36
- Sort: ``
- Watermark method: **navigate-from-watermark**

## Next step

Review this report. If acceptable, run:
```
npx tsx backend/scripts/bootstrap.ts bullseyenorth.com
```
