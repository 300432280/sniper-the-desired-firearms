// Strip the `/en/` locale prefix from dantesports.com's siteProfile API URLs.
// Runtime uses `${origin}/wp-json/...` per WHATWG `new URL().origin` (no pathname),
// so the prefix is decoration only. Stripping cleans the profile and prevents
// future auditors from being misled. The `notes` field is left untouched — it
// is prose documenting the WPML setup, not a runtime URL.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  const site = await prisma.monitoredSite.findFirst({
    where: { domain: 'dantesports.com' },
    select: { id: true, domain: true, siteProfile: true },
  });
  if (!site) {
    console.error('dantesports.com NOT FOUND in DB');
    process.exit(1);
  }

  const profile = JSON.parse(JSON.stringify(site.siteProfile || {}));
  const diffs = [];

  if (profile.crawlers?.catalog?.apiEndpoint?.startsWith('/en/')) {
    const before = profile.crawlers.catalog.apiEndpoint;
    profile.crawlers.catalog.apiEndpoint = before.replace(/^\/en\//, '/');
    diffs.push(`crawlers.catalog.apiEndpoint: ${JSON.stringify(before)} -> ${JSON.stringify(profile.crawlers.catalog.apiEndpoint)}`);
  }

  if (profile.crawlers?.watermark?.apiEndpoint?.startsWith('/en/')) {
    const before = profile.crawlers.watermark.apiEndpoint;
    profile.crawlers.watermark.apiEndpoint = before.replace(/^\/en\//, '/');
    diffs.push(`crawlers.watermark.apiEndpoint: ${JSON.stringify(before)} -> ${JSON.stringify(profile.crawlers.watermark.apiEndpoint)}`);
  }

  if (profile.multilingual?.apiPrefix?.startsWith('/en/')) {
    const before = profile.multilingual.apiPrefix;
    profile.multilingual.apiPrefix = before.replace(/^\/en\//, '/');
    diffs.push(`multilingual.apiPrefix: ${JSON.stringify(before)} -> ${JSON.stringify(profile.multilingual.apiPrefix)}`);
  }

  console.log(`=== dantesports.com ===`);
  if (diffs.length === 0) {
    console.log('  (no /en/ prefix strings to strip — already clean)');
  } else {
    diffs.forEach(d => console.log(`  ${d}`));
    console.log(`  notes field: LEFT UNTOUCHED (prose documentation of WPML setup, not a runtime URL)`);
  }

  if (APPLY && diffs.length > 0) {
    try {
      await prisma.monitoredSite.update({ where: { id: site.id }, data: { siteProfile: profile } });
      console.log(`  WROTE (${diffs.length} fields)`);
    } catch (e) {
      console.log(`  WRITE FAILED: ${e.message}`);
      process.exit(1);
    }
  }

  console.log('');
  console.log(APPLY ? 'Done.' : `(dry-run; ${diffs.length} change${diffs.length === 1 ? '' : 's'} pending. pass --apply to commit)`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
