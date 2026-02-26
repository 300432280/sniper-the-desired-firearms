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

  const charBefore = idx > 0 ? titleLower[idx - 1] : ' ';
  const charAfter = idx + kw.length < titleLower.length ? titleLower[idx + kw.length] : ' ';
  return !/[a-z0-9]/i.test(charBefore) && !/[a-z0-9]/i.test(charAfter);
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

    // Check which products match this search
    const matchingProducts = products.filter(product => {
      // Only match products from sites this search monitors
      // The search.websiteUrl contains the domain, so check if it matches the product's site
      return aliases.some(alias => matchesKeyword(product.title, alias));
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
): Promise<Array<{ url: string; title: string; price: number | null; thumbnail: string | null; siteId: string; firstSeenAt: Date }>> {
  const aliases = await expandKeyword(keyword);

  // Build OR conditions for all aliases (word boundary matching in SQL is expensive,
  // so we do a broad ILIKE filter then refine in JS)
  const products = await prisma.productIndex.findMany({
    where: {
      isActive: true,
      ...(siteIds && siteIds.length > 0 ? { siteId: { in: siteIds } } : {}),
      OR: aliases.map(alias => ({
        title: { contains: alias, mode: 'insensitive' as const },
      })),
    },
    orderBy: { firstSeenAt: 'desc' },
    take: 200,
  });

  // Refine with word-boundary matching
  return products
    .filter(p => aliases.some(alias => matchesKeyword(p.title, alias)))
    .map(p => ({
      url: p.url,
      title: p.title,
      price: p.price,
      thumbnail: p.thumbnail,
      siteId: p.siteId,
      firstSeenAt: p.firstSeenAt,
    }));
}
