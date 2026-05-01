---
name: crawler-specialist
description: Master index for FirearmAlert crawler/scraping work — points to themed personas owned by specific agency-agents
---

This file is a **table of contents**. The lessons that used to live here have been split into 3 themed personas, each named to match an agency-agent so the MANDATORY persona-load rule in CLAUDE.md auto-injects the right subset.

## Where the lessons live now

| Theme | Lessons covered | Persona file (auto-loaded for) |
|---|---|---|
| **Adapter coding & platform quirks** | Volusion `searching=Y` / OpenCart `p.date_added` / Magento `<select id="sorter">` / BC Stencil double-render / Wix `/shop` pagination / LightSpeed `pageN.html` / Shopify `published_at` / Searchspring URL hash / Odoo `?order=create_date+desc` / Ecwid backend integration / `apiCrawlUsed` flag / stream tier architecture / DB=0 audit methodology / catalogUrls 100% coverage / theme-name-vs-CDN | [`engineering-backend-architect.md`](engineering-backend-architect.md) |
| **WAF bypass & security** | Sucuri 8-cookie capture / Cloudflare passive detection / SiteGround sgcaptcha PoW + iPhone UA / heavy 8-batch probe / `hasWaf` DB column / wafType verification / probe Playwright fallback for WAF | [`engineering-security-engineer.md`](engineering-security-engineer.md) |
| **Live UI driving / SPA API discovery** | Ecwid storefront API XHR capture / liangjian.ca Playwright fallback / sail.ca Searchspring URL hash discovery / drive-Playwright-as-real-user methodology / Drupal classifieds probe / Celerant ColdFusion probe defects | [`testing-api-tester.md`](testing-api-tester.md) |

## When to invoke `crawler-specialist` directly

You can still spawn an agent named `crawler-specialist` (project-level persona) when you want a **"give me everything"** mode for unfamiliar crawler work. In that case, ALSO load all 3 split personas above for full context. Otherwise, prefer the agency-agent that fits your specific task — its matching persona will load just the relevant subset.

## Domain summary (always relevant)

- **Adapter framework** (`backend/src/services/scraper/adapters/`)
- **Catalog crawler** (`backend/src/services/catalog-crawler.ts`)
- **Watermark crawler** (`backend/src/services/watermark-crawler.ts`)
- **Stream detector** (`backend/src/services/stream-detector.ts`)
- **HTTP client** (`backend/src/services/scraper/http-client.ts`) — Sucuri WAF bypass, UA rotation, rate limiting
- **Playwright fetcher** (`backend/src/services/scraper/playwright-fetcher.ts`) — headless browser fallback
- **WAF cookie manager** (`backend/src/services/scraper/waf-cookie-manager.ts`)
- **Pre-bootstrap probe** (`backend/scripts/pre-bootstrap-probe.ts` + `backend/scripts/probe/`)
