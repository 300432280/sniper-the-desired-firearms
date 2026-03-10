/**
 * Keyword Matcher — matches new ProductIndex entries against active Searches.
 *
 * When a new product is added to ProductIndex:
 * 1. Expand each active Search keyword via KeywordAlias → get all variations
 * 2. Check if product title contains any alias (word-boundary match)
 * 3. If match → create Match record → trigger notification per user tier
 *
 * When a user creates a new Search:
 * 1. Immediately query ProductIndex with alias expansion → return instant results
 */

import { prisma } from '../lib/prisma';
import { sendAlertEmail } from './email';
import { config } from '../config';
import { pushEvent } from './debugLog';

// ── Alias Expansion ─────────────────────────────────────────────────────────

/**
 * Expand a keyword to all its aliases via KeywordGroup.
 * If no alias group exists, returns the raw keyword as-is.
 */
export async function expandKeyword(keyword: string): Promise<string[]> {
  const normalized = keyword.toLowerCase().trim();

  // Look up the keyword in aliases
  const alias = await prisma.keywordAlias.findUnique({
    where: { alias: normalized },
    include: { group: { include: { aliases: true } } },
  });

  if (alias) {
    return alias.group.aliases.map(a => a.alias);
  }

  // No group found — return raw keyword
  return [normalized];
}

// ── Word Boundary Matching ──────────────────────────────────────────────────

/**
 * Check if a keyword appears in a title as a standalone token (word boundary match).
 * "sks" matches "Russian SKS Rifle" but NOT "#SKS6336A40A9S0"
 *
 * Also handles space-collapsed matching:
 *   "tm 22" matches "TM22"    ✓  (spaces in keyword, no spaces in title)
 *   "tm22"  matches "TM 22"   ✓  (no spaces in keyword, spaces in title)
 */
export function matchesKeyword(title: string, keyword: string): boolean {
  if (matchesKeywordExact(title, keyword)) return true;

  // Normalize: treat spaces and hyphens as interchangeable in model names.
  // "ar-15", "ar 15", "ar15" should all match "AR-15", "AR 15", "AR15".
  const kwStripped = keyword.replace(/[\s\-]+/g, '');
  if (kwStripped !== keyword && matchesKeywordExact(title, kwStripped)) return true;

  // Build a flexible regex from the stripped keyword that allows optional
  // spaces/hyphens between each character, with a word boundary on the left.
  // "ar15" → /(?<![a-z0-9])a[\s\-]?r[\s\-]?1[\s\-]?5/i
  // Matches: "AR-15", "AR 15", "AR15"
  if (kwStripped.length >= 3 && kwStripped.length <= 20) {
    const escaped = kwStripped.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-]?');
    const re = new RegExp(`(?<![a-z0-9])${escaped}`, 'i');
    if (re.test(title)) return true;
  }

  return false;
}

/** Core word-boundary match (no space normalization). */
function matchesKeywordExact(title: string, keyword: string): boolean {
  const titleLower = title.toLowerCase();
  const kw = keyword.toLowerCase();
  const idx = titleLower.indexOf(kw);
  if (idx === -1) return false;

  // Require word boundary on the left only (no alphanumeric before).
  // Right side is unrestricted so model variants match naturally:
  //   "sks" → "SKS45", "SKS-45", "SKS 45"    ✓
  //   "german" → "Germany"                     ✓
  //   "mauser" → "Mausers"                     ✓
  // Left boundary still prevents mid-word matches like "DESKTOP" matching "skt".
  const charBefore = idx > 0 ? titleLower[idx - 1] : ' ';
  return !/[a-z0-9]/i.test(charBefore);
}

/**
 * Extended matching: check if a keyword appears in the combined text
 * of title + tags + URL slug (not just title alone).
 *
 * This extends matchesKeyword to also search tags and URL slugs,
 * so "ammo" matches a product tagged "ammunition" even if the title
 * doesn't contain "ammo".
 */
export function matchesWithExtras(
  title: string,
  keyword: string,
  extras?: { tags?: string | null; urlSlug?: string },
): boolean {
  const combined = [title, extras?.tags || '', extras?.urlSlug || ''].join(' ');
  return matchesKeyword(combined, keyword);
}

// ── Match New Products ──────────────────────────────────────────────────────

interface MatchResult {
  matchesCreated: number;
  notificationsSent: number;
}

/**
 * Match a batch of new products against all active searches.
 * Called after products are upserted into ProductIndex.
 */
export async function matchNewProducts(
  products: Array<{ id: string; siteId: string; url: string; title: string; price?: number | null; thumbnail?: string | null; tags?: string | null }>,
): Promise<MatchResult> {
  if (products.length === 0) return { matchesCreated: 0, notificationsSent: 0 };

  // Get all active searches (with user info for notifications)
  const searches = await prisma.search.findMany({
    where: { isActive: true },
    include: { user: true },
  });

  if (searches.length === 0) return { matchesCreated: 0, notificationsSent: 0 };

  // Build siteId → domain map so we can match products to searches by site
  const siteIds = [...new Set(products.map(p => p.siteId))];
  const sites = await prisma.monitoredSite.findMany({
    where: { id: { in: siteIds } },
    select: { id: true, domain: true },
  });
  const siteIdToDomain = new Map(sites.map(s => [s.id, s.domain]));

  // Build keyword → aliases map (cached for this batch)
  const keywordAliasCache = new Map<string, string[]>();

  let matchesCreated = 0;
  let notificationsSent = 0;

  for (const search of searches) {
    const keyword = search.keyword.toLowerCase().trim();

    // Parse keyword for category filter: "7.62x39 ammo" → search "7.62x39", filter to ammunition
    const { searchTerm, categoryFilter } = parseKeywordWithCategory(keyword);

    // Get aliases for the search term (not the full keyword with category word)
    if (!keywordAliasCache.has(searchTerm)) {
      keywordAliasCache.set(searchTerm, await expandKeyword(searchTerm));
    }
    const aliases = keywordAliasCache.get(searchTerm)!;

    // Extract the domain from the search's websiteUrl for site filtering
    let searchDomain: string;
    try {
      searchDomain = new URL(search.websiteUrl).hostname.replace(/^www\./, '');
    } catch {
      continue; // Skip searches with invalid URLs
    }

    // Check title, tags, and URL slug, with optional category filtering.
    const matchingProducts = products.filter(product => {
      const productDomain = siteIdToDomain.get(product.siteId);
      if (!productDomain) return false;
      if (productDomain.replace(/^www\./, '') !== searchDomain) return false;
      const urlSlug = product.url.split('/').pop()?.replace(/-/g, ' ') || '';
      if (!aliases.some(alias =>
        matchesWithExtras(product.title, alias, { tags: product.tags, urlSlug }),
      )) return false;
      // Apply category filter if keyword had one (e.g., "7.62x39 ammo" → only ammunition)
      if (categoryFilter) {
        const matchesTags = product.tags && categoryFilter.tags.some(t => product.tags!.toLowerCase().includes(t));
        // productType is not available on the incoming product — only tags from crawler
        if (!matchesTags) return false;
      }
      return true;
    });

    if (matchingProducts.length === 0) continue;

    // Check existing matches to avoid duplicates
    const existingUrls = new Set(
      (await prisma.match.findMany({
        where: { searchId: search.id, url: { in: matchingProducts.map(p => p.url) } },
        select: { url: true },
      })).map(m => m.url),
    );

    const newProducts = matchingProducts.filter(p => !existingUrls.has(p.url));
    if (newProducts.length === 0) continue;

    // Create Match records
    await prisma.match.createMany({
      data: newProducts.map(p => ({
        searchId: search.id,
        title: p.title,
        price: p.price ?? null,
        url: p.url,
        hash: `pi:${p.id}`, // ProductIndex-sourced match
        thumbnail: p.thumbnail ?? null,
      })),
      skipDuplicates: true,
    });

    matchesCreated += newProducts.length;

    // Notify PRO users instantly
    if (search.user && search.user.tier === 'PRO' && newProducts.length > 0) {
      const recipientEmail = search.user.email ?? search.notifyEmail;
      if (recipientEmail && (search.notificationType === 'EMAIL' || search.notificationType === 'BOTH')) {
        try {
          const notification = await prisma.notification.create({
            data: { searchId: search.id, type: 'EMAIL', status: 'pending' },
          });

          const insertedMatches = await prisma.match.findMany({
            where: { searchId: search.id, url: { in: newProducts.map(p => p.url) } },
            select: { id: true },
          });

          if (insertedMatches.length > 0) {
            await prisma.notificationMatch.createMany({
              data: insertedMatches.map(m => ({ notificationId: notification.id, matchId: m.id })),
            });
          }

          await sendAlertEmail({
            to: recipientEmail,
            keyword: search.keyword,
            matches: newProducts.map(p => ({
              title: p.title,
              price: p.price ?? undefined,
              url: p.url,
              thumbnail: p.thumbnail ?? undefined,
            })),
            notificationId: notification.id,
            backendUrl: config.backendUrl,
          });

          await prisma.notification.update({ where: { id: notification.id }, data: { status: 'sent' } });
          notificationsSent++;
        } catch (err) {
          console.error(`[KeywordMatcher] Failed to send notification for search ${search.id}:`, err);
        }
      }
    }
  }

  if (matchesCreated > 0) {
    pushEvent({
      type: 'info',
      message: `Keyword matcher: ${matchesCreated} new matches from ${products.length} products, ${notificationsSent} notifications sent`,
    });
  }

  return { matchesCreated, notificationsSent };
}

// ── Category Filter Words ────────────────────────────────────────────────────

/**
 * Words that indicate a category filter, not a search term.
 * When a keyword like "7.62x39 ammo" is parsed, "ammo" is a category hint —
 * the user wants products matching "7.62x39" that are in the ammunition category.
 *
 * Maps the filter word to the tags/productType values it should match.
 */
const CATEGORY_FILTERS: Record<string, { tags: string[]; productTypes: string[] }> = {
  ammo:        { tags: ['ammunition'], productTypes: ['ammunition'] },
  ammunition:  { tags: ['ammunition'], productTypes: ['ammunition'] },
  rifle:       { tags: ['firearms'], productTypes: ['firearm'] },
  rifles:      { tags: ['firearms'], productTypes: ['firearm'] },
  gun:         { tags: ['firearms'], productTypes: ['firearm'] },
  guns:        { tags: ['firearms'], productTypes: ['firearm'] },
  firearm:     { tags: ['firearms'], productTypes: ['firearm'] },
  firearms:    { tags: ['firearms'], productTypes: ['firearm'] },
  mag:         { tags: ['magazines'], productTypes: ['parts'] },
  mags:        { tags: ['magazines'], productTypes: ['parts'] },
  magazine:    { tags: ['magazines'], productTypes: ['parts'] },
  magazines:   { tags: ['magazines'], productTypes: ['parts'] },
  optic:       { tags: ['optics'], productTypes: ['optics'] },
  optics:      { tags: ['optics'], productTypes: ['optics'] },
  scope:       { tags: ['optics'], productTypes: ['optics'] },
  scopes:      { tags: ['optics'], productTypes: ['optics'] },
};

/**
 * Parse a keyword into a search term + optional category filter.
 *
 * "7.62x39 ammo"  → { searchTerm: "7.62x39", categoryFilter: ammunition }
 * "sks"           → { searchTerm: "sks", categoryFilter: null }
 * "rifle ammo"    → { searchTerm: "rifle", categoryFilter: ammunition }
 *                    (both are category words, last one = filter, first = sub-qualifier)
 * "shotgun ammo"  → { searchTerm: "shotgun", categoryFilter: ammunition }
 * "sks magazine"  → { searchTerm: "sks", categoryFilter: magazines }
 */
function parseKeywordWithCategory(keyword: string): {
  searchTerm: string;
  categoryFilter: { tags: string[]; productTypes: string[] } | null;
} {
  const words = keyword.toLowerCase().trim().split(/\s+/);
  if (words.length < 2) return { searchTerm: keyword, categoryFilter: null };

  // Check if the last word is a category filter
  const lastWord = words[words.length - 1];
  const filter = CATEGORY_FILTERS[lastWord];
  if (!filter) return { searchTerm: keyword, categoryFilter: null };

  // The remaining words form the actual search term
  const searchWords = words.slice(0, -1);
  const searchTerm = searchWords.join(' ');

  // Only split if the search term is meaningful
  if (searchTerm.length < 2) return { searchTerm: keyword, categoryFilter: null };

  return { searchTerm, categoryFilter: filter };
}

// ── Instant Search (for new Search creation) ────────────────────────────────

/**
 * Query ProductIndex for existing products matching a keyword.
 * Called when a user creates a new Search for instant results.
 *
 * Supports category-qualified keywords: "7.62x39 ammo" searches for "7.62x39"
 * but only returns products tagged as ammunition.
 */
export async function searchProductIndex(
  keyword: string,
  siteIds?: string[],
  options?: { inStockOnly?: boolean },
): Promise<Array<{ url: string; title: string; price: number | null; regularPrice: number | null; thumbnail: string | null; siteId: string; firstSeenAt: Date; stockStatus: string | null }>> {
  // Parse keyword for category filter: "7.62x39 ammo" → search "7.62x39", filter to ammunition
  const { searchTerm, categoryFilter } = parseKeywordWithCategory(keyword);
  const aliases = await expandKeyword(searchTerm);

  // Build OR conditions for all aliases — search title, tags, and URL
  // (word boundary matching in SQL is expensive, so we do a broad ILIKE filter then refine in JS)
  // Also include space/hyphen-stripped variants so "tm 22" matches "TM22", "ar-15" matches "AR15"
  const aliasVariants = [...new Set(aliases.flatMap(alias => {
    const stripped = alias.replace(/[\s\-]+/g, '');
    return stripped !== alias ? [alias, stripped] : [alias];
  }))];
  const products = await prisma.productIndex.findMany({
    where: {
      isActive: true,
      ...(siteIds && siteIds.length > 0 ? { siteId: { in: siteIds } } : {}),
      ...(options?.inStockOnly ? { stockStatus: { not: 'out_of_stock' } } : {}),
      OR: aliasVariants.flatMap(alias => [
        { title: { contains: alias, mode: 'insensitive' as const } },
        { tags: { contains: alias, mode: 'insensitive' as const } },
        { url: { contains: alias, mode: 'insensitive' as const } },
      ]),
    },
    orderBy: { firstSeenAt: 'desc' },
    take: 200,
  });

  // Refine with word-boundary matching on title, tags, or URL slug
  // Use aliasVariants (includes space-stripped forms) for matching
  return products
    .filter(p => {
      const urlSlug = p.url.split('/').pop()?.replace(/-/g, ' ') || '';
      if (!aliasVariants.some(alias => matchesWithExtras(p.title, alias, { tags: p.tags, urlSlug }))) {
        return false;
      }
      // Apply category filter if present
      if (categoryFilter) {
        const matchesTags = p.tags && categoryFilter.tags.some(t => p.tags!.toLowerCase().includes(t));
        const matchesType = p.productType && categoryFilter.productTypes.includes(p.productType);
        if (!matchesTags && !matchesType) return false;
      }
      return true;
    })
    .map(p => ({
      url: p.url,
      title: p.title,
      price: p.price,
      regularPrice: p.regularPrice ?? null,
      thumbnail: p.thumbnail,
      siteId: p.siteId,
      firstSeenAt: p.firstSeenAt,
      stockStatus: p.stockStatus,
    }));
}
