// backend/scripts/probe/room5-bootstrap/detail-enrich.ts
// Per spec §6.4: enrich products missing price (in-stock) or postDate (all)
// by fetching detail pages. Batch by catalogUrl, concurrency ≤ 3, token-budget gated.

import { safeFetch } from '../shared/fetch';
import { canRequest, consumeToken, getBudget } from '../../../src/services/token-budget';
import type { NavigationState, WafType } from '../shared/types';
import type { CatalogProduct } from '../../../src/services/scraper/types';

export type EnrichResult = {
  productsEnriched: number;
  avgDetailFetchMs: number;
  detailFetchFailures: number;
  enrichedProducts: CatalogProduct[];
};

type DetailFields = {
  price?: number;
  postDate?: string;
};

// ── Detail-page extraction (generic, priority-ordered per spec §6.4) ────────

function extractFromJsonLd(html: string): DetailFields {
  const result: DetailFields = {};
  const ldMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (!ldMatches) return result;

  for (const match of ldMatches) {
    try {
      const jsonStr = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '').trim();
      const data = JSON.parse(jsonStr);
      const item = Array.isArray(data) ? data[0] : data;

      // Date: datePublished > dateModified > dateCreated
      if (!result.postDate) {
        const date = item.datePublished || item.dateModified || item.dateCreated;
        if (date) result.postDate = String(date);
      }

      // Price from offers
      if (result.price == null) {
        const offers = item.offers;
        if (offers) {
          const offer = Array.isArray(offers) ? offers[0] : offers;
          const p = parseFloat(offer?.price ?? offer?.lowPrice);
          if (!isNaN(p) && p > 0) result.price = p;
        }
      }
    } catch {
      // malformed JSON-LD — continue to next block
    }
  }
  return result;
}

function extractFromOpenGraph(html: string): DetailFields {
  const result: DetailFields = {};

  // Date: article:published_time
  const dateMatch = html.match(/<meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i);
  if (dateMatch) result.postDate = dateMatch[1];

  // Price: og:price:amount or product:price:amount
  const priceMatch = html.match(/<meta[^>]*property=["'](?:og|product):price:amount["'][^>]*content=["']([^"']+)["']/i);
  if (priceMatch) {
    const p = parseFloat(priceMatch[1]);
    if (!isNaN(p) && p > 0) result.price = p;
  }

  return result;
}

function extractFromClassifieds(html: string): DetailFields {
  const result: DetailFields = {};

  // Posted date classes common in classifieds
  const dateMatch = html.match(/class=["'][^"']*(?:posted[_-]?date|date[_-]?posted|listing[_-]?date)[^"']*["'][^>]*>([^<]+)/i);
  if (dateMatch) {
    const raw = dateMatch[1].trim();
    if (raw.length > 4 && raw.length < 40) result.postDate = raw;
  }

  return result;
}

function extractFromPlatformMeta(html: string): DetailFields {
  const result: DetailFields = {};

  // WooCommerce itemprop price
  const wcPrice = html.match(/<meta[^>]*itemprop=["']price["'][^>]*content=["']([^"']+)["']/i);
  if (wcPrice) {
    const p = parseFloat(wcPrice[1]);
    if (!isNaN(p) && p > 0) result.price = p;
  }

  // BC Stencil data-product-price
  if (result.price == null) {
    const bcPrice = html.match(/data-product-price=["']([^"']+)["']/i);
    if (bcPrice) {
      const p = parseFloat(bcPrice[1]);
      if (!isNaN(p) && p > 0) result.price = p;
    }
  }

  // Time element (common across many platforms)
  if (!result.postDate) {
    const timeEl = html.match(/<time[^>]*datetime=["']([^"']+)["']/i);
    if (timeEl) result.postDate = timeEl[1];
  }

  return result;
}

/**
 * Extract missing fields from a detail page HTML.
 * Priority: JSON-LD → Open Graph → classifieds patterns → platform meta.
 */
function extractDetailFields(html: string, needs: { price: boolean; postDate: boolean }): DetailFields {
  const result: DetailFields = {};

  // Try sources in priority order
  const sources = [extractFromJsonLd, extractFromOpenGraph, extractFromClassifieds, extractFromPlatformMeta];

  for (const extractor of sources) {
    const found = extractor(html);
    if (needs.price && result.price == null && found.price != null) result.price = found.price;
    if (needs.postDate && !result.postDate && found.postDate) result.postDate = found.postDate;
    // Stop early if we have everything
    if ((!needs.price || result.price != null) && (!needs.postDate || result.postDate)) break;
  }

  return result;
}

// ── Concurrency helper ──────────────────────────────────────────────────────

async function runWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Main enrichment function ────────────────────────────────────────────────

export async function enrichProducts(
  products: CatalogProduct[],
  siteId: string,
  state: NavigationState,
): Promise<EnrichResult> {
  // Determine which products need enrichment
  const toEnrich = products.filter(p => {
    const needsPrice = p.stockStatus === 'in_stock' && p.price == null;
    const needsDate = !p.postDate;
    return needsPrice || needsDate;
  });

  if (toEnrich.length === 0) {
    return { productsEnriched: 0, avgDetailFetchMs: 0, detailFetchFailures: 0, enrichedProducts: products };
  }

  // Determine concurrency: 3 normally, 1 for WAF/rate-limited sites
  const maxConcurrency = (state.hasWaf && state.wafType !== 'cloudflare-passive') || state.hasWaf ? 1 : 3;

  const baseBudget = 60; // default per token-budget.ts
  const capacity = 1.0;  // bootstrap uses full capacity

  let totalFetchMs = 0;
  let fetchCount = 0;
  let failures = 0;

  // Group by catalogUrl to amortize WAF cookie reuse
  const byCatalogUrl = new Map<string, CatalogProduct[]>();
  for (const p of toEnrich) {
    // sourceCategory often holds the catalogUrl it came from
    const key = (p as any).catalogUrl ?? 'ungrouped';
    const arr = byCatalogUrl.get(key) || [];
    arr.push(p);
    byCatalogUrl.set(key, arr);
  }

  // Process batches sequentially by catalogUrl group, concurrent within each batch
  for (const [, batch] of byCatalogUrl) {
    await runWithConcurrency(batch, maxConcurrency, async (product) => {
      // Token budget gate
      if (!canRequest(siteId, baseBudget, capacity)) {
        // Wait a brief moment and retry once
        await new Promise(r => setTimeout(r, 2000));
        if (!canRequest(siteId, baseBudget, capacity)) {
          failures++;
          return;
        }
      }

      try {
        consumeToken(siteId, 1);
        const fetchResult = await safeFetch(product.url, {
          timeoutMs: 20000,
          hasWaf: state.hasWaf,
          wafType: state.wafType ?? undefined,
        });

        totalFetchMs += fetchResult.durationMs;
        fetchCount++;

        if (fetchResult.status !== 200 || fetchResult.bodyBytes < 1000) {
          failures++;
          return;
        }

        const needs = {
          price: product.stockStatus === 'in_stock' && product.price == null,
          postDate: !product.postDate,
        };

        const fields = extractDetailFields(fetchResult.body, needs);
        if (fields.price != null) product.price = fields.price;
        if (fields.postDate) product.postDate = fields.postDate;
      } catch {
        failures++;
      }
    });
  }

  return {
    productsEnriched: fetchCount - failures,
    avgDetailFetchMs: fetchCount > 0 ? Math.round(totalFetchMs / fetchCount) : 0,
    detailFetchFailures: failures,
    enrichedProducts: products, // mutated in-place
  };
}
