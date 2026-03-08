/**
 * Backfill productType for all existing ProductIndex rows where it's null.
 * Uses the canonical classifier from product-classifier.ts.
 *
 * Usage: cd backend && npx tsx scripts/backfill-product-types.ts [--dry-run]
 */

import { PrismaClient } from '@prisma/client';
import { classifyProduct } from '../src/services/product-classifier';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const total = await prisma.productIndex.count({ where: { productType: null } });
  console.log(`Products with null productType: ${total}`);
  if (total === 0) { console.log('Nothing to backfill.'); return; }

  const BATCH = 500;
  let cursor: string | undefined = undefined;
  let classified = 0;
  const stats: Record<string, number> = { firearm: 0, ammunition: 0, optics: 0, parts: 0, gear: 0, knives: 0, other: 0 };

  while (true) {
    const products = await prisma.productIndex.findMany({
      where: { productType: null },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, title: true, url: true, tags: true },
    });

    if (products.length === 0) break;

    for (const p of products) {
      const productType = classifyProduct({
        title: p.title,
        url: p.url,
        tags: p.tags,
        sourceCategory: null,
      });

      stats[productType] = (stats[productType] || 0) + 1;

      if (!DRY_RUN) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await prisma.productIndex.update({
              where: { id: p.id },
              data: { productType },
            });
            break;
          } catch (err: any) {
            if (attempt < 2 && (err.code === 'P1001' || err.code === 'P1017' || err.message?.includes("Can't reach"))) {
              console.log(`  DB connection lost, retrying in ${(attempt + 1) * 5}s...`);
              await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
              await prisma.$connect();
            } else {
              throw err;
            }
          }
        }
      }
      classified++;
    }

    cursor = products[products.length - 1].id;
    if (classified % 2000 === 0 || products.length < BATCH) {
      console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Classified ${classified}/${total}...`);
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done. Classified ${classified} products.`);
  console.log('Distribution:', JSON.stringify(stats, null, 2));
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
