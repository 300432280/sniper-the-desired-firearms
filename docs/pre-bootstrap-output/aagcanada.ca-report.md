# Pre-Bootstrap Probe Report — aagcanada.ca

**Run:** a6c30a91-6359-4432-beab-21323527f49d at 2026-04-27T06:28:23.259Z

## Access & Identity
- Canonical origin: `https://aagcanada.ca`
- WAF: `cloudflare-passive-with-owasp` (hasWaf: true)
- Platform: `shopify`
- Access method: `axios-desktop`
- needsPlaywright: false

## Geography & Count
- Global count: **570** via `shopify-products-walk`
- catalogUrls (17): `https://aagcanada.ca/collections/antique-blank`, `https://aagcanada.ca/collections/bayonet`, `https://aagcanada.ca/collections/boutique-display-sold`, `https://aagcanada.ca/collections/deactivated`, `https://aagcanada.ca/collections/firearms`, ... (+12)
- Walked unique: 567
- Drift: 0.53%

## Navigation
- Pagination: `query` perPage=12
- Sort: `?sort_by=created-ascending`
- Watermark method: **full-catalog-sweep**

## Next step

Review this report. If acceptable, run:
```
npx tsx backend/scripts/bootstrap.ts aagcanada.ca
```
