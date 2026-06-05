/**
 * Daily Digest — aggregates new matches for FREE-tier users into a single email.
 *
 * Runs daily at 6 AM UTC (alongside health checks).
 * PRO users get instant notifications; FREE users get this digest instead.
 */

import { prisma } from '../lib/prisma';
import { sendAlertEmail } from './email';
import { searchProductIndex } from './keyword-matcher';
import { config } from '../config';
import { pushEvent } from './debugLog';

/**
 * Build and send daily digest emails for all FREE-tier users
 * who have new matches since their last digest.
 */
export async function sendDailyDigests(): Promise<{ sent: number; skipped: number }> {
  const freeUsers = await prisma.user.findMany({
    where: { tier: 'FREE' },
    select: {
      id: true,
      email: true,
      lastDailyDigestAt: true,
    },
  });

  let sent = 0;
  let skipped = 0;

  for (const user of freeUsers) {
    try {
      const since = user.lastDailyDigestAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Find all new matches across the user's active searches since last digest
      const searches = await prisma.search.findMany({
        where: {
          userId: user.id,
          isActive: true,
        },
        select: {
          id: true,
          keyword: true,
          websiteUrl: true,
          inStockOnly: true,
          maxPrice: true,
        },
      });

      if (searches.length === 0) {
        skipped++;
        continue;
      }

      const searchIds = searches.map(s => s.id);

      // Source new matches LIVE from ProductIndex (cursor = lastDailyDigestAt),
      // aggregated across the user's searches. Each entry carries its keyword.
      const newMatches: Array<{ keyword: string; title: string; price: number | null; url: string }> = [];
      // Track the newest change observed so we advance the cursor to maxObserved
      // (not now()) — avoids skipping changes that land between query and write.
      let maxObserved = since.getTime();
      for (const search of searches) {
        let searchDomain: string;
        try {
          searchDomain = new URL(search.websiteUrl).hostname.replace(/^www\./, '');
        } catch {
          continue;
        }
        // EXACT domain match (normalize www. on both sides); skip if unresolved —
        // never broadcast across all sites (searchProductIndex treats undefined
        // siteIds as "ALL sites").
        const candidateSites = await prisma.monitoredSite.findMany({
          where: { OR: [{ domain: searchDomain }, { domain: `www.${searchDomain}` }] },
          select: { id: true, domain: true },
        });
        const site = candidateSites.find(s => s.domain.replace(/^www\./, '') === searchDomain);
        if (!site) continue;

        const results = await searchProductIndex(search.keyword, [site.id], {
          inStockOnly: search.inStockOnly,
          maxPrice: search.maxPrice ?? undefined,
          changedSince: since,
        });
        for (const p of results) {
          newMatches.push({ keyword: search.keyword, title: p.title, price: p.price, url: p.url });
          const t = Math.max(p.contentChangedAt.getTime(), p.firstSeenAt.getTime());
          if (t > maxObserved) maxObserved = t;
        }
      }

      if (newMatches.length === 0) {
        skipped++;
        continue;
      }

      // Cap digest size after aggregation
      newMatches.length = Math.min(newMatches.length, 50);

      // Group matches by keyword for the digest summary
      const byKeyword = new Map<string, typeof newMatches>();
      for (const match of newMatches) {
        const key = match.keyword;
        if (!byKeyword.has(key)) byKeyword.set(key, []);
        byKeyword.get(key)!.push(match);
      }

      // Create a notification record for the digest
      // Use the first search as the anchor (digest covers all searches)
      const notification = await prisma.notification.create({
        data: {
          searchId: searchIds[0],
          type: 'EMAIL',
          status: 'pending',
        },
      });

      // Build the digest email — reuse the alert email format with a summary
      const digestMatches = newMatches.slice(0, 10).map(m => ({
        title: `[${m.keyword}] ${m.title}`,
        price: m.price,
        url: m.url,
      }));

      const keywordSummary = [...byKeyword.entries()]
        .map(([kw, matches]) => `"${kw}" (${matches.length})`)
        .join(', ');

      try {
        await sendAlertEmail({
          to: user.email,
          keyword: `Daily Digest — ${newMatches.length} new items`,
          matches: digestMatches,
          notificationId: notification.id,
          backendUrl: config.backendUrl,
        });
        // Mark sent AND advance the cursor atomically (to maxObserved, not now()).
        // Only on success — on failure the cursor is left so the next run retries.
        await prisma.$transaction([
          prisma.notification.update({ where: { id: notification.id }, data: { status: 'sent' } }),
          prisma.user.update({ where: { id: user.id }, data: { lastDailyDigestAt: new Date(maxObserved) } }),
        ]);
        sent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        console.error(`[DailyDigest] Email failed for ${user.email}: ${msg}`);
        await prisma.notification.update({
          where: { id: notification.id },
          data: { status: 'failed' },
        });
        // Do NOT advance lastDailyDigestAt — next run retries this window.
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error(`[DailyDigest] Failed for user ${user.id}: ${msg}`);
      // TODO(observability): pushEvent on a whole-digest-run failure (not just
      // per-user console.error) so run-level failures surface in the debug log.
      skipped++;
    }
  }

  pushEvent({
    type: 'info',
    message: `Daily digest: ${sent} sent, ${skipped} skipped (${freeUsers.length} free users)`,
  });

  return { sent, skipped };
}
