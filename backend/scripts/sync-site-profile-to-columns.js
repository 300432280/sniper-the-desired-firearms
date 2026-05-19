// Sync MonitoredSite duplicated columns FROM siteProfile JSON.
// siteProfile is source of truth. Columns are derived.
// Never writes to siteProfile; only writes columns when they differ.
//
// Usage:
//   node -r dotenv/config backend/scripts/sync-site-profile-to-columns.js          # dry-run
//   node -r dotenv/config backend/scripts/sync-site-profile-to-columns.js --apply  # commit

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const COLUMN_FIELDS = ['hasWaf', 'hasCaptcha', 'adapterType'];

async function main() {
  const sites = await prisma.monitoredSite.findMany({
    select: { id: true, domain: true, hasWaf: true, hasCaptcha: true, adapterType: true, siteProfile: true },
  });

  let diffCount = 0;
  let writeCount = 0;
  const skipped = [];

  for (const s of sites) {
    const sp = s.siteProfile || {};
    const patch = {};
    const diffs = [];

    for (const field of COLUMN_FIELDS) {
      if (sp[field] === undefined || sp[field] === null) continue;
      if (s[field] !== sp[field]) {
        patch[field] = sp[field];
        diffs.push(`${field}: ${JSON.stringify(s[field])} -> ${JSON.stringify(sp[field])}`);
      }
    }

    if (diffs.length === 0) continue;
    diffCount++;
    console.log(`${s.domain}: ${diffs.join(', ')}`);

    if (APPLY) {
      try {
        await prisma.monitoredSite.update({ where: { id: s.id }, data: patch });
        writeCount++;
      } catch (e) {
        skipped.push(`${s.domain}: ${e.message}`);
      }
    }
  }

  console.log('');
  console.log(`Sites with drift: ${diffCount}`);
  if (APPLY) {
    console.log(`Columns synced: ${writeCount}`);
    if (skipped.length) {
      console.log(`Skipped (errors): ${skipped.length}`);
      skipped.forEach(m => console.log('  ' + m));
    }
  } else {
    console.log(`(dry-run; pass --apply to commit)`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
