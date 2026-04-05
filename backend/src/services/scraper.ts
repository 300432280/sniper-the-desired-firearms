import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { getListingUrls } from './site-navigator';
import { _getSiteCacheEntry } from './scraper/adapter-registry';

// ── Import from new modular architecture ────────────────────────────────────
import type { SiteType, ExtractionOptions } from './scraper/types';
export type { ScrapedMatch, ScrapeResult, ScrapeOptions } from './scraper/types';
import type { ScrapedMatch, ScrapeResult } from './scraper/types';

import { extractPrice, extractPriceFromTitle, extractBidPrice } from './scraper/utils/price';
import { isInStock } from './scraper/utils/stock';
import { resolveUrl, isBareDomain } from './scraper/utils/url';
import { detectSiteType, isLoginPage } from './scraper/utils/html';
import { fetchPage, randomDelay, pickUserAgent } from './scraper/http-client';

// Re-export fetchPage for site-navigator.ts and auth-manager.ts
export { fetchPage } from './scraper/http-client';

// ── Type-specific extraction strategies ────────────────────────────────────────

function extractRetailerMatches(
  $: cheerio.CheerioAPI,
  keyword: string,
  baseUrl: string,
  options: ExtractionOptions
): ScrapedMatch[] {
  const keywordLower = keyword.toLowerCase();
  const matches: ScrapedMatch[] = [];
  const seen = new Set<string>();

  const PRODUCT_SELECTORS = [
    '[class*="product-card"]',
    '[class*="product-item"]',
    '[class*="product-tile"]',
    '[class*="ProductItem"]',
    '[class*="item-card"]',
    '[class*="grid-item"]',
    '[data-product-id]',
    '[data-product]',
    'article[class*="product"]',
    'li[class*="product"]',
  ];

  for (const selector of PRODUCT_SELECTORS) {
    $(selector).each((_, el) => {
      const element = $(el);
      const text = element.text();
      if (!text.toLowerCase().includes(keywordLower)) return;

      let titleEl = element.find('h1, h2, h3, h4').first();
      if (!titleEl.length) {
        titleEl = element.find('[class*="title"], [class*="name"], [class*="heading"]').first();
      }
      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;
      if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      const linkEl = element.is('a') ? element : (element.closest('a').length ? element.closest('a') : element.find('a[href]').first());
      const href = linkEl.attr('href') || '';
      const productUrl = resolveUrl(href, baseUrl);

      const priceEl = element.find('[class*="price"], [class*="cost"], [class*="amount"], [itemprop="price"], [class*="field-price"]').first();
      const price = extractPrice(priceEl.text() || '');
      const inStock = isInStock(element);

      if (options.inStockOnly && !inStock) return;
      if (options.maxPrice && price && price > options.maxPrice) return;

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: productUrl, inStock });
    });
  }

  return matches;
}

function extractClassifiedsMatches(
  $: cheerio.CheerioAPI,
  keyword: string,
  baseUrl: string,
  options: ExtractionOptions
): ScrapedMatch[] {
  const keywordLower = keyword.toLowerCase();
  const matches: ScrapedMatch[] = [];
  const seen = new Set<string>();

  const CLASSIFIED_SELECTORS = [
    '[class*="node--type-classified"]',
    '[class*="node--type-"][class*="teaser"]',
    '[class*="classified-ad"]',
    '[class*="classified-item"]',
    '[class*="listing-card"]',
    '[class*="listing-item"]',
    '[class*="ad-card"]',
    '[class*="post-card"]',
    '[class*="search-result"]',
    'article[class*="classified"]',
    'article[class*="listing"]',
    'article.post',
    'article',
  ];

  for (const selector of CLASSIFIED_SELECTORS) {
    $(selector).each((_, el) => {
      const element = $(el);
      const text = element.text();
      if (!text.toLowerCase().includes(keywordLower)) return;

      let titleEl = element.find('h1, h2, h3, h4').first();
      if (!titleEl.length) {
        titleEl = element.find('[class*="title"], [class*="name"], [class*="heading"], [class*="field-name-title"]').first();
      }
      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;
      if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      const linkEl = element.is('a') ? element : (element.closest('a').length ? element.closest('a') : element.find('a[href]').first());
      const href = linkEl.attr('href') || '';
      const productUrl = resolveUrl(href, baseUrl);

      const priceEl = element.find('[class*="price"], [class*="cost"], [class*="amount"], [class*="field-price"]').first();
      let price = extractPrice(priceEl.text() || '');
      // Classifieds often have price in title
      if (!price) price = extractPriceFromTitle(rawTitle);

      if (options.maxPrice && price && price > options.maxPrice) return;

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: productUrl });
    });
  }

  return matches;
}

function extractForumMatches(
  $: cheerio.CheerioAPI,
  keyword: string,
  baseUrl: string,
  options: ExtractionOptions
): ScrapedMatch[] {
  const keywordLower = keyword.toLowerCase();
  const matches: ScrapedMatch[] = [];
  const seen = new Set<string>();

  // vBulletin thread selectors
  const vbThreads = $('[class*="threadbit"], li[id^="thread_"], [class*="threadtitle"]');
  if (vbThreads.length > 0) {
    vbThreads.each((_, el) => {
      const element = $(el);
      const text = element.text();
      if (!text.toLowerCase().includes(keywordLower)) return;

      let titleEl = element.find('.threadtitle a, a[id^="thread_title_"]').first();
      if (!titleEl.length) titleEl = element.find('a[href*="showthread"]').first();
      if (!titleEl.length) titleEl = element.find('h3 a, h4 a').first();

      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      const href = titleEl.attr('href') || '';
      const threadUrl = resolveUrl(href, baseUrl);

      const price = extractPriceFromTitle(rawTitle);
      if (options.maxPrice && price && price > options.maxPrice) return;

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: threadUrl });
    });
    return matches;
  }

  // XenForo thread selectors
  const xfThreads = $('.structItem, [class*="structItem--thread"]');
  if (xfThreads.length > 0) {
    xfThreads.each((_, el) => {
      const element = $(el);
      const text = element.text();
      if (!text.toLowerCase().includes(keywordLower)) return;

      let titleEl = element.find('.structItem-title a').first();
      if (!titleEl.length) titleEl = element.find('[class*="title"] a').first();

      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      const href = titleEl.attr('href') || '';
      const threadUrl = resolveUrl(href, baseUrl);

      const price = extractPriceFromTitle(rawTitle);
      if (options.maxPrice && price && price > options.maxPrice) return;

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: threadUrl });
    });
    return matches;
  }

  // phpBB thread selectors
  const phpbbThreads = $('[class*="topiclist"] li, [class*="row"] dl');
  if (phpbbThreads.length > 0) {
    phpbbThreads.each((_, el) => {
      const element = $(el);
      const text = element.text();
      if (!text.toLowerCase().includes(keywordLower)) return;

      let titleEl = element.find('a[class*="topictitle"]').first();
      if (!titleEl.length) titleEl = element.find('a[href*="viewtopic"]').first();

      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      const href = titleEl.attr('href') || '';
      const threadUrl = resolveUrl(href, baseUrl);

      const price = extractPriceFromTitle(rawTitle);
      if (options.maxPrice && price && price > options.maxPrice) return;

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: threadUrl });
    });
  }

  return matches;
}

function extractAuctionMatches(
  $: cheerio.CheerioAPI,
  keyword: string,
  baseUrl: string,
  options: ExtractionOptions
): ScrapedMatch[] {
  const keywordLower = keyword.toLowerCase();
  const matches: ScrapedMatch[] = [];
  const seen = new Set<string>();

  const LOT_SELECTORS = [
    '.gridItem',
    '[class*="catLot"]',
    '[class*="lot-item"]',
    '[class*="lotItem"]',
    '[class*="lot-card"]',
    '[class*="catalog-item"]',
    '[class*="auction-item"]',
    '[class*="auction-lot"]',
    '.lot',
    '[class*="item-card"]',
    '[class*="lotContainer"]',
    '[class*="LotTile"]',
    '[class*="lot-tile"]',
    '[class*="item-listing"]',
    '[class*="asset-card"]',
  ];

  for (const selector of LOT_SELECTORS) {
    $(selector).each((_, el) => {
      const element = $(el);

      let rawTitle = '';
      let lotUrl = '';

      // Try iCollector-specific extraction first
      const icTitleLink = element.find('.gridView_itemListing a[href*="_i"], .gridView_heading a[href*="_i"], a.row_thumbnail[title]').first();
      if (icTitleLink.length) {
        rawTitle = (icTitleLink.attr('title') || icTitleLink.text()).trim().replace(/\s+/g, ' ').slice(0, 160);
        lotUrl = icTitleLink.attr('href') || '';
        if (lotUrl && !lotUrl.startsWith('http')) lotUrl = resolveUrl(lotUrl, baseUrl);
      }

      // Generic extraction fallback
      if (!rawTitle) {
        const text = element.text();
        if (!text.toLowerCase().includes(keywordLower)) return;

        let titleEl = element.find('[class*="lot-title"], [class*="lot-name"], [class*="lotTitle"]').first();
        if (!titleEl.length) titleEl = element.find('h3, h4, h2').first();
        if (!titleEl.length) titleEl = element.find('[class*="title"], [class*="name"], [class*="description"]').first();

        rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      }

      if (!rawTitle || rawTitle.length < 3) return;
      if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;
      if (!rawTitle.toLowerCase().includes(keywordLower)) return;

      const cleanTitle = rawTitle.replace(/^\d+[A-Za-z]?\s*-\s*/, '');

      const titleKey = cleanTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      if (!lotUrl) {
        const linkEl = element.is('a') ? element : (element.closest('a').length ? element.closest('a') : element.find('a[href]').first());
        const href = linkEl.attr('href') || '';
        lotUrl = resolveUrl(href, baseUrl);
      }

      const bidEl = element.find('[class*="current-bid"], [class*="winning-bid"], [class*="bid-amount"], [class*="estimate"], [class*="price"], [class*="hammer"]').first();
      const price = bidEl.length ? extractBidPrice(bidEl.text()) : extractBidPrice(element.text());

      if (options.maxPrice && price && price > options.maxPrice) return;

      seen.add(titleKey);
      matches.push({ title: cleanTitle || rawTitle, price, url: lotUrl });
    });
  }

  return matches;
}

// ── Generic fallback extraction ─────────────────────────────────────────────

function extractGenericMatches(
  $: cheerio.CheerioAPI,
  keyword: string,
  baseUrl: string,
  options: ExtractionOptions
): ScrapedMatch[] {
  const keywordLower = keyword.toLowerCase();
  const matches: ScrapedMatch[] = [];
  const seen = new Set<string>();

  const ALL_SELECTORS = [
    '[class*="product-card"]', '[class*="product-item"]', '[class*="product-tile"]',
    '[data-product-id]', '[data-product]', 'article[class*="product"]', 'li[class*="product"]',
    '[class*="listing"]', '[class*="classified"]', '[class*="post-card"]',
    '[class*="ad-card"]', '[class*="search-result"]',
    '[class*="lot"]', '[class*="auction"]',
    'article.post', 'article',
  ];

  for (const selector of ALL_SELECTORS) {
    $(selector).each((_, el) => {
      const element = $(el);
      const text = element.text();
      if (!text.toLowerCase().includes(keywordLower)) return;

      let titleEl = element.find('h1, h2, h3, h4').first();
      if (!titleEl.length) {
        titleEl = element.find('[class*="title"], [class*="name"], [class*="heading"]').first();
      }
      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;
      if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      const linkEl = element.is('a') ? element : (element.closest('a').length ? element.closest('a') : element.find('a[href]').first());
      const href = linkEl.attr('href') || '';
      const productUrl = resolveUrl(href, baseUrl);

      const priceEl = element.find('[class*="price"], [class*="cost"], [class*="amount"], [itemprop="price"]').first();
      const price = extractPrice(priceEl.text() || '') ?? extractPriceFromTitle(rawTitle);

      const inStock = isInStock(element);
      if (options.inStockOnly && !inStock) return;
      if (options.maxPrice && price && price > options.maxPrice) return;

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: productUrl, inStock });
    });
  }

  return matches;
}

// ── Unified extraction dispatcher ──────────────────────────────────────────────

function extractMatchesFromHtml(
  html: string,
  keyword: string,
  baseUrl: string,
  options: ExtractionOptions = {}
): { matches: ScrapedMatch[]; siteType: SiteType; loginRequired: boolean } {
  const $ = cheerio.load(html);
  const siteType = detectSiteType(baseUrl, $);
  const loginRequired = siteType === 'forum' && isLoginPage($);

  let matches: ScrapedMatch[] = [];

  switch (siteType) {
    case 'retailer':
      matches = extractRetailerMatches($, keyword, baseUrl, options);
      break;
    case 'classifieds':
      matches = extractClassifiedsMatches($, keyword, baseUrl, options);
      break;
    case 'forum':
      if (!loginRequired) {
        matches = extractForumMatches($, keyword, baseUrl, options);
      }
      break;
    case 'auction':
      matches = extractAuctionMatches($, keyword, baseUrl, options);
      break;
    default:
      matches = extractGenericMatches($, keyword, baseUrl, options);
  }

  // If type-specific extraction found nothing, fall through to generic
  if (matches.length === 0 && siteType !== 'generic' && !loginRequired) {
    matches = extractGenericMatches($, keyword, baseUrl, options);
  }

  // Fallback: <a> tags wrapping content blocks
  if (matches.length === 0 && !loginRequired) {
    const keywordLower = keyword.toLowerCase();
    const seen = new Set<string>();

    $('a[href]').each((_, el) => {
      const element = $(el);
      const children = element.children();
      if (children.length === 0) return;

      const text = element.text().trim();
      if (text.length < 10) return;
      if (!text.toLowerCase().includes(keywordLower)) return;

      const href = element.attr('href') || '';
      const productUrl = resolveUrl(href, baseUrl);

      const titleEl = element.find('h1, h2, h3, h4, [class*="title"], [class*="field-name-title"]').first();
      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      const priceEl = element.find('[class*="price"], [class*="cost"], [class*="amount"]').first();
      const price = extractPrice(priceEl.text() || '') ?? extractPriceFromTitle(rawTitle);

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: productUrl });
    });
  }

  // Fallback: plain text links
  if (matches.length === 0 && !loginRequired) {
    const keywordLower = keyword.toLowerCase();
    const seen = new Set<string>();

    $('a[href]').each((_, el) => {
      const element = $(el);
      const text = element.text().trim();
      if (text.length < 5) return;
      if (!text.toLowerCase().includes(keywordLower)) return;

      const href = element.attr('href') || '';
      const productUrl = resolveUrl(href, baseUrl);
      const titleKey = text.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      seen.add(titleKey);
      matches.push({ title: text.replace(/\s+/g, ' ').slice(0, 160), url: productUrl });
    });
  }

  // Fallback: keyword in body text
  if (matches.length === 0 && !loginRequired) {
    const bodyText = $('body').text();
    if (bodyText.toLowerCase().includes(keyword.toLowerCase())) {
      matches.push({
        title: `Keyword "${keyword}" detected on page`,
        url: baseUrl,
        inStock: true,
      });
    }
  }

  return { matches, siteType, loginRequired };
}

// ── URL helpers ────────────────────────────────────────────────────────────────

function detectSearchUrls(html: string, baseUrl: string, keyword: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  const encoded = encodeURIComponent(keyword);

  $('form[action]').each((_, el) => {
    const form = $(el);
    const action = form.attr('action') || '';
    const searchInput = form.find('input[type="search"], input[type="text"]').first();
    if (!searchInput.length) return;

    const inputName = searchInput.attr('name');
    if (!inputName) return;

    const resolvedAction = resolveUrl(action, baseUrl);
    const separator = resolvedAction.includes('?') ? '&' : '?';
    urls.push(`${resolvedAction}${separator}${inputName}=${encoded}`);
  });

  return urls;
}

function buildSearchUrls(baseUrl: string, keyword: string): string[] {
  try {
    const u = new URL(baseUrl);
    const origin = u.origin;
    const encoded = encodeURIComponent(keyword);
    return [
      `${origin}/?s=${encoded}`,
      `${origin}/search?q=${encoded}`,
      `${origin}/search?keyword=${encoded}`,
      `${origin}/ads?key=${encoded}`,
      `${origin}/catalogsearch/result/?q=${encoded}`,
    ];
  } catch {
    return [];
  }
}

function buildForumSearchUrls(baseUrl: string, keyword: string): string[] {
  try {
    const u = new URL(baseUrl);
    const origin = u.origin;
    const bare = u.hostname.toLowerCase().replace(/^www\./, '');
    const encoded = encodeURIComponent(keyword);
    const urls: string[] = [];

    // Read listing URLs and search template from site profile
    const entry = _getSiteCacheEntry(bare);
    const profile = entry?.siteProfile;

    if (profile?.searchUrlTemplate) {
      const searchPath = profile.searchUrlTemplate.replace('{keyword}', encoded);
      urls.push(`${origin}${searchPath}`);
    }
    if (profile?.listingUrls && Array.isArray(profile.listingUrls)) {
      for (const path of profile.listingUrls) {
        urls.push(`${origin}${path}`);
      }
    }

    // Generic forum search fallbacks
    urls.push(
      `${origin}/forum/search.php?do=process&query=${encoded}&titleonly=1`,
      `${origin}/search/?q=${encoded}&t=post`,
      `${origin}/search/search?keywords=${encoded}`,
      `${origin}/search.php?keywords=${encoded}&terms=all&sf=titleonly`,
    );

    return urls;
  } catch {
    return [];
  }
}

function buildAuctionSearchUrls(baseUrl: string, keyword: string): string[] {
  try {
    const u = new URL(baseUrl);
    const origin = u.origin;
    const bare = u.hostname.toLowerCase().replace(/^www\./, '');
    const encoded = encodeURIComponent(keyword);
    const urls: string[] = [];

    // Read search URL template from site profile
    const entry = _getSiteCacheEntry(bare);
    const profile = entry?.siteProfile;

    if (profile?.searchUrlTemplate) {
      const searchPath = profile.searchUrlTemplate.replace('{keyword}', encoded);
      urls.push(`${origin}${searchPath}`);
    }

    // Generic auction search fallbacks
    urls.push(`${origin}/search?q=${encoded}`);
    urls.push(`${origin}/search?keyword=${encoded}`);

    return urls;
  } catch {
    return [];
  }
}

// ── Auction aggregator ──────────────────────────────────────────────────────

function extractAuctionSessionLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const sessions: { url: string; text: string; score: number }[] = [];
  const seen = new Set<string>();
  const origin = (() => { try { return new URL(baseUrl).origin; } catch { return ''; } })();

  const FIREARM_KEYWORDS = [
    'firearm', 'firearms', 'gun', 'guns', 'rifle', 'shotgun', 'handgun', 'pistol',
    'ammo', 'ammunition', 'bows', 'militaria', 'military', 'weapon', 'surplus',
  ];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    const resolved = href.startsWith('http') ? href : resolveUrl(href, baseUrl);

    if (/_as\d+/.test(resolved)) {
      if (/signup|register|login|account|itembid/i.test(resolved)) return;
      if (/get approved|auction details/i.test(text)) return;
      if (text.length < 5) return;
      if (origin && !resolved.startsWith(origin)) return;
      if (seen.has(resolved)) return;
      seen.add(resolved);

      const combined = `${text} ${resolved}`.toLowerCase();
      let score = 0;
      for (const kw of FIREARM_KEYWORDS) {
        if (combined.includes(kw)) score += 5;
      }

      sessions.push({ url: resolved, text, score });
    }
  });

  sessions.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return sessions.map(s => s.url);
}

// ── iCollector CloudSearch JSON API ─────────────────────────────────────────────

function icollectorFriendlyUrl(title: string, itemId: number, origin: string, urlPattern?: string): string {
  const slug = title
    .replace(/[^a-zA-Z0-9\- ]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+$|(-)+/g, '-');
  // Use profile's urlPattern if available, otherwise default
  if (urlPattern) {
    return `${origin}${urlPattern.replace('{slug}', slug).replace('{itemId}', String(itemId))}`;
  }
  return `${origin}/${slug}_i${itemId}`;
}

interface ICollectorItem {
  ItemID: number;
  ItemTitle: string;
  ItemLot: string;
  ItemCurrentBidAmount: number;
  AuctionCurrencyCode: string;
  AuctioneerName: string;
  AuctionCity: string;
  AuctionProvince: string;
  AuctionCountry: string;
}

async function searchICollector(
  keyword: string,
  options: { fast?: boolean } = {}
): Promise<ScrapedMatch[]> {
  // Read API endpoint and origin from site profile, fall back to defaults
  const entry = _getSiteCacheEntry('icollector.com');
  const profile = entry?.siteProfile;
  const API_URL = profile?.apiEndpoint || 'https://www.icollector.com/handlers/controls/CloudsearchItemSearch.ashx';
  const urlPattern = profile?.urlPattern;
  const origin = profile?.apiEndpoint
    ? new URL(profile.apiEndpoint).origin
    : 'https://www.icollector.com';
  const domain = profile?.apiEndpoint
    ? new URL(profile.apiEndpoint).hostname
    : 'icollector.com';
  const maxItems = options.fast ? 50 : 100;

  const response = await axios.get(API_URL, {
    params: {
      command: 'searchitems',
      unitsPerPage: maxItems,
      page: 1,
      isCurrent: 1,
      keywords: keyword,
      sortBy: 'TimeLeft',
      searchFields: 'ItemName',
      exactKeywords: 'false',
      hasImage: 'false',
    },
    headers: {
      'User-Agent': pickUserAgent(domain),
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${origin}/search.aspx`,
    },
    timeout: 20000,
  });

  const data = response.data;
  const items: ICollectorItem[] = data.ItemResults || [];
  const totalCount: number = data.ItemCount || 0;
  const keywordLower = keyword.toLowerCase();

  const matches: ScrapedMatch[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const title = (item.ItemTitle || '').trim();
    if (!title) continue;

    if (!title.toLowerCase().includes(keywordLower)) continue;

    const titleKey = title.toLowerCase().slice(0, 60);
    if (seen.has(titleKey)) continue;
    seen.add(titleKey);

    const url = icollectorFriendlyUrl(title, item.ItemID, origin, urlPattern);
    const price = item.ItemCurrentBidAmount > 0 ? item.ItemCurrentBidAmount : undefined;

    matches.push({ title: title.slice(0, 160), price, url });
  }

  console.log(`[Scraper] iCollector search for "${keyword}": ${matches.length} matches (${totalCount} total results from API)`);
  return matches;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function scrapeForKeyword(
  websiteUrl: string,
  keyword: string,
  options: { inStockOnly?: boolean; maxPrice?: number; cookies?: string; fast?: boolean } = {}
): Promise<ScrapeResult> {
  if (!options.fast) await randomDelay();

  const html = await fetchPage(websiteUrl, options.cookies);
  let { matches, siteType, loginRequired } = extractMatchesFromHtml(html, keyword, websiteUrl, options);

  console.log(`[Scraper] Site type: ${siteType} for ${websiteUrl}${loginRequired ? ' (login required)' : ''}`);

  // If login is required and no matches, return early with the flag
  if (loginRequired && matches.length === 0) {
    return {
      matches: [],
      contentHash: crypto.createHash('sha256').update(`login-required:${websiteUrl}`).digest('hex').slice(0, 16),
      scrapedAt: new Date(),
      loginRequired: true,
    };
  }

  // CloudSearch API for sites that support it (e.g. iCollector)
  if (matches.length === 0 && isBareDomain(websiteUrl)) {
    try {
      const hostname = new URL(websiteUrl).hostname.toLowerCase().replace(/^www\./, '');
      const siteEntry = _getSiteCacheEntry(hostname);
      if (siteEntry?.siteProfile?.searchApiMethod === 'cloudsearch') {
        const icMatches = await searchICollector(keyword, { fast: options.fast });
        if (icMatches.length > 0) {
          matches = icMatches;
          console.log(`[Scraper] CloudSearch API found ${matches.length} lots for "${keyword}" on ${hostname}`);
        }
      }
    } catch (err) {
      console.log(`[Scraper] CloudSearch API search failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  // Auto-search fallback for bare domains
  if (matches.length === 0 && isBareDomain(websiteUrl)) {
    const delayRange = options.fast ? [100, 300] as const : [500, 1500] as const;

    // Phase 1: Use site navigator to find listing pages (cached after first discovery)
    try {
      const siteMap = await getListingUrls(websiteUrl, options.cookies);
      console.log(`[Scraper] Site navigator: ${siteMap.listingUrls.length} listing pages, type=${siteMap.siteType}, cached=${siteMap.fromCache}`);

      const delayMs = delayRange;
      const listingHtmlCache: Map<string, string> = new Map();
      for (const listingUrl of siteMap.listingUrls) {
        try {
          await randomDelay(delayMs[0], delayMs[1]);
          const listingHtml = await fetchPage(listingUrl, options.cookies);
          listingHtmlCache.set(listingUrl, listingHtml);
          const listingResult = extractMatchesFromHtml(listingHtml, keyword, listingUrl, options);
          if (listingResult.matches.length > 0) {
            matches.push(...listingResult.matches);
            console.log(`[Scraper] Found ${listingResult.matches.length} matches on listing page: ${listingUrl}`);
          }
        } catch (err) {
          console.log(`[Scraper] Failed to scrape listing page ${listingUrl}: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      }

      // Auction aggregator: follow session links to find actual lots
      if (matches.length === 0 && siteMap.siteType === 'auction') {
        const auctionSessionLinks: string[] = [];
        for (const [listingUrl, listingHtml] of listingHtmlCache) {
          const $listing = cheerio.load(listingHtml);
          const sessionLinks = extractAuctionSessionLinks($listing, listingUrl);
          auctionSessionLinks.push(...sessionLinks);
        }

        if (auctionSessionLinks.length > 0) {
          const maxSessions = options.fast ? 4 : 8;
          console.log(`[Scraper] Auction aggregator: found ${auctionSessionLinks.length} auction sessions, scraping up to ${maxSessions}...`);
          const sessionsToScrape = auctionSessionLinks.slice(0, maxSessions);

          for (const sessionUrl of sessionsToScrape) {
            try {
              await randomDelay(delayMs[0], delayMs[1]);
              const sessionHtml = await fetchPage(sessionUrl, options.cookies);
              const sessionResult = extractMatchesFromHtml(sessionHtml, keyword, sessionUrl, options);
              if (sessionResult.matches.length > 0) {
                matches.push(...sessionResult.matches);
                console.log(`[Scraper] Found ${sessionResult.matches.length} matches in auction: ${sessionUrl}`);
              }

              if (sessionUrl.includes('_as')) {
                const $session = cheerio.load(sessionHtml);
                const pageLinks: string[] = [];
                $session('a[href]').each((_, el) => {
                  const href = $session(el).attr('href') || '';
                  if (/_as\d+_p\d+/.test(href) && !pageLinks.includes(href)) {
                    const resolved = href.startsWith('http') ? href : resolveUrl(href, sessionUrl);
                    if (!pageLinks.includes(resolved)) pageLinks.push(resolved);
                  }
                });

                const maxPages = options.fast ? 1 : 2;
                for (const pageUrl of pageLinks.slice(0, maxPages)) {
                  try {
                    await randomDelay(delayMs[0], delayMs[1]);
                    const pageHtml = await fetchPage(pageUrl, options.cookies);
                    const pageResult = extractMatchesFromHtml(pageHtml, keyword, pageUrl, options);
                    if (pageResult.matches.length > 0) {
                      matches.push(...pageResult.matches);
                      console.log(`[Scraper] Found ${pageResult.matches.length} matches on page: ${pageUrl}`);
                    }
                  } catch { /* pagination fetch failed */ }
                }
              }
            } catch (err) {
              console.log(`[Scraper] Failed to scrape auction session ${sessionUrl}: ${err instanceof Error ? err.message : 'unknown'}`);
            }
          }
        }
      }

      // Try cached search URL template
      if (matches.length === 0 && siteMap.searchUrlTemplate) {
        const searchUrl = siteMap.searchUrlTemplate.replace('{keyword}', encodeURIComponent(keyword));
        try {
          await randomDelay(delayMs[0], delayMs[1]);
          const searchHtml = await fetchPage(searchUrl, options.cookies);
          const searchResult = extractMatchesFromHtml(searchHtml, keyword, searchUrl, options);
          if (searchResult.matches.length > 0) {
            matches = searchResult.matches;
            console.log(`[Scraper] Found ${matches.length} matches via cached search template: ${searchUrl}`);
          }
        } catch {
          // Search template didn't work
        }
      }
    } catch (err) {
      console.log(`[Scraper] Site navigator failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    // Phase 2: Fall back to detected and generic search URLs
    if (matches.length === 0) {
      const detectedUrls = detectSearchUrls(html, websiteUrl, keyword);

      let typeSearchUrls: string[] = [];
      if (siteType === 'forum') {
        typeSearchUrls = buildForumSearchUrls(websiteUrl, keyword);
      } else if (siteType === 'auction') {
        typeSearchUrls = buildAuctionSearchUrls(websiteUrl, keyword);
      }

      const searchUrls = [...detectedUrls, ...typeSearchUrls, ...buildSearchUrls(websiteUrl, keyword)];
      const tried = new Set<string>();

      for (const searchUrl of searchUrls) {
        if (tried.has(searchUrl)) continue;
        tried.add(searchUrl);
        try {
          await randomDelay(delayRange[0], delayRange[1]);
          const searchHtml = await fetchPage(searchUrl, options.cookies);
          const searchResult = extractMatchesFromHtml(searchHtml, keyword, searchUrl, options);
          if (searchResult.matches.length > 0) {
            matches = searchResult.matches;
            break;
          }
        } catch {
          // Search URL doesn't exist on this site, try next pattern
        }
      }
    }
  }

  // Deduplicate matches
  if (matches.length > 1) {
    const seen = new Set<string>();
    matches = matches.filter(m => {
      const key = m.url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Deterministic content hash
  const hashInput = matches.map((m) => m.url).sort().join('|');
  const contentHash = crypto
    .createHash('sha256')
    .update(hashInput || `empty:${websiteUrl}`)
    .digest('hex')
    .slice(0, 16);

  return { matches, contentHash, scrapedAt: new Date(), loginRequired };
}
