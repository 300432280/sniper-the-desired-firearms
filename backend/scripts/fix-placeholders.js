/**
 * One-time fix: clear Klevu placeholder thumbnails from ProductIndex.
 * These are useless "place-holder.jpg" URLs from Klevu search overlay.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const placeholders = await p.productIndex.findMany({
    where: { thumbnail: { contains: 'place-holder' } },
    select: { id: true, title: true, thumbnail: true, siteId: true }
  });
  console.log('Found', placeholders.length, 'products with Klevu placeholder thumbnails');

  if (placeholders.length > 0) {
    const result = await p.productIndex.updateMany({
      where: { thumbnail: { contains: 'place-holder' } },
      data: { thumbnail: null }
    });
    console.log('Cleared', result.count, 'placeholder thumbnails');
  }

  // Also clear any klevu.com thumbnails
  const klevu = await p.productIndex.findMany({
    where: { thumbnail: { contains: 'klevu.com' } },
    select: { id: true }
  });
  if (klevu.length > 0) {
    const result = await p.productIndex.updateMany({
      where: { thumbnail: { contains: 'klevu.com' } },
      data: { thumbnail: null }
    });
    console.log('Cleared', result.count, 'klevu.com thumbnails');
  }

  await p.$disconnect();
})();
