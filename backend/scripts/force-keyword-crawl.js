/**
 * Force an immediate keyword crawl for a specific search.
 * Usage: node scripts/force-keyword-crawl.js <keyword> <site-name>
 *
 * This simulates what the scheduled keyword crawl does:
 * 1. Fetches the search page with Playwright
 * 2. Extracts matches using the adapter
 * 3. Saves to Match table + ProductIndex
 */
const { PrismaClient } = require('@prisma/client');
const { fetchWithPlaywrightPaginated } = require('../dist/services/scraper/playwright-fetcher');
const { GenericRetailAdapter } = require('../dist/services/scraper/adapters/generic-retail');
const cheerio = require('cheerio');

const keyword = process.argv[2] || 'henry';
const siteName = process.argv[3] || 'alflahertys';

const db = new PrismaClient();

(async () => {
  const site = await db.monitoredSite.findFirst({ where: { url: { contains: siteName } } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  const search = await db.search.findFirst({
    where: { keyword: { equals: keyword, mode: 'insensitive' }, websiteUrl: { contains: site.domain } },
  });
  if (!search) { console.log(`No search found for "${keyword}" on ${site.domain}`); process.exit(1); }
  console.log(`Search: id=${search.id} keyword="${search.keyword}" url=${search.websiteUrl}`);

  const adapter = new GenericRetailAdapter();
  const searchUrl = `https://${site.domain}/search.php?search_query=${encodeURIComponent(keyword)}`;
  console.log(`Fetching ${searchUrl} (paginated)...`);

  const result = await fetchWithPlaywrightPaginated(searchUrl, { timeout: 60000, maxPages: 5 });
  console.log(`Got ${result.pages.length} page(s)`);

  // Extract matches from all pages
  const matches = [];
  const seenUrls = new Set();
  for (let i = 0; i < result.pages.length; i++) {
    const $ = cheerio.load(result.pages[i]);
    console.log(`  Page ${i + 1}: ${result.pages[i].length} bytes`);
    const pageMatches = adapter.extractMatches($, keyword, searchUrl, { inStockOnly: false });
    let added = 0;
    for (const m of pageMatches) {
      if (m.url && !seenUrls.has(m.url)) {
        seenUrls.add(m.url);
        matches.push(m);
        added++;
      }
    }
    console.log(`  Page ${i + 1}: ${pageMatches.length} extracted, ${added} new (${pageMatches.length - added} dupes)`);
  }
  console.log(`Total unique matches: ${matches.length}`);

  // Save to ProductIndex
  let piNew = 0, piUpdated = 0;
  for (const m of matches) {
    if (!m.url) continue;
    const existing = await db.productIndex.findFirst({
      where: { siteId: site.id, url: m.url },
    });
    if (existing) {
      await db.productIndex.update({
        where: { id: existing.id },
        data: {
          title: m.title,
          price: m.price ?? existing.price,
          stockStatus: m.inStock === false ? 'out_of_stock' : m.inStock === true ? 'in_stock' : existing.stockStatus,
          thumbnail: m.thumbnail ?? existing.thumbnail,
          lastSeenAt: new Date(),
          isActive: true,
        },
      });
      piUpdated++;
    } else {
      await db.productIndex.create({
        data: {
          siteId: site.id,
          url: m.url,
          title: m.title,
          price: m.price ?? null,
          stockStatus: m.inStock === false ? 'out_of_stock' : 'in_stock',
          thumbnail: m.thumbnail ?? null,
          lastSeenAt: new Date(),
          isActive: true,
        },
      });
      piNew++;
    }
  }
  console.log(`ProductIndex: ${piNew} new, ${piUpdated} updated`);

  // Save to Match table
  const existingMatchUrls = new Set(
    (await db.match.findMany({ where: { searchId: search.id }, select: { url: true } }))
      .map(m => m.url)
  );
  const newMatches = matches.filter(m => m.url && !existingMatchUrls.has(m.url));
  if (newMatches.length > 0) {
    await db.match.createMany({
      data: newMatches.map(m => ({
        searchId: search.id,
        title: m.title,
        price: m.price ?? null,
        url: m.url,
        hash: 'force-crawl',
        thumbnail: m.thumbnail ?? null,
      })),
      skipDuplicates: true,
    });
  }
  // Also update existing matches that have null thumbnails
  for (const m of matches) {
    if (m.url && m.thumbnail && existingMatchUrls.has(m.url)) {
      await db.match.updateMany({
        where: { searchId: search.id, url: m.url, thumbnail: null },
        data: { thumbnail: m.thumbnail },
      });
    }
  }

  const totalMatches = await db.match.count({ where: { searchId: search.id } });
  console.log(`Match table: ${newMatches.length} new (${totalMatches} total for this search)`);
  console.log(`Thumbnails: ${matches.filter(m => m.thumbnail).length}/${matches.length} have thumbnails`);

  await db.$disconnect();
  process.exit(0);
})();
