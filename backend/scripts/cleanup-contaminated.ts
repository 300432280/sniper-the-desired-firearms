import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();

  // Find all matches with their search's websiteUrl
  const allMatches = await p.match.findMany({
    select: {
      id: true,
      url: true,
      search: { select: { websiteUrl: true } },
    },
  });

  console.log(`Total matches in database: ${allMatches.length}`);

  // Find matches where URL domain doesn't match search's site domain
  const contaminated: string[] = [];

  for (const m of allMatches) {
    let searchDomain: string;
    let matchDomain: string;
    try {
      searchDomain = new URL(m.search.websiteUrl).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    try {
      matchDomain = new URL(m.url).hostname.replace(/^www\./, '');
    } catch {
      contaminated.push(m.id); // Invalid URL = contaminated
      continue;
    }

    if (searchDomain !== matchDomain) {
      contaminated.push(m.id);
    }
  }

  console.log(`Contaminated matches (URL domain != search site domain): ${contaminated.length}`);

  if (contaminated.length === 0) {
    console.log('No contamination found.');
    await p.$disconnect();
    return;
  }

  // Also delete any NotificationMatch records pointing to contaminated matches
  const notifDeleted = await p.notificationMatch.deleteMany({
    where: { matchId: { in: contaminated } },
  });
  console.log(`Deleted ${notifDeleted.count} notification-match links`);

  // Delete contaminated matches in batches
  const batchSize = 500;
  let totalDeleted = 0;
  for (let i = 0; i < contaminated.length; i += batchSize) {
    const batch = contaminated.slice(i, i + batchSize);
    const result = await p.match.deleteMany({
      where: { id: { in: batch } },
    });
    totalDeleted += result.count;
    console.log(`Deleted batch ${Math.floor(i / batchSize) + 1}: ${result.count} matches`);
  }

  console.log(`\nTotal deleted: ${totalDeleted} contaminated matches`);
  console.log(`Remaining matches: ${allMatches.length - totalDeleted}`);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
