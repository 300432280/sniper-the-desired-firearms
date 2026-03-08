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
 */
export function matchesKeyword(title: string, keyword: string): boolean {
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
  products: Array<{ id: string; siteId: string; url: string; title: string; price?: number | null; thumbnail?: string | null }>,
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

    // Get aliases for this keyword
    if (!keywordAliasCache.has(keyword)) {
      keywordAliasCache.set(keyword, await expandKeyword(keyword));
    }
    const aliases = keywordAliasCache.get(keyword)!;

    // Extract the domain from the search's websiteUrl for site filtering
    let searchDomain: string;
    try {
      searchDomain = new URL(search.websiteUrl).hostname.replace(/^www\./, '');
    } catch {
      continue; // Skip searches with invalid URLs
    }

    // Check title and URL slug (hyphens → spaces) so keywords in caliber
    // designations like "7x57mauser" in a URL match "mauser" via word boundary.
    const matchingProducts = products.filter(product => {
      const productDomain = siteIdToDomain.get(product.siteId);
      if (!productDomain) return false;
      if (productDomain.replace(/^www\./, '') !== searchDomain) return false;
      const urlSlug = product.url.split('/').pop()?.replace(/-/g, ' ') || '';
      return aliases.some(alias =>
        matchesKeyword(product.title, alias) || matchesKeyword(urlSlug, alias),
      );
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

// ── Instant Search (for new Search creation) ────────────────────────────────

/**
 * Query ProductIndex for existing products matching a keyword.
 * Called when a user creates a new Search for instant results.
 */
export async function searchProductIndex(
  keyword: string,
  siteIds?: string[],
  options?: { inStockOnly?: boolean },
): Promise<Array<{ url: string; title: string; price: number | null; regularPrice: number | null; thumbnail: string | null; siteId: string; firstSeenAt: Date; stockStatus: string | null }>> {
  const aliases = await expandKeyword(keyword);

  // Build OR conditions for all aliases — search both title and tags
  // (word boundary matching in SQL is expensive, so we do a broad ILIKE filter then refine in JS)
  const products = await prisma.productIndex.findMany({
    where: {
      isActive: true,
      ...(siteIds && siteIds.length > 0 ? { siteId: { in: siteIds } } : {}),
      ...(options?.inStockOnly ? { stockStatus: { not: 'out_of_stock' } } : {}),
      OR: aliases.flatMap(alias => [
        { title: { contains: alias, mode: 'insensitive' as const } },
        { tags: { contains: alias, mode: 'insensitive' as const } },
        { url: { contains: alias, mode: 'insensitive' as const } },
      ]),
    },
    orderBy: { firstSeenAt: 'desc' },
    take: 200,
  });

  // Refine with word-boundary matching on title, tags, or URL slug
  return products
    .filter(p => {
      const urlSlug = p.url.split('/').pop()?.replace(/-/g, ' ') || '';
      return aliases.some(alias =>
        matchesKeyword(p.title, alias) || (p.tags && matchesKeyword(p.tags, alias)) || matchesKeyword(urlSlug, alias)
      );
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
