import type * as cheerio from 'cheerio';
import type { SiteType } from '../types';
import { _getSiteCacheEntry } from '../adapter-registry';

/** Classify a URL by domain lookup from adapter registry cache */
export function detectSiteTypeFromDomain(url: string): SiteType | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const bare = hostname.replace(/^www\./, '');

    // Exact match from adapter registry
    const entry = _getSiteCacheEntry(bare);
    if (entry?.siteType) return entry.siteType as SiteType;

    // Subdomain match: extract parent domain and check for subdomainPattern
    const parts = bare.split('.');
    if (parts.length > 2) {
      const parentDomain = parts.slice(-2).join('.');
      const parentEntry = _getSiteCacheEntry(parentDomain);
      if (parentEntry?.siteType) {
        // Check if the parent profile declares a subdomain pattern
        const pattern = parentEntry.siteProfile?.subdomainPattern;
        if (pattern && pattern.startsWith('*.')) {
          const patternDomain = pattern.slice(2);
          if (bare.endsWith(`.${patternDomain}`)) {
            return parentEntry.siteType as SiteType;
          }
        }
        // Also match any subdomain of a known domain
        if (bare.endsWith(`.${parentDomain}`)) {
          return parentEntry.siteType as SiteType;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Classify a page by inspecting its HTML structure */
export function detectSiteTypeFromHtml($: cheerio.CheerioAPI): SiteType {
  const html = $.html();

  // Forum detection — vBulletin
  if (
    $('[id="vbulletin_html"]').length ||
    $('[class*="vb_"]').length ||
    $('[class*="threadbit"]').length ||
    $('li[id^="thread_"]').length ||
    html.includes('vbulletin') ||
    html.includes('vBulletin')
  ) {
    return 'forum';
  }

  // Forum detection — XenForo
  if (
    $('[class*="p-body"]').length ||
    $('[data-xf-init]').length ||
    $('[class*="structItem--thread"]').length ||
    html.includes('XenForo') ||
    html.includes('xf-init')
  ) {
    return 'forum';
  }

  // Forum detection — phpBB
  if (
    $('[class*="phpbb"]').length ||
    $('[id="phpbb"]').length ||
    html.includes('phpBB')
  ) {
    return 'forum';
  }

  // Auction detection
  if (
    $('[class*="lot-item"]').length ||
    $('[class*="lotItem"]').length ||
    $('[class*="catalog-item"]').length ||
    $('[class*="auction-item"]').length ||
    $('[class*="current-bid"]').length ||
    $('[class*="winning-bid"]').length ||
    ($('[class*="lot"]').length >= 3 && $('[class*="bid"]').length >= 1)
  ) {
    return 'auction';
  }

  // Classifieds detection
  if (
    $('[class*="node--type-classified"]').length ||
    $('[class*="classified-ad"]').length ||
    ($('[class*="classified"]').length >= 2) ||
    ($('[class*="listing"]').length >= 3 && $('[class*="ad"]').length >= 1)
  ) {
    return 'classifieds';
  }

  // Retailer detection
  if (
    $('[data-product-id]').length ||
    $('[class*="product-card"]').length ||
    $('[class*="product-item"]').length ||
    $('[class*="add-to-cart"]').length ||
    $('[class*="shopify"]').length ||
    $('[class*="woocommerce"]').length ||
    html.includes('Shopify') ||
    html.includes('WooCommerce')
  ) {
    return 'retailer';
  }

  return 'generic';
}

/** Detect site type by domain first, falling back to HTML analysis */
export function detectSiteType(url: string, $: cheerio.CheerioAPI): SiteType {
  return detectSiteTypeFromDomain(url) ?? detectSiteTypeFromHtml($);
}

/** Check if a page is a forum login page */
export function isLoginPage($: cheerio.CheerioAPI): boolean {
  const html = $.html().toLowerCase();
  // vBulletin login page
  if (html.includes('vb_login_username') || html.includes('do=login')) return true;
  // XenForo login page
  if ($('form[action*="login"]').length && $('input[name="login"]').length) return true;
  // Generic login page indicators
  if ($('form').filter((_, el) => {
    const action = $(el).attr('action') || '';
    return action.includes('login') || action.includes('signin');
  }).length && $('input[type="password"]').length) return true;
  return false;
}
