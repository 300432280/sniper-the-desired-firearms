/**
 * Daily Digest — aggregates new matches for FREE-tier users into a single email.
 *
 * Runs daily at 6 AM UTC (alongside health checks).
 * PRO users get instant notifications; FREE users get this digest instead.
 */

import { prisma } from '../lib/prisma';
import { sendAlertEmail } from './email';
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
        },
      });

      if (searches.length === 0) {
        skipped++;
        continue;
      }

      const searchIds = searches.map(s => s.id);

      const newMatches = await prisma.match.findMany({
        where: {
          searchId: { in: searchIds },
          foundAt: { gt: since },
        },
        include: {
          search: { select: { keyword: true, websiteUrl: true } },
        },
        orderBy: { foundAt: 'desc' },
        take: 50, // Cap digest size
      });

      if (newMatches.length === 0) {
        skipped++;
        continue;
      }

      // Group matches by keyword for the digest
      const byKeyword = new Map<string, typeof newMatches>();
      for (const match of newMatches) {
        const key = match.search.keyword;
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

      // Link all new matches to this notification
      const matchIds = newMatches.map(m => m.id);
      if (matchIds.length > 0) {
        await prisma.notificationMatch.createMany({
          data: matchIds.map(matchId => ({
            notificationId: notification.id,
            matchId,
          })),
          skipDuplicates: true,
        });
      }

      // Build the digest email — reuse the alert email format with a summary
      const digestMatches = newMatches.slice(0, 10).map(m => ({
        title: `[${m.search.keyword}] ${m.title}`,
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
        await prisma.notification.update({
          where: { id: notification.id },
          data: { status: 'sent' },
        });
        sent++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        console.error(`[DailyDigest] Email failed for ${user.email}: ${msg}`);
        await prisma.notification.update({
          where: { id: notification.id },
          data: { status: 'failed' },
        });
      }

      // Update last digest timestamp
      await prisma.user.update({
        where: { id: user.id },
        data: { lastDailyDigestAt: new Date() },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      console.error(`[DailyDigest] Failed for user ${user.id}: ${msg}`);
      skipped++;
    }
  }

  pushEvent({
    type: 'info',
    message: `Daily digest: ${sent} sent, ${skipped} skipped (${freeUsers.length} free users)`,
  });

  return { sent, skipped };
}
