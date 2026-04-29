# Pre-Bootstrap Probe Report — canadafirstammo.ca

**Run:** 5d94adea-b4b3-42f4-92b8-57373c62e054 at 2026-04-27T06:51:37.024Z

## Access & Identity
- Canonical origin: `https://canadafirstammo.ca`
- WAF: `cloudflare-passive-with-owasp` (hasWaf: true)
- Platform: `woocommerce`
- Access method: `axios-desktop`
- needsPlaywright: false

## Geography & Count
- Global count: **132** via `wc-store-api-header`
- catalogUrls (58): `https://canadafirstammo.ca/product-category/accessories/`, `https://canadafirstammo.ca/product-category/accessories/around-the-house/`, `https://canadafirstammo.ca/product-category/accessories/around-the-house/accessoriescleaning-supplies/`, `https://canadafirstammo.ca/product-category/accessories/bows-knives-self-defence/`, `https://canadafirstammo.ca/product-category/accessories/bows-knives-self-defence/polymer-knuckles/`, ... (+53)
- Walked unique: 128
- Drift: 3.03%

## Navigation
- Pagination: `path` perPage=12
- Sort: `?orderby=date`
- Watermark method: **navigate-from-watermark**

## Next step

Review this report. If acceptable, run:
```
npx tsx backend/scripts/bootstrap.ts canadafirstammo.ca
```
