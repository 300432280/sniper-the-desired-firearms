const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const SITE_ID = 'cmltxz6fp000289xar53h1vkf';

(async () => {
  const all = await p.productIndex.findMany({
    where: { siteId: SITE_ID, isActive: true },
    select: { title: true, url: true, price: true, stockStatus: true }
  });

  // Junk entries
  const junk = all.filter(a =>
    a.url.includes('search.php') ||
    a.url === 'https://www.alflahertys.com/' ||
    a.url === 'https://www.alflahertys.com' ||
    a.url.includes('giftcertificates')
  );
  console.log('=== JUNK ENTRIES ===');
  console.log('Count:', junk.length);
  junk.forEach(j => console.log(' -', j.title.slice(0, 60), '|', j.url));

  // Dirty titles
  const dirty = all.filter(a =>
    /\$\s?\d/.test(a.title) ||
    /Add to Cart/i.test(a.title) ||
    /Choose options/i.test(a.title) ||
    /Out-of-Stock/i.test(a.title) ||
    /Quick view/i.test(a.title) ||
    /Temporarily/i.test(a.title)
  );
  console.log('\n=== DIRTY TITLES (contain UI text) ===');
  console.log('Count:', dirty.length);
  dirty.forEach(d => console.log(' -', d.title.slice(0, 100)));

  // Category-looking pages (no product-specific slug)
  const categories = all.filter(a => {
    const path = new URL(a.url).pathname;
    const segments = path.split('/').filter(Boolean);
    // Category pages tend to have very short/generic slugs
    return segments.length === 1 && !a.price && !a.url.includes('.php');
  });

  // SKS matches
  const sksMatches = all.filter(a => a.title.toLowerCase().includes('sks'));
  console.log('\n=== SKS MATCHES IN TITLE ===');
  console.log('Count:', sksMatches.length);
  sksMatches.forEach(s => console.log(' -', s.title.slice(0, 100), '|', s.price, '|', s.stockStatus));

  // All products grouped by whether they look like categories vs real items
  const withPrice = all.filter(a => a.price !== null);
  const withoutPrice = all.filter(a => a.price === null);
  console.log('\n=== PRODUCT QUALITY SUMMARY ===');
  console.log('Total active:', all.length);
  console.log('With price:', withPrice.length);
  console.log('Without price (likely categories/junk):', withoutPrice.length);

  console.log('\n=== ALL PRODUCTS WITHOUT PRICE ===');
  withoutPrice.forEach(wp => console.log(' -', wp.title.slice(0, 80), '|', wp.url));

  await p.$disconnect();
})();
