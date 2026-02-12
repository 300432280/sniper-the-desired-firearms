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

export async function scrapeForKeyword(
  websiteUrl: string,
  keyword: string,
  options: { inStockOnly?: boolean; maxPrice?: number } = {}
): Promise<ScrapeResult> {
  await randomDelay();

  const response = await axios.get(websiteUrl, {
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

  const $ = cheerio.load(response.data as string);
  const keywordLower = keyword.toLowerCase();
  const matches: ScrapedMatch[] = [];
  const seen = new Set<string>();

  // Product card selectors — ordered from most specific to most generic
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

      // Extract title
      const titleEl = element
        .find('h1, h2, h3, h4, [class*="title"], [class*="name"], [class*="heading"]')
        .first();
      const rawTitle = (titleEl.text() || text).trim().replace(/\s+/g, ' ').slice(0, 160);
      if (!rawTitle || rawTitle.length < 3) return;

      // Dedup
      const titleKey = rawTitle.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      // Extract URL
      const linkEl = element.is('a') ? element : element.find('a[href]').first();
      const href = linkEl.attr('href') || '';
      const productUrl = resolveUrl(href, websiteUrl);

      // Extract price
      const priceEl = element
        .find('[class*="price"], [class*="cost"], [class*="amount"], [itemprop="price"]')
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

    if (matches.length >= 3) break;
  }

  // Fallback: if no structured product cards found, look for any link containing the keyword
  if (matches.length === 0) {
    $('a[href]').each((_, el) => {
      const element = $(el);
      const text = element.text().trim();
      if (text.length < 5) return;
      if (!text.toLowerCase().includes(keywordLower)) return;

      const href = element.attr('href') || '';
      const productUrl = resolveUrl(href, websiteUrl);
      const titleKey = text.toLowerCase().slice(0, 60);
      if (seen.has(titleKey)) return;

      seen.add(titleKey);
      matches.push({ title: text.replace(/\s+/g, ' ').slice(0, 160), url: productUrl });
    });
  }

  // Fallback 2: keyword exists in page body text
  if (matches.length === 0) {
    const bodyText = $('body').text();
    if (bodyText.toLowerCase().includes(keywordLower)) {
      matches.push({
        title: `Keyword "${keyword}" detected on page`,
        url: websiteUrl,
        inStock: true,
      });
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
