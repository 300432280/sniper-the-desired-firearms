/**
 * Seed script: Populate MonitoredSite table with Canadian firearms retailers,
 * forums, classifieds, and auction sites.
 *
 * Usage: npx ts-node src/scripts/seed-sites.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface SiteSeed {
  domain: string;
  name: string;
  url: string;
  siteType: string;
  adapterType: string;
  requiresSucuri?: boolean;
  requiresAuth?: boolean;
  searchUrlPattern?: string;
  notes?: string;
}

const SITES: SiteSeed[] = [
  // ── Shopify (confirmed) ────────────────────────────────────────────────
  { domain: 'fishingworldgc.ca', name: 'Fish World Guns', url: 'https://fishingworldgc.ca', siteType: 'retailer', adapterType: 'shopify' },
  { domain: 'jobrookoutdoors.com', name: 'Jo Brook Outdoors', url: 'https://www.jobrookoutdoors.com', siteType: 'retailer', adapterType: 'shopify' },

  // ── WooCommerce / WordPress ────────────────────────────────────────────
  { domain: 'leverarms.com', name: 'Lever Arms', url: 'https://www.leverarms.com', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'corwin-arms.com', name: 'Corwin Arms', url: 'https://www.corwin-arms.com', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'triggersandbows.com', name: 'Triggers and Bows', url: 'https://www.triggersandbows.com', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'marstar.ca', name: 'Marstar Canada', url: 'https://www.marstar.ca', siteType: 'retailer', adapterType: 'woocommerce' },
  // wanstallsonline.com — DISABLED: domain compromised (Indonesian gambling redirect)
  { domain: 'budgetshootersupply.ca', name: 'Budget Shooter Supply', url: 'https://www.budgetshootersupply.ca', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'g4cgunstore.com', name: 'G4C Gun Store', url: 'https://g4cgunstore.com', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'canadafirstammo.ca', name: 'Canada First Ammo', url: 'https://www.canadafirstammo.ca', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'rangeviewsports.ca', name: 'Rangeview Sports', url: 'https://www.rangeviewsports.ca', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'dlaskarms.com', name: 'Dlask Arms', url: 'https://www.dlaskarms.com', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'tacord.com', name: 'Tactical Ordnance', url: 'https://tacord.com', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'internationalshootingsupplies.com', name: 'International Shooting Supplies', url: 'https://internationalshootingsupplies.com', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'irunguns.ca', name: 'iRunGuns', url: 'https://www.irunguns.ca', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/product.php?product_name={keyword}', notes: 'Custom PHP, product_detail.php URLs' },
  { domain: 'canadasgunstore.ca', name: "Canada's Gun Store", url: 'https://www.canadasgunstore.ca', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'ctcsupplies.ca', name: 'CTC Supplies', url: 'https://www.ctcsupplies.ca', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'westernmetal.ca', name: 'Western Metal', url: 'https://www.westernmetal.ca/shooting/', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'precisionoptics.net', name: 'Precision Optics', url: 'https://www.precisionoptics.net', siteType: 'retailer', adapterType: 'woocommerce', notes: 'Behind Cloudflare WAF' },
  { domain: 'durhamoutdoors.ca', name: 'Durham Outdoors', url: 'https://www.durhamoutdoors.ca', siteType: 'retailer', adapterType: 'woocommerce' },
  { domain: 'northprosports.com', name: 'North Pro Sports', url: 'https://www.northprosports.com', siteType: 'retailer', adapterType: 'woocommerce' },

  // ── BigCommerce ────────────────────────────────────────────────────────
  { domain: 'alflahertys.com', name: "Al Flaherty's", url: 'https://www.alflahertys.com', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/search.php?search_query={keyword}', notes: 'BigCommerce, uses Klevu search' },
  { domain: 'theammosource.com', name: 'The Ammo Source', url: 'https://www.theammosource.com', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/search.php?search_query={keyword}', notes: 'BigCommerce' },
  { domain: 'store.prophetriver.com', name: 'Prophet River', url: 'https://store.prophetriver.com', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/search.php?search_query={keyword}', notes: 'BigCommerce' },
  { domain: 'frontierfirearms.ca', name: 'Frontier Firearms', url: 'https://www.frontierfirearms.ca', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/search.php?search_query={keyword}', notes: 'BigCommerce' },
  { domain: 'firearmsoutletcanada.com', name: 'Firearms Outlet Canada', url: 'https://www.firearmsoutletcanada.com', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/search.php?search_query={keyword}', notes: 'BigCommerce, uses Klevu search' },
  { domain: 'nordicmarksman.com', name: 'Nordic Marksman', url: 'https://www.nordicmarksman.com', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/search.php?search_query={keyword}', notes: 'BigCommerce' },
  { domain: 'wolverinesupplies.com', name: 'Wolverine Supplies', url: 'https://www.wolverinesupplies.com', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/search.php?search_query={keyword}', notes: 'BigCommerce' },
  { domain: 'store.theshootingcentre.com', name: 'Calgary Shooting Centre', url: 'https://store.theshootingcentre.com', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/search.php?search_query={keyword}', notes: 'BigCommerce' },

  // ── Magento ────────────────────────────────────────────────────────────
  { domain: 'ellwoodepps.com', name: 'Ellwood Epps', url: 'https://www.ellwoodepps.com', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/catalogsearch/result/?q={keyword}', notes: 'Magento' },
  { domain: 'rdsc.ca', name: 'RDSC', url: 'https://www.rdsc.ca', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/catalogsearch/result/?q={keyword}', notes: 'Magento' },
  { domain: 'truenortharms.com', name: 'True North Arms', url: 'https://www.truenortharms.com', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/catalogsearch/result/?q={keyword}', notes: 'Magento, uses Algolia search' },

  // ── nopCommerce / Other ────────────────────────────────────────────────
  { domain: 'reliablegun.com', name: 'Reliable Gun', url: 'https://www.reliablegun.com', siteType: 'retailer', adapterType: 'generic-retail', notes: 'nopCommerce' },
  { domain: 'surplusherbys.com', name: "Surplus Herby's", url: 'https://www.surplusherbys.com', siteType: 'retailer', adapterType: 'generic-retail', notes: 'Wix, uses FastSimon search' },
  { domain: 'gagnonsports.com', name: 'Gagnon Sports', url: 'https://www.gagnonsports.com', siteType: 'retailer', adapterType: 'generic-retail' },
  { domain: 'lockharttactical.com', name: 'Lockhart Tactical', url: 'https://www.lockharttactical.com', siteType: 'retailer', adapterType: 'generic-retail', notes: 'Joomla, search may not work' },

  // ── Headless/SPA (limited scraping support) ────────────────────────────
  { domain: 'gotenda.com', name: 'GoTenda', url: 'https://www.gotenda.com', siteType: 'retailer', adapterType: 'generic-retail', requiresSucuri: true, notes: 'Headless SPA, 307 redirects — limited scraping' },
  { domain: 'bullseyenorth.com', name: 'Bullseye North', url: 'https://www.bullseyenorth.com', siteType: 'retailer', adapterType: 'generic-retail', notes: 'Parse error on HTTP requests — limited scraping' },
  { domain: 'hical.ca', name: 'Hi-Cal', url: 'https://hical.ca', siteType: 'retailer', adapterType: 'generic-retail', notes: 'Headless SPA, returns empty HTML' },

  // ── Big Box / Other Retailers ────────────────────────────────────────────
  { domain: 'cabelas.ca', name: "Cabela's Canada", url: 'https://www.cabelas.ca', siteType: 'retailer', adapterType: 'generic-retail', searchUrlPattern: '/search?q={keyword}&lang=en_CA' },
  { domain: 'basspro.ca', name: 'Bass Pro Shops Canada', url: 'https://www.basspro.ca', siteType: 'retailer', adapterType: 'generic-retail' },
  { domain: 'sail.ca', name: 'SAIL Outdoors', url: 'https://www.sail.ca/en/', siteType: 'retailer', adapterType: 'generic-retail' },
  { domain: 'canadiantire.ca', name: 'Canadian Tire', url: 'https://www.canadiantire.ca', siteType: 'retailer', adapterType: 'generic-retail', notes: 'Limited firearms selection' },

  // ── Forums ───────────────────────────────────────────────────────────────
  { domain: 'canadiangunnutz.com', name: 'Canadian Gun Nutz', url: 'https://www.canadiangunnutz.com', siteType: 'forum', adapterType: 'forum-xenforo', requiresAuth: true, searchUrlPattern: '/forum/search/?q={keyword}&t=post' },
  { domain: 'gunownersofcanada.ca', name: 'Gun Owners of Canada', url: 'https://www.gunownersofcanada.ca', siteType: 'forum', adapterType: 'forum-xenforo', requiresAuth: true, searchUrlPattern: '/search/?q={keyword}&t=post' },

  // ── Classifieds ──────────────────────────────────────────────────────────
  { domain: 'gunpost.ca', name: 'GunPost', url: 'https://www.gunpost.ca', siteType: 'classifieds', adapterType: 'classifieds-gunpost', searchUrlPattern: '/ads?key={keyword}' },
  { domain: 'townpost.ca', name: 'TownPost', url: 'https://www.townpost.ca', siteType: 'classifieds', adapterType: 'generic', notes: 'General classifieds with firearms section' },

  // ── Auction Houses ───────────────────────────────────────────────────────
  { domain: 'icollector.com', name: 'iCollector', url: 'https://www.icollector.com', siteType: 'auction', adapterType: 'auction-icollector' },
  { domain: 'canada.hibid.com', name: 'HiBid Canada', url: 'https://canada.hibid.com', siteType: 'auction', adapterType: 'auction-hibid', searchUrlPattern: '/search?searchPhrase={keyword}' },
  { domain: 'millerandmillerauctions.com', name: 'Miller & Miller Auctions', url: 'https://www.millerandmillerauctions.com', siteType: 'auction', adapterType: 'auction-generic' },
  { domain: 'switzersauction.com', name: "Switzer's Auction", url: 'https://www.switzersauction.com', siteType: 'auction', adapterType: 'auction-generic' },
];

// Sites that were removed and should be disabled in the DB
const REMOVED_DOMAINS = [
  'bullseyelondon.com',
  'prophetsriver.com',
  'tendarmsco.com',
  'corwinarms.com',
  'triggersnbows.com',
  'herbsgunshop.com',
  'dfrankfirearms.com',
  'guns4u.ca',
  'gunhub.ca',
  'talonoutdoors.ca',
  'purelyoutdoors.ca',
  'g4cgun.com',
  'shophighcalibre.com',
  'wolverineoutdoors.ca',
  'thecountergunshop.com',
  'bartonandcooperarms.com',
  'tradeexcanada.com',
  'canadaammo.com',
  'ammobin.ca',
  'tascfirearms.com',
  'sfrc.ca',
  'nfrg.ca',
  'pgfirearms.com',
  'alsimsports.com',
  'boisseauauctioneers.com',
  'simpsonltd.com',
  'rockislandauction.com',
  'albertatrailswest.ca',
  'thegunsmith.ca',
  'huntinggearguy.com',
  'westcoasthunting.ca',
  'gotactical.ca',
  'p-bcoutdoors.ca',
  'armseast.ca',
  'westerngunsandtack.ca',
  'gagnonsportscanmore.com',
  'theshootingcentre.com',
  'shootingshop.ca',
  'questarpeakerarms.com',
  'wholesalesports.com',
  'proxibid.com',
  'basspro.com',
  'sailoutdoors.com',
  'irunguns.com',
  'wanstallsonline.com',
  'canadiangunstore.ca',
  'hibid.com',
];

async function main() {
  console.log(`Seeding ${SITES.length} monitored sites...`);
  let created = 0;
  let updated = 0;

  for (const site of SITES) {
    const result = await prisma.monitoredSite.upsert({
      where: { domain: site.domain },
      update: {
        name: site.name,
        url: site.url,
        siteType: site.siteType,
        adapterType: site.adapterType,
        isEnabled: true,
        requiresSucuri: site.requiresSucuri ?? false,
        requiresAuth: site.requiresAuth ?? false,
        searchUrlPattern: site.searchUrlPattern ?? null,
        notes: site.notes ?? null,
      },
      create: {
        domain: site.domain,
        name: site.name,
        url: site.url,
        siteType: site.siteType,
        adapterType: site.adapterType,
        requiresSucuri: site.requiresSucuri ?? false,
        requiresAuth: site.requiresAuth ?? false,
        searchUrlPattern: site.searchUrlPattern ?? null,
        notes: site.notes ?? null,
      },
    });

    if (result.createdAt.getTime() === result.updatedAt.getTime()) {
      created++;
    } else {
      updated++;
    }
  }

  // Disable removed/dead sites
  let disabled = 0;
  for (const domain of REMOVED_DOMAINS) {
    const result = await prisma.monitoredSite.updateMany({
      where: { domain, isEnabled: true },
      data: { isEnabled: false },
    });
    disabled += result.count;
  }

  console.log(`Done! Created: ${created}, Updated: ${updated}, Disabled: ${disabled}, Active: ${SITES.length}`);

  // Print summary by type
  const byType = SITES.reduce((acc, s) => {
    acc[s.siteType] = (acc[s.siteType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log('\nBy site type:');
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }

  const byAdapter = SITES.reduce((acc, s) => {
    acc[s.adapterType] = (acc[s.adapterType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log('\nBy adapter type:');
  for (const [type, count] of Object.entries(byAdapter)) {
    console.log(`  ${type}: ${count}`);
  }
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
