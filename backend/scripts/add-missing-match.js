const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const search = await p.search.findFirst({
    where: { keyword: { contains: 'mauser', mode: 'insensitive' } },
  });
  if (!search) { console.log('Search not found'); process.exit(1); }

  const prodUrl = 'https://alsimmonsgunshop.com/product/savage-110gc-111gc-114-25-05rem-270win-30-06sprg-7x57mauser-high-luster-magazine-105862/';
  const pi = await p.productIndex.findFirst({ where: { url: prodUrl } });
  if (!pi) { console.log('Product not in index'); process.exit(1); }

  // Check if already matched
  const existing = await p.match.findFirst({ where: { searchId: search.id, url: prodUrl } });
  if (existing) { console.log('Already matched'); process.exit(0); }

  await p.match.create({
    data: {
      searchId: search.id,
      title: pi.title,
      price: pi.price,
      url: pi.url,
      hash: `pi:${pi.id}`,
      thumbnail: pi.thumbnail,
    },
  });
  console.log('Match added:', pi.title);
  await p.$disconnect();
})();
