const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const events = await p.crawlEvent.findMany({
    where: { siteId: 'cmltxz6fp000289xar53h1vkf' },
    orderBy: { crawledAt: 'desc' },
    take: 15,
    select: { status: true, crawledAt: true, matchesFound: true, errorMessage: true }
  });
  console.log('=== RECENT CRAWL EVENTS (alflahertys) ===');
  events.forEach(e => {
    const date = e.crawledAt.toISOString().slice(0, 16);
    const err = e.errorMessage ? ' | err: ' + e.errorMessage.slice(0, 80) : '';
    console.log(`${e.status} | ${date} | matches: ${e.matchesFound}${err}`);
  });
  await p.$disconnect();
})();
