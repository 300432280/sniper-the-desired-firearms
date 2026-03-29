/**
 * Create profiles for the remaining 32 sites that use default adapter behavior.
 * These sites don't have hardcoded domain checks but should still have profiles
 * documenting their platform, data flow, and structure.
 */
require('dotenv').config();
var { PrismaClient } = require('@prisma/client');
var p = new PrismaClient();

async function main() {
  // Get all sites WITHOUT profiles
  var Prisma = require('@prisma/client').Prisma;
  var sites = await p.monitoredSite.findMany({
    where: { isEnabled: true, siteProfile: { equals: Prisma.DbNull } },
    select: { id: true, domain: true, name: true, adapterType: true, hasWaf: true, siteCategory: true },
  });

  console.log(sites.length + ' sites without profiles\n');

  for (var site of sites) {
    var profile = {
      domain: site.domain,
      name: site.name,
      platform: site.adapterType,
      adapter: site.adapterType,
      lastVerified: '2026-03-29',
    };

    // Add platform-specific data flow
    if (site.adapterType === 'shopify') {
      profile.dataFlow = { steps: [{ api: '/products.json', provides: ['title', 'url', 'price', 'stock', 'thumbnail', 'sourceId', 'tags'], notes: 'All data in one API' }] };
      profile.sortParam = '?sort_by=created-descending';
    } else if (site.adapterType === 'woocommerce') {
      profile.dataFlow = { steps: [
        { api: 'WP REST API /wp-json/wp/v2/product', provides: ['title', 'url', 'thumbnail', 'categories', 'sourceId'], notes: 'NO price or stock' },
        { api: 'WC Store API /wp-json/wc/store/v1/products', provides: ['price', 'regularPrice', 'stockStatus'], notes: 'Enrichment step' }
      ] };
      profile.sortParam = '?orderby=date';
      if (site.hasWaf) {
        profile.wafType = 'sucuri';
        profile.timeout = 30000;
      }
    } else if (site.adapterType === 'classifieds-gunpost') {
      // Already has profile
    } else if (site.adapterType === 'forum-xenforo') {
      // Already has profile
    } else {
      // generic-retail or generic
      profile.dataFlow = { steps: [{ api: 'HTML scraping', provides: ['title', 'url', 'price', 'thumbnail'], notes: 'Extracted from listing page HTML' }] };
    }

    if (site.hasWaf && !profile.wafType) {
      profile.wafType = 'unknown';
      profile.needsPlaywright = true;
    }

    profile.notes = site.adapterType + ' site. Uses default adapter behavior (no custom URLs).';

    await p.monitoredSite.update({
      where: { id: site.id },
      data: { siteProfile: profile },
    });
    console.log('SET ' + site.domain + ' (' + site.adapterType + ')');
  }

  // Verify all sites now have profiles
  var total = await p.monitoredSite.count({ where: { isEnabled: true } });
  var withProfile = await p.monitoredSite.count({ where: { isEnabled: true, NOT: { siteProfile: { equals: Prisma.DbNull } } } });
  console.log('\n' + withProfile + '/' + total + ' sites have profiles');

  await p['$disconnect']();
}
main().catch(function(e) { console.error(e); process.exit(1); });
