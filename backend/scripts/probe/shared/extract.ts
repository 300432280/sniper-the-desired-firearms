// backend/scripts/probe/shared/extract.ts
// Thin wrapper around the production catalog extractor.
// All rooms must extract via this — never write probe-specific selectors.
//
// Re-exports CatalogProduct as ExtractedProduct so consumers (Room 3 walk-verify,
// Room 5 indexing) get every field the production extractor populates: url, title,
// price, regularPrice, stockStatus, thumbnail, sourceId, postDate, tags,
// productType, sourceCategory, category, closingAt.

import * as cheerio from 'cheerio';
import { GenericRetailAdapter } from '../../../src/services/scraper/adapters/generic-retail';
import type { CatalogProduct } from '../../../src/services/scraper/types';

const adapter = new GenericRetailAdapter();

export type ExtractedProduct = CatalogProduct;

export function extractProducts(html: string, pageUrl: string): ExtractedProduct[] {
  const $ = cheerio.load(html);
  // GenericRetailAdapter.extractCatalogProducts is the production canonical extractor
  return adapter.extractCatalogProducts($, pageUrl);
}
