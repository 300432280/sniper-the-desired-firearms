import * as cheerio from 'cheerio';
import { prisma } from '../lib/prisma';
import { fetchPage } from './scraper';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SiteMapResult {
  listingUrls: string[];
  searchUrlTemplate: string | null;
  siteType: string;
  fromCache: boolean;
}

interface NavLink {
  url: string;
  text: string;
  context: 'nav' | 'header' | 'sidebar' | 'body';
}

interface ScoredLink extends NavLink {
  score: number;
}

interface DiscoveryResult {
  listingUrls: string[];
  searchUrlTemplate: string | null;
  siteType: string;
}

// ── Known site overrides (skip discovery for these) ──────────────────────────

interface SiteOverride {
  listingPaths: string[];
  searchTemplate?: string;
  siteType: string;
}

const SITE_OVERRIDES: Record<string, SiteOverride> = {
  'canadiangunnutz.com': {
    listingPaths: [
      '/forum/index.php?forums/exchange-of-military-surplus-rifle.44/',
      '/forum/index.php?forums/exchange-of-handguns.7/',
      '/forum/index.php?forums/exchange-of-rifles.8/',
      '/forum/index.php?forums/exchange-of-shotguns.9/',
      '/forum/index.php?forums/exchange-of-firearm-parts.46/',
    ],
    searchTemplate: '/forum/search/?q={keyword}&t=post',
    siteType: 'forum',
  },
  'gunownersofcanada.ca': {
    listingPaths: [
      '/forums/equipment-exchange.35/',
    ],
    searchTemplate: '/search/?q={keyword}&t=post',
    siteType: 'forum',
  },
  'icollector.com': {
    listingPaths: ['/Firearms-Gun-Auctions_aca880000'],
    siteType: 'auction',
  },
};

// ── Scoring keywords ─────────────────────────────────────────────────────────

const URL_KEYWORDS: Record<string, number> = {
  'exchange': 10, 'for-sale': 10, 'classifieds': 10, 'marketplace': 10,
  'firearms': 9, 'guns': 9, 'rifles': 8, 'handguns': 8, 'shotguns': 8,
  'auction': 9, 'lots': 8, 'catalog': 8, 'auctionlist': 9,
  'shop': 7, 'store': 7, 'products': 7, 'collections': 7,
  'buy-sell': 9, 'surplus': 7, 'equipment': 5, 'accessories': 4,
};

const TEXT_KEYWORDS: Record<string, number> = {
  'exchange': 10, 'for sale': 10, 'classifieds': 10, 'marketplace': 10,
  'buy & sell': 9, 'buy and sell': 9, 'equipment exchange': 12,
  'firearms': 8, 'guns': 8, 'rifles': 7, 'handguns': 7, 'shotguns': 7,
  'auction': 9, 'lots': 8, 'catalog': 8, 'current auctions': 10,
  'shop': 6, 'store': 6, 'products': 6, 'all products': 7,
  'surplus': 6, 'equipment': 5,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0].toLowerCase();
  }
}

function normalizeToOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return url;
  }
}

function resolveHref(href: string, baseUrl: string): string {
  try {
    if (!href || href === '#') return '';
    if (href.startsWith('http')) return href;
    return new URL(href, baseUrl).toString();
  } catch {
    return '';
  }
}

function isExcludedUrl(url: string): boolean {
  const lower = url.toLowerCase();
  const exclude = [
    '/login', '/register', '/signup', '/account', '/profile',
    '/contact', '/about', '/privacy', '/terms', '/faq', '/help',
    '/cart', '/checkout', '/wishlist', '/settings',
    'javascript:', 'mailto:', 'tel:',
    '.pdf', '.jpg', '.png', '.gif', '.zip', '.exe',
  ];
  return exclude.some(p => lower.includes(p));
}

function fixedDelay(ms = 1400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Link extraction ──────────────────────────────────────────────────────────

function extractNavLinks($: cheerio.CheerioAPI, baseUrl: string): NavLink[] {
  const links: NavLink[] = [];
  const origin = normalizeToOrigin(baseUrl);
  const seen = new Set<string>();

  const selectors: { selector: string; context: NavLink['context'] }[] = [
    { selector: 'nav a[href]', context: 'nav' },
    { selector: 'header a[href]', context: 'header' },
    { selector: '[role="navigation"] a[href]', context: 'nav' },
    { selector: '[class*="menu"] a[href]', context: 'nav' },
    { selector: '[class*="nav-"] a[href]', context: 'nav' },
    { selector: '[class*="sidebar"] a[href]', context: 'sidebar' },
    { selector: '[class*="categories"] a[href]', context: 'sidebar' },
    // XenForo
    { selector: '.node-title a[href]', context: 'nav' },
    { selector: '.nodeTitle a[href]', context: 'nav' },
    // vBulletin
    { selector: 'a[href*="forumdisplay"]', context: 'nav' },
    { selector: 'a[href*="forums/"]', context: 'nav' },
    // General categories/sections
    { selector: '[class*="category"] a[href]', context: 'sidebar' },
    { selector: '[class*="department"] a[href]', context: 'sidebar' },
  ];

  for (const { selector, context } of selectors) {
    $(selector).each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = resolveHref(href, baseUrl);
      if (!resolved) return;
      if (!resolved.startsWith(origin)) return;
      if (isExcludedUrl(resolved)) return;
      if (resolved === baseUrl || resolved === `${baseUrl}/`) return;
      if (seen.has(resolved)) return;
      seen.add(resolved);

      links.push({
        url: resolved,
        text: $(el).text().trim().replace(/\s+/g, ' ').slice(0, 100),
        context,
      });
    });
  }

  return links;
}

// ── Link scoring ─────────────────────────────────────────────────────────────

function scoreLinkRelevance(link: NavLink, siteType: string): number {
  let score = 0;
  const urlLower = link.url.toLowerCase();
  const textLower = link.text.toLowerCase();

  for (const [kw, points] of Object.entries(URL_KEYWORDS)) {
    if (urlLower.includes(kw)) score += points;
  }

  for (const [kw, points] of Object.entries(TEXT_KEYWORDS)) {
    if (textLower.includes(kw)) score += points;
  }

  // Navigation context bonus
  if (link.context === 'nav' || link.context === 'header') score += 3;
  if (link.context === 'sidebar') score += 1;

  // Site-type affinity
  if (siteType === 'forum' && (urlLower.includes('forum') || urlLower.includes('exchange'))) score += 4;
  if (siteType === 'auction' && (urlLower.includes('auction') || urlLower.includes('lot') || urlLower.includes('catalog'))) score += 4;
  if (siteType === 'retailer' && (urlLower.includes('product') || urlLower.includes('collection') || urlLower.includes('shop'))) score += 4;
  if (siteType === 'classifieds' && (urlLower.includes('classified') || urlLower.includes('ads') || urlLower.includes('listing'))) score += 4;

  // Penalize deep paths (likely individual items)
  try {
    const depth = new URL(link.url).pathname.split('/').filter(Boolean).length;
    if (depth > 4) score -= 3;
  } catch { /* ignore */ }

  return score;
}

// ── Page evaluation ──────────────────────────────────────────────────────────

function measureListingDensity($: cheerio.CheerioAPI): number {
  const selectorGroups = [
    // Forum
    ['.structItem', '[class*="structItem--thread"]', '[class*="threadbit"]', 'li[id^="thread_"]'],
    // Auction
    ['[class*="lot-item"]', '[class*="lotItem"]', '[class*="catalog-item"]', '[class*="auction-item"]', '[class*="catLot"]'],
    // Retailer
    ['[data-product-id]', '[class*="product-card"]', '[class*="product-item"]', '[class*="product-tile"]'],
    // Classifieds
    ['[class*="classified-ad"]', '[class*="classified-item"]', '[class*="listing-card"]', '[class*="listing-item"]', '[class*="gunpost-teaser"]'],
  ];

  let maxCount = 0;
  for (const group of selectorGroups) {
    for (const selector of group) {
      const count = $(selector).length;
      if (count > maxCount) maxCount = count;
    }
  }

  // Fallback: articles
  if (maxCount === 0) {
    maxCount = $('article').length;
  }

  return maxCount;
}

async function evaluatePages(
  candidates: ScoredLink[],
  cookies?: string
): Promise<string[]> {
  const results: { url: string; density: number }[] = [];

  for (const candidate of candidates) {
    try {
      await fixedDelay(1400);
      const html = await fetchPage(candidate.url, cookies);
      const $ = cheerio.load(html);
      const density = measureListingDensity($);

      if (density >= 2) {
        results.push({ url: candidate.url, density });
        console.log(`[SiteNavigator] Found listing page: ${candidate.url} (density: ${density})`);
      }
    } catch (err) {
      console.log(`[SiteNavigator] Skipping ${candidate.url}: ${err instanceof Error ? err.message : 'fetch failed'}`);
    }
  }

  return results
    .sort((a, b) => b.density - a.density || a.url.localeCompare(b.url))
    .slice(0, 5)
    .map(r => r.url);
}

// ── Search URL detection ─────────────────────────────────────────────────────

function detectSearchUrlTemplate($: cheerio.CheerioAPI, baseUrl: string): string | null {
  const forms = $('form[action]');
  for (let i = 0; i < forms.length; i++) {
    const form = $(forms[i]);
    const action = form.attr('action') || '';
    const searchInput = form.find('input[type="search"], input[type="text"]').first();
    if (!searchInput.length) continue;

    const inputName = searchInput.attr('name');
    if (!inputName) continue;

    const resolvedAction = resolveHref(action, baseUrl);
    if (!resolvedAction) continue;
    const separator = resolvedAction.includes('?') ? '&' : '?';
    return `${resolvedAction}${separator}${inputName}={keyword}`;
  }

  return null;
}

// ── Site type detection (lightweight) ────────────────────────────────────────

function detectSiteTypeFromHtml($: cheerio.CheerioAPI): string {
  const html = $.html();
  if ($('[data-xf-init]').length || html.includes('XenForo') || $('[class*="structItem"]').length) return 'forum';
  if ($('[class*="threadbit"]').length || html.includes('vBulletin')) return 'forum';
  if ($('[class*="lot-item"]').length || $('[class*="auction-item"]').length) return 'auction';
  if ($('[data-product-id]').length || html.includes('Shopify') || html.includes('WooCommerce')) return 'retailer';
  if ($('[class*="classified"]').length >= 2 || $('[class*="gunpost"]').length) return 'classifieds';
  return 'generic';
}

// ── Core discovery ───────────────────────────────────────────────────────────

async function discoverSite(websiteUrl: string, cookies?: string): Promise<DiscoveryResult> {
  const domain = normalizeDomain(websiteUrl);
  let origin = normalizeToOrigin(websiteUrl);

  // Ensure www. prefix — many sites (e.g. CGN) require it
  try {
    const u = new URL(origin);
    if (!u.hostname.startsWith('www.')) {
      u.hostname = `www.${u.hostname}`;
      origin = u.origin;
    }
  } catch { /* keep original */ }

  // Check for hardcoded override
  const override = SITE_OVERRIDES[domain];
  if (override) {
    console.log(`[SiteNavigator] Using override for ${domain}`);
    return {
      listingUrls: override.listingPaths.map(p => `${origin.replace(/\/$/, '')}${p}`),
      searchUrlTemplate: override.searchTemplate ? `${origin.replace(/\/$/, '')}${override.searchTemplate}` : null,
      siteType: override.siteType,
    };
  }

  // Generic discovery
  console.log(`[SiteNavigator] Discovering ${domain}...`);
  let html: string;
  try {
    html = await fetchPage(websiteUrl.startsWith('http') ? websiteUrl : `https://www.${domain}`, cookies);
  } catch (err) {
    console.log(`[SiteNavigator] Failed to fetch homepage for ${domain}: ${err instanceof Error ? err.message : 'unknown'}`);
    return { listingUrls: [], searchUrlTemplate: null, siteType: 'generic' };
  }

  const $ = cheerio.load(html);
  const siteType = detectSiteTypeFromHtml($);

  // Extract and score nav links
  const baseUrl = websiteUrl.startsWith('http') ? websiteUrl : `https://www.${domain}`;
  const navLinks = extractNavLinks($, baseUrl);
  const scoredLinks: ScoredLink[] = navLinks
    .map(link => ({ ...link, score: scoreLinkRelevance(link, siteType) }))
    .filter(link => link.score > 0)
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, 8);

  console.log(`[SiteNavigator] Found ${navLinks.length} nav links, ${scoredLinks.length} scored above 0`);

  // Evaluate pages
  const listingUrls = await evaluatePages(scoredLinks, cookies);

  // Detect search URL
  const searchUrlTemplate = detectSearchUrlTemplate($, baseUrl);

  console.log(`[SiteNavigator] Discovery complete: ${listingUrls.length} listing pages, search: ${searchUrlTemplate ? 'yes' : 'no'}`);

  return { listingUrls, searchUrlTemplate, siteType };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getListingUrls(websiteUrl: string, cookies?: string): Promise<SiteMapResult> {
  const domain = normalizeDomain(websiteUrl);

  // Check cache
  const cached = await prisma.siteMap.findUnique({ where: { domain } });
  if (cached && cached.expiresAt > new Date()) {
    // Update hit count
    await prisma.siteMap.update({
      where: { domain },
      data: { hitCount: { increment: 1 } },
    }).catch(() => {}); // non-critical

    const listingUrls: string[] = JSON.parse(cached.listingUrls);
    return {
      listingUrls,
      searchUrlTemplate: cached.searchUrl,
      siteType: cached.siteType,
      fromCache: true,
    };
  }

  // Discover
  const result = await discoverSite(websiteUrl, cookies);

  // Check again in case another worker discovered while we were running
  const existingAgain = await prisma.siteMap.findUnique({ where: { domain } });
  if (existingAgain && existingAgain.expiresAt > new Date()) {
    const listingUrls: string[] = JSON.parse(existingAgain.listingUrls);
    return {
      listingUrls,
      searchUrlTemplate: existingAgain.searchUrl,
      siteType: existingAgain.siteType,
      fromCache: true,
    };
  }

  // Cache result
  const ttlDays = result.listingUrls.length > 0 ? 7 : 1;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  await prisma.siteMap.upsert({
    where: { domain },
    update: {
      siteType: result.siteType,
      listingUrls: JSON.stringify(result.listingUrls),
      searchUrl: result.searchUrlTemplate,
      discoveredAt: new Date(),
      expiresAt,
      hitCount: 0,
    },
    create: {
      domain,
      siteType: result.siteType,
      listingUrls: JSON.stringify(result.listingUrls),
      searchUrl: result.searchUrlTemplate,
      expiresAt,
    },
  });

  return {
    listingUrls: result.listingUrls,
    searchUrlTemplate: result.searchUrlTemplate,
    siteType: result.siteType,
    fromCache: false,
  };
}

export async function invalidateSiteMap(domain: string): Promise<void> {
  const normalized = domain.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0].toLowerCase();
  await prisma.siteMap.deleteMany({ where: { domain: normalized } });
}
