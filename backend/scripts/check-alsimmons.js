const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  // Check sample products
  const prods = await p.productIndex.findMany({
    where: { siteId: site.id },
    orderBy: { firstSeenAt: 'desc' },
    take: 10,
    select: { title: true, price: true, url: true, stockStatus: true, thumbnail: true, firstSeenAt: true }
  });
  console.log('=== Latest 10 Products ===');
  prods.forEach(prod => console.log(
    prod.firstSeenAt.toISOString().slice(0, 10),
    (prod.stockStatus || 'unknown').padEnd(12),
    prod.price ? ('$' + prod.price).padEnd(10) : 'no price  ',
    prod.thumbnail ? 'HAS_THUMB' : 'NO_THUMB ',
    prod.title.slice(0, 60)
  ));

  // Data quality counts
  const total = await p.productIndex.count({ where: { siteId: site.id } });
  const noThumbCount = await p.productIndex.count({ where: { siteId: site.id, thumbnail: null } });
  const noPriceCount = await p.productIndex.count({ where: { siteId: site.id, price: null } });
  console.log('\n=== Data Quality ===');
  console.log('Missing thumbnails:', noThumbCount, '/', total);
  console.log('Missing prices:', noPriceCount, '/', total);

  // Stock status distribution
  const inStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'in_stock' } });
  const outStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'out_of_stock' } });
  const unknownStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: null } });
  console.log('In stock:', inStock);
  console.log('Out of stock:', outStock);
  console.log('Unknown stock:', unknownStock);

  // Search tests
  const sksProducts = await p.productIndex.findMany({
    where: { siteId: site.id, title: { contains: 'sks', mode: 'insensitive' } },
    select: { title: true, price: true, url: true, stockStatus: true }
  });
  console.log('\n=== Search Test: "sks" ===');
  console.log('Results:', sksProducts.length);
  sksProducts.forEach(prod => console.log(' ', prod.stockStatus, prod.price ? '$' + prod.price : '', prod.title));

  const remProducts = await p.productIndex.findMany({
    where: { siteId: site.id, title: { contains: 'remington', mode: 'insensitive' } },
    select: { title: true, price: true, stockStatus: true }
  });
  console.log('\n=== Search Test: "remington" ===');
  console.log('Results:', remProducts.length);
  remProducts.forEach(prod => console.log(' ', prod.stockStatus, prod.price ? '$' + prod.price : '', prod.title));

  // Products missing thumbnails — detail
  const noThumbList = await p.productIndex.findMany({
    where: { siteId: site.id, thumbnail: null },
    select: { title: true, url: true, price: true }
  });
  console.log('\n=== Missing Thumbnails (' + noThumbList.length + ') ===');
  noThumbList.forEach(prod => console.log('  ', prod.price ? '$' + prod.price : 'no price', prod.title.slice(0, 60)));

  // Products missing prices — detail
  const noPriceList = await p.productIndex.findMany({
    where: { siteId: site.id, price: null },
    select: { title: true, url: true }
  });
  console.log('\n=== Missing Prices (' + noPriceList.length + ') ===');
  noPriceList.forEach(prod => console.log('  ', prod.title.slice(0, 60)));

  // DB vs live count
  console.log('\n=== DB vs Live Count ===');
  console.log('DB products:', total);
  console.log('Live API reports x-wp-total: 168');
  console.log('Diff (stale products):', total - 168);

  await p.$disconnect();
})();
