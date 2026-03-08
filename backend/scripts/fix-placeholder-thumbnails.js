/**
 * One-time fix: clean up Klevu placeholder thumbnails stored in Match and ProductIndex tables.
 */
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  // Fix Match records with Klevu placeholder thumbnails
  const matchResult = await db.match.updateMany({
    where: { thumbnail: { contains: 'klevu.com' } },
    data: { thumbnail: null },
  });
  console.log(`Cleaned ${matchResult.count} Match records with Klevu placeholder thumbnails`);

  // Also clean any other placeholder URLs
  const matchResult2 = await db.match.updateMany({
    where: { thumbnail: { contains: 'place-holder' } },
    data: { thumbnail: null },
  });
  console.log(`Cleaned ${matchResult2.count} Match records with place-holder thumbnails`);

  // Fix ProductIndex records too
  const piResult = await db.productIndex.updateMany({
    where: { thumbnail: { contains: 'klevu.com' } },
    data: { thumbnail: null },
  });
  console.log(`Cleaned ${piResult.count} ProductIndex records with Klevu placeholder thumbnails`);

  const piResult2 = await db.productIndex.updateMany({
    where: { thumbnail: { contains: 'place-holder' } },
    data: { thumbnail: null },
  });
  console.log(`Cleaned ${piResult2.count} ProductIndex records with place-holder thumbnails`);

  await db.$disconnect();
})();
