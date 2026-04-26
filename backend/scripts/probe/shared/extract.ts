// backend/scripts/probe/shared/extract.ts
// Platform-aware wrapper around production catalog extractors.
// All rooms must extract via this — never write probe-specific selectors.
//
// Re-exports CatalogProduct as ExtractedProduct so consumers (Room 3 walk-verify,
// Room 5 indexing) get every field the production extractor populates: url, title,
// price, regularPrice, stockStatus, thumbnail, sourceId, postDate, tags,
// productType, sourceCategory, category, closingAt.
//
// Dispatch table by platform tag (the `id` from a Room 2 detector):
//   drupal-commerce  → GunpostAdapter (Drupal-classifieds-generic selectors:
//                      node--type-classified, gunpost-teaser, listing-item,
//                      article[class*="classified"]). Despite the file name,
//                      the SELECTORS are platform-generic — the Wanted/WTB
//                      filter is universal classifieds-shop hygiene, not
//                      gunpost-specific.
//   forum-xenforo    → forum content (out of scope for catalog extraction)
//   forum-vbulletin  → forum content (out of scope)
//   auction-*        → AuctionHibidAdapter / AuctionIcollectorAdapter (different
//                      data model: lots not products; out of scope for now)
//   everything else  → GenericRetailAdapter (covers WC, Shopify, BC Stencil,
//                      Magento, LightSpeed, Volusion, OpenCart, Wix, GoDaddy
//                      OLS, Ecwid-on-WP, Celerant — verified live on 22 sites)
//
// To add a new platform-specific extractor, add a case below — no other
// callers need to change. extractProducts() defaults to generic-retail when
// platform is unrecognized or omitted.

import * as cheerio from 'cheerio';
import { GenericRetailAdapter } from '../../../src/services/scraper/adapters/generic-retail';
import { GunpostAdapter } from '../../../src/services/scraper/adapters/classifieds-gunpost';
import type { CatalogProduct } from '../../../src/services/scraper/types';

const genericRetail = new GenericRetailAdapter();
const drupalClassifieds = new GunpostAdapter();

export type ExtractedProduct = CatalogProduct;

export function extractProducts(html: string, pageUrl: string, platform?: string): ExtractedProduct[] {
  const $ = cheerio.load(html);
  // Drupal classifieds (gunpost.ca and any future Drupal-Views-based classifieds
  // site) have <article class="node--type-classified"> markup that the generic
  // retail extractor doesn't recognize. Dispatch to the production GunpostAdapter
  // whose SELECTORS are platform-generic.
  if (platform === 'drupal-commerce' || platform === 'classifieds-drupal') {
    return drupalClassifieds.extractCatalogProducts($, pageUrl);
  }
  return genericRetail.extractCatalogProducts($, pageUrl);
}
