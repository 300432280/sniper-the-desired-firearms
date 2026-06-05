/**
 * Backfill Search.alertCursor for the Phase 3 cursor-based alert dispatcher.
 *
 * Sets alertCursor = now() for every ACTIVE Search where alertCursor IS NULL.
 *
 * Why: existing ProductIndex rows had contentChangedAt backfilled to the
 * migration timestamp (2026-05-28T07:17:39Z). Without seeding the cursor, the
 * first LIVE dispatch (Phase 4) would treat the entire backfilled catalog as
 * "changed since cursor" and email users the whole catalog. Seeding cursor=now()
 * means the first dispatch only matches products that change AFTER this backfill.
 *
 * Safe to run multiple times — only touches rows where alertCursor IS NULL.
 *
 * Usage: cd backend && node scripts/backfill-alert-cursor.js [--dry-run]
 */
require('dotenv').config();
var PrismaClient = require('@prisma/client').PrismaClient;

var prisma = new PrismaClient();
var DRY_RUN = process.argv.indexOf('--dry-run') >= 0;

async function main() {
  console.log('=== Alert Cursor Backfill ===');
  if (DRY_RUN) console.log('*** DRY RUN — no database writes ***');

  var pending = await prisma.search.count({
    where: { isActive: true, alertCursor: null },
  });
  console.log('Active searches with alertCursor=NULL: ' + pending);

  if (pending === 0) {
    console.log('Nothing to backfill!');
    await prisma.$disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log('Would set alertCursor=now() on ' + pending + ' searches.');
    await prisma.$disconnect();
    return;
  }

  var now = new Date();
  var result = await prisma.search.updateMany({
    where: { isActive: true, alertCursor: null },
    data: { alertCursor: now },
  });

  console.log('Updated ' + result.count + ' searches (alertCursor=' + now.toISOString() + ')');
  await prisma.$disconnect();
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
