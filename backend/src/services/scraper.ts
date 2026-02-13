import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Edge/120.0.0.0',
];

export interface ScrapedMatch {
  title: string;
  price?: number;
  url: string;
  inStock?: boolean;
}

export interface ScrapeResult {
  matches: ScrapedMatch[];
  contentHash: string;
  scrapedAt: Date;
}

function randomDelay(minMs = 800, maxMs = 2500): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function extractPrice(text: string): number | undefined {
  // Match "$1,299.99", "1299.99", "$1299", "CAD 499"
  const match = text.match(/(?:CAD\s*)?(?:\$\s*)?([\d,]+(?:\.\d{1,2})?)/);
  if (!match) return undefined;
  const value = parseFloat(match[1].replace(/,/g, ''));
  return value > 0 ? value : undefined;
}

function isInStock(element: cheerio.Cheerio<cheerio.Element>): boolean {
  const text = element.text().toLowerCase();
  const outTerms = ['out of stock', 'sold out', 'unavailable', 'backordered', 'discontinued'];
  const inTerms = ['in stock', 'add to cart', 'buy now', 'available', 'order now'];

  if (outTerms.some((t) => text.includes(t))) return false;
  if (inTerms.some((t) => text.includes(t))) return true;

  // Check for disabled add-to-cart button
  const btn = element.find('button[class*="cart"], button[class*="buy"], [id*="add-to-cart"]').first();
  if (btn.length && (btn.attr('disabled') !== undefined || btn.hasClass('disabled'))) return false;

  return true; // Default to optimistic
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    if (!href || href === '#') return baseUrl;
    if (href.startsWith('http')) return href;
    return new URL(href, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

async function fetchPage(url: string): Promise<string> {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': pickUserAgent(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Upgrade-Insecure-Requests': '1',
    },
    timeout: 20000,
    maxRedirects: 5,
  });
  return response.data as string;
}

function extractMatchesFromHtml(
  html: string,
  keyword: string,
  baseUrl: string,
  options: { inStockOnly?: boolean; maxPrice?: number } = {}
): ScrapedMatch[] {
  const $ = cheerio.load(html);
  const keywordLower = keyword.toLowerCase();
  const matches: ScrapedMatch[] = [];
  const seen = new Set<string>();

  // Product card selectors — ordered from most specific to most generic
  const PRODUCT_SELECTORS = [
    // E-commerce
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
    // Drupal / classified sites (gunpost.ca, etc.)
    '[class*="node--type-classified"]',
    '[class*="gunpost-teaser"]',
    '[class*="node--type-"][class*="teaser"]',
    // Generic classified / listing sites
    '[class*="listing"]',
    '[class*="classified"]',
    '[class*="post-card"]',
    '[class*="ad-card"]',
    '[class*="search-result"]',
    'article.post',
    'article',
  ];

  for (const selector of PRODUCT_SELECTORS) {
    $(selector).each((_, el) => {
      const element = $(el);
      const text = element.text();

      if (!text.toLowerCase().includes(keywordLower)) return;

      // Extract title — prefer headings first, then title-class elements
      let titleEl = element.find('h1, h2, h3, h4').first();
      if (!titleEl.length) {
        titleEl = element.find('[class*="title"], [class*="name"], [class*="heading"], [class*="field-name-title"]').first();
      }
      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;
      // Skip if title looks like just a price
      if (/^\$?\d[\d,.]*$/.test(rawTitle)) return;

      // Dedup
      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      // Extract URL — check if the element itself is a link, or find one inside
      const linkEl = element.is('a') ? element : (element.closest('a').length ? element.closest('a') : element.find('a[href]').first());
      const href = linkEl.attr('href') || '';
      const productUrl = resolveUrl(href, baseUrl);

      // Extract price from dedicated price element or field
      const priceEl = element
        .find('[class*="price"], [class*="cost"], [class*="amount"], [itemprop="price"], [class*="field-price"]')
        .first();
      const price = extractPrice(priceEl.text() || '');

      // In-stock check
      const inStock = isInStock(element);

      // Apply filters
      if (options.inStockOnly && !inStock) return;
      if (options.maxPrice && price && price > options.maxPrice) return;

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: productUrl, inStock });
    });

    if (matches.length >= 10) break;
  }

  // Fallback: <a> tags wrapping content blocks that contain the keyword
  // (gunpost.ca wraps entire listing cards in <a> tags)
  if (matches.length === 0) {
    $('a[href]').each((_, el) => {
      const element = $(el);
      // Only consider links with substantial content (not just text links)
      const children = element.children();
      if (children.length === 0) return; // plain text link, skip for now

      const text = element.text().trim();
      if (text.length < 10) return;
      if (!text.toLowerCase().includes(keywordLower)) return;

      const href = element.attr('href') || '';
      const productUrl = resolveUrl(href, baseUrl);

      // Extract title from heading inside
      const titleEl = element.find('h1, h2, h3, h4, [class*="title"], [class*="field-name-title"]').first();
      const rawTitle = (titleEl.length ? titleEl.text() : text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;

      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      // Price
      const priceEl = element.find('[class*="price"], [class*="cost"], [class*="amount"]').first();
      const price = extractPrice(priceEl.text() || '');

      seen.add(titleKey);
      matches.push({ title: rawTitle, price, url: productUrl });
    });
  }

  // Fallback 2: plain text links containing the keyword
  if (matches.length === 0) {
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

  // Fallback 3: keyword exists in page body text
  if (matches.length === 0) {
    const bodyText = $('body').text();
    if (bodyText.toLowerCase().includes(keywordLower)) {
      matches.push({
        title: `Keyword "${keyword}" detected on page`,
        url: baseUrl,
        inStock: true,
      });
    }
  }

  return matches;
}

// Check if URL is just a bare domain (no meaningful path or search query)
function isBareDomain(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.pathname === '/' || u.pathname === '') && !u.search;
  } catch {
    return false;
  }
}

// Detect search URL from the page's search form(s)
function detectSearchUrls(html: string, baseUrl: string, keyword: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  const encoded = encodeURIComponent(keyword);

  $('form[action]').each((_, el) => {
    const form = $(el);
    const action = form.attr('action') || '';
    // Look for search forms — they usually have a text/search input
    const searchInput = form.find('input[type="search"], input[type="text"]').first();
    if (!searchInput.length) return;

    const inputName = searchInput.attr('name');
    if (!inputName) return;

    // Build search URL from form action + input name
    const resolvedAction = resolveUrl(action, baseUrl);
    const separator = resolvedAction.includes('?') ? '&' : '?';
    urls.push(`${resolvedAction}${separator}${inputName}=${encoded}`);
  });

  return urls;
}

// Hardcoded common search URL patterns as fallback
function buildSearchUrls(baseUrl: string, keyword: string): string[] {
  try {
    const u = new URL(baseUrl);
    const origin = u.origin;
    const encoded = encodeURIComponent(keyword);
    return [
      `${origin}/?s=${encoded}`,                       // WordPress
      `${origin}/search?q=${encoded}`,                 // Shopify, generic
      `${origin}/search?keyword=${encoded}`,           // WooCommerce variant
      `${origin}/ads?key=${encoded}`,                  // Drupal classified (gunpost.ca)
      `${origin}/catalogsearch/result/?q=${encoded}`,  // Magento
    ];
  } catch {
    return [];
  }
}

export async function scrapeForKeyword(
  websiteUrl: string,
  keyword: string,
  options: { inStockOnly?: boolean; maxPrice?: number } = {}
): Promise<ScrapeResult> {
  await randomDelay();

  const html = await fetchPage(websiteUrl);
  let matches = extractMatchesFromHtml(html, keyword, websiteUrl, options);

  // Auto-search fallback: if URL is just a domain and we found nothing,
  // try to find the site's search mechanism and use it
  if (matches.length === 0 && isBareDomain(websiteUrl)) {
    // First, try to detect search forms on the page itself
    const detectedUrls = detectSearchUrls(html, websiteUrl, keyword);
    // Then add hardcoded patterns as fallback
    const searchUrls = [...detectedUrls, ...buildSearchUrls(websiteUrl, keyword)];
    // Deduplicate
    const tried = new Set<string>();

    for (const searchUrl of searchUrls) {
      if (tried.has(searchUrl)) continue;
      tried.add(searchUrl);
      try {
        await randomDelay(500, 1500);
        const searchHtml = await fetchPage(searchUrl);
        const searchMatches = extractMatchesFromHtml(searchHtml, keyword, searchUrl, options);
        if (searchMatches.length > 0) {
          matches = searchMatches;
          break;
        }
      } catch {
        // Search URL doesn't exist on this site, try next pattern
      }
    }
  }

  // Deterministic content hash — sort URLs so reordering doesn't trigger re-notify
  const hashInput = matches
    .map((m) => m.url)
    .sort()
    .join('|');
  const contentHash = crypto
    .createHash('sha256')
    .update(hashInput || `empty:${websiteUrl}`)
    .digest('hex')
    .slice(0, 16);

  return { matches, contentHash, scrapedAt: new Date() };
}
