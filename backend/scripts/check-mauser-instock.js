const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

(async () => {
  // 1. Check the missed product
  const missedUrl = 'https://alsimmonsgunshop.com/product/savage-110gc-111gc-114-25-05rem-270win-30-06sprg-7x57mauser-high-luster-magazine-105862/';
  const pi = await p.productIndex.findFirst({ where: { url: missedUrl } });
  console.log('Missed product in index:', pi ? `YES (stock: ${pi.stockStatus}, thumb: ${pi.thumbnail ? 'yes' : 'no'})` : 'NO');

  // Also check without trailing slash
  if (!pi) {
    const pi2 = await p.productIndex.findFirst({ where: { url: missedUrl.replace(/\/$/, '') } });
    console.log('Without trailing slash:', pi2 ? 'YES' : 'NO');
  }

  // 2. Check all mauser matches and their stock
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  const search = await p.search.findFirst({ where: { keyword: { contains: 'mauser', mode: 'insensitive' } } });

  console.log('\n=== Current mauser matches with in_stock ===');
  const matches = await p.match.findMany({ where: { searchId: search.id }, orderBy: { foundAt: 'desc' } });
  for (const m of matches) {
    const prod = await p.productIndex.findFirst({ where: { url: m.url }, select: { stockStatus: true, thumbnail: true } });
    if (prod?.stockStatus === 'in_stock') {
      console.log(`  IN STOCK: ${m.title} | thumb: ${prod.thumbnail ? 'yes' : 'no'}`);
    }
  }

  // 3. Check if this product URL exists in ProductIndex at all (partial match)
  const partialMatches = await p.productIndex.findMany({
    where: { siteId: site.id, url: { contains: 'mauser' } },
    select: { url: true, stockStatus: true, thumbnail: true, title: true },
  });
  console.log(`\n=== ProductIndex entries with "mauser" in URL: ${partialMatches.length} ===`);
  for (const pm of partialMatches) {
    console.log(`  ${pm.stockStatus?.padEnd(13) || 'null         '} thumb:${pm.thumbnail ? 'Y' : 'N'} ${pm.title.slice(0, 60)}`);
  }

  // 4. Which match has no thumbnail?
  console.log('\n=== Mauser matches missing thumbnails ===');
  for (const m of matches) {
    const prod = await p.productIndex.findFirst({ where: { url: m.url }, select: { thumbnail: true, title: true } });
    if (!prod?.thumbnail) {
      console.log(`  ${m.title} | url: ${m.url}`);
    }
  }

  await p.$disconnect();
})();
