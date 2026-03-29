/**
 * Migration: Extract hardcoded site-specific configs into siteProfile JSON.
 * Run once. Reads the hardcoded values from adapter source and writes them to DB.
 *
 * Usage: node scripts/migrate-site-profiles.js [--dry-run]
 */
require('dotenv').config();
var { PrismaClient } = require('@prisma/client');
var p = new PrismaClient();

// All site profiles extracted from the codebase
var profiles = {
  // === BIGCOMMERCE SITES ===
  'truenortharms.com': { platform: 'bigcommerce', searchUrl: '/search.php?search_query={keyword}', catalogUrls: ['/categories.php', '/firearms/'], sortParam: '?sort=newest' },
  'frontierfirearms.ca': { platform: 'bigcommerce', searchUrl: '/search.php?search_query={keyword}', catalogUrls: ['/categories.php', '/firearms/', '/ammunition/', '/optics/', '/accessories/'], sortParam: '?sort=newest' },
  'firearmsoutletcanada.com': { platform: 'bigcommerce', searchUrl: '/search.php?search_query={keyword}', catalogUrls: ['/categories.php'], sortParam: '?sort=newest' },
  'nordicmarksman.com': { platform: 'bigcommerce', searchUrl: '/search.php?search_query={keyword}', catalogUrls: ['/categories.php', '/firearms-and-stocks/', '/shotguns/'], sortParam: '?sort=newest' },
  'rdsc.ca': { platform: 'bigcommerce', searchUrl: '/search.php?search_query={keyword}', catalogUrls: ['/categories.php'], sortParam: '?sort=newest' },
  'wolverinesupplies.com': { platform: 'bigcommerce', searchUrl: '/search.php?search_query={keyword}', catalogUrls: ['/categories.php'], sortParam: '?sort=newest' },
  'store.theshootingcentre.com': { platform: 'bigcommerce', catalogUrls: ['/categories.php'], sortParam: '?sort=newest' },
  'store.prophetriver.com': { platform: 'bigcommerce', catalogUrls: ['/categories.php'], sortParam: '?sort=newest' },
  'alflahertys.com': { platform: 'bigcommerce', searchUrl: '/search.php?search_query={keyword}', catalogUrls: ['/shooting-supplies-firearms-ammunition/firearms/rifles/', '/shooting-supplies-firearms-and-ammunition/firearms/shotguns/', '/shooting-supplies-firearms-ammunition/firearms/long-range-precision/', '/shooting-supplies-firearms-ammunition/firearms/used-firearms/', '/shooting-supplies-firearms-ammunition/firearms/airguns-500fps-or-more-pal-required/', '/shooting-supplies-firearms-ammunition/ammunition/centerfire-ammunition/', '/shooting-supplies-firearms-ammunition/ammunition/rimfire-ammunition/', '/shooting-supplies-firearms-ammunition/ammunition/shotgun-ammunition/', '/als-bargains/'], sortParam: '?sort=newest', apiConfig: { klevuApiKey: 'klevu-170966446878517137', klevuEndpoint: 'https://uscs33v2.ksearchnet.com/cs/v2/search', klevuCategoryPaths: [{ slug: 'rifles', path: 'Shooting Supplies, Firearms & Ammunition;Firearms;Rifles' }, { slug: 'shotguns', path: 'Shooting Supplies, Firearms & Ammunition;Firearms;Shotguns' }, { slug: 'long-range-precision', path: 'Shooting Supplies, Firearms & Ammunition;Firearms;Long Range Precision' }, { slug: 'used-firearms', path: 'Shooting Supplies, Firearms & Ammunition;Firearms;Used Firearms' }, { slug: 'airguns', path: 'Shooting Supplies, Firearms & Ammunition;Firearms;Airguns 500FPS or More - PAL Required' }, { slug: 'centerfire-ammunition', path: 'Shooting Supplies, Firearms & Ammunition;Ammunition;Centerfire Ammunition' }, { slug: 'rimfire-ammunition', path: 'Shooting Supplies, Firearms & Ammunition;Ammunition;Rimfire Ammunition' }, { slug: 'shotgun-ammunition', path: 'Shooting Supplies, Firearms & Ammunition;Ammunition;Shotgun Ammunition' }] }, notes: 'BigCommerce + Klevu JS overlay. Products rendered by Klevu, not server-side HTML. Klevu API key in page source.' },

  // === MAGENTO SITES ===
  'ellwoodepps.com': { platform: 'magento', searchUrl: '/catalogsearch/result/?q={keyword}', catalogUrls: ['/catalogsearch/result/?q=&product_list_order=newest'], sortParam: '?product_list_order=created_at&product_list_dir=desc', needsPlaywright: true, notes: 'Magento behind Cloudflare. Category .html pages dont render products in HTML. Only catalogsearch works.' },
  'sail.ca': { platform: 'magento', searchUrl: '/en/shop?q={keyword}', catalogUrls: ['/en/hunting-and-fishing/firearms'], sortParam: '?product_list_order=created_at&product_list_dir=desc', needsPlaywright: true, notes: 'Magento. Products lazy-loaded via AJAX. Needs Playwright.' },
  'londerosports.com': { platform: 'magento', catalogUrls: ['/firearms.html', '/ammunition.html', '/optics.html', '/'], sortParam: '?product_list_order=created_at&product_list_dir=desc' },

  // === LIGHTSPEED SITES ===
  'gagnonsports.com': { platform: 'lightspeed', searchUrl: '/search/{keyword}/', catalogUrls: ['/new-firearms/centerfire-rifles/', '/new-firearms/rimfire-rifles/', '/new-firearms/shotguns/', '/new-firearms/restricted-firearms/', '/new-firearms/air-guns/', '/used-firearms/', '/ammunition/centerfire-ammunition/', '/ammunition/rimfire-ammunition/', '/ammunition/shotshells/', '/optics/riflescopes/', '/optics/red-dot-sights/', '/optics/binoculars/', '/accessories/', '/reloading/'], sortParam: '?sort=newest', notes: 'LightSpeed Classic. 15 category pages.' },
  'solelyoutdoors.com': { platform: 'lightspeed', searchUrl: '/search/{keyword}/', catalogUrls: ['/firearms.html', '/ammunition.html', '/optics.html', '/accessories.html', '/reloading.html'], sortParam: '?sort=newest', notes: 'LightSpeed Nova theme. Uses .html extension.' },
  'fulcrum-outdoors.shoplightspeed.com': { platform: 'lightspeed', catalogUrls: ['/firearms/', '/ammunition/', '/optics/', '/accessories/'], sortParam: '?sort=newest', notes: 'LightSpeed eCom. Cloudflare blocks detail pages.' },
  'outfitters.goldnloan.com': { platform: 'lightspeed', catalogUrls: ['/firearms/', '/ammunition/', '/'], sortParam: '?sort=newest' },

  // === COLDFUSION SITES ===
  'bullseyenorth.com': { platform: 'coldfusion', searchUrl: '/all-products/browse/keyword/{keyword}', catalogUrls: ['/firearms', '/ammunition', '/magazines', '/reloading', '/optics', '/knives', '/accessories', '/on-sale', '/shop'], sortParam: '?sort=new-arrivals', wafType: 'coldfusion-malformed-headers', notes: 'Celerant ColdFusion e-commerce. Sends malformed HTTP headers (trailing spaces). Products are <a class="product"> tags. 9 category streams.' },

  // === WOOCOMMERCE SITES (with custom catalog URLs) ===
  'gotenda.com': { platform: 'woocommerce', catalogUrls: ['/product-category/firearms/', '/product-category/ammunition/', '/product-category/accessories/', '/product-category/reloading/', '/product-category/optic/', '/product-category/knives/', '/product-category/hunting-outdoor/', '/shop/'], sortParam: '?orderby=date', wafType: 'sucuri', timeout: 30000, dataFlow: { steps: [{ api: 'WP REST API', provides: ['title', 'url', 'thumbnail', 'categories', 'sourceId'], notes: 'NO price or stock' }, { api: 'WC Store API', provides: ['price', 'regularPrice', 'stockStatus'], notes: 'Uses include=<ids>, needs WAF cookies, 30s timeout' }] }, notes: 'WooCommerce behind Sucuri WAF. 16,155 products. WP REST has no prices — Store API enrichment required.' },
  'doctordeals.ca': { platform: 'woocommerce', catalogUrls: ['/product-category/gun-shop/firearms/rifles/', '/product-category/gun-shop/firearms/shotguns/', '/product-category/gun-shop/firearms/non-restricted/', '/product-category/gun-shop/firearms/used-and-war/', '/product-category/gun-shop/ammunition/', '/product-category/gun-shop/optics-sights/'], wafType: 'sucuri', notes: 'WAF-blocked WooCommerce. /shop/ shows category grids not products.' },
  'g4cgunstore.com': { platform: 'woocommerce', catalogUrls: ['/product-category/firearms/rifles/non-restricted-rifles/', '/product-category/firearms/handguns/pistols/', '/product-category/firearms/shotguns/', '/product-category/firearms/rifles/restricted-rifles/', '/product-category/new-arrivals/', '/product-category/ammunition/'], wafType: 'cloudflare', notes: 'Cloudflare Turnstile blocks everything. Site effectively non-functional for automated crawling. DISABLED.' },
  'corwin-arms.com': { platform: 'woocommerce', catalogUrls: ['/product-category/firearms/', '/product-category/clearance/'], notes: '/shop redirects to homepage.' },

  // === CUSTOM PLATFORM SITES ===
  'lockharttactical.com': { platform: 'custom', catalogUrls: ['/category', '/product'], notes: 'HikaShop (Joomla). Products NOT on homepage.' },
  'canadasgunstore.ca': { platform: 'custom', catalogUrls: ['/firearms-%7C30%7CFA', '/rifles-%7C30%7CFA%7CRIFLNR', '/pistols', '/shotguns', '/promotions'], notes: 'Activant/Epicor iNet. Special URL encoding.' },
  'precisionoptics.net': { platform: 'custom', catalogUrls: ['/Riflescopes_s/64.htm', '/Firearms_s/325.htm', '/Ammunition_s/550.htm', '/Binoculars_s/65.htm', '/category_s/860.htm'], notes: '3dcart/Shift4Shop. Uses _s/ID.htm pattern.' },
  'reliablegun.com': { platform: 'custom', catalogUrls: ['/firearms', '/firearms/rifles', '/firearms/shotguns', '/firearms/handguns', '/'], notes: 'nopCommerce.' },
  'durhamoutdoors.ca': { platform: 'custom', catalogUrls: ['/'], needsPlaywright: true, notes: 'Custom PHP. Homepage only (.product-item cards). Cloudflare.' },
  'irunguns.ca': { platform: 'custom', catalogUrls: ['/subcategory.php?parent=Firearms', '/category.php?parent=Magazines', '/category.php?parent=Import_/_Export'], notes: 'Custom PHP import/export site.' },
  'northprosports.com': { platform: 'custom', catalogUrls: ['/index.php?route=product/category&path=1055', '/index.php?route=product/category&path=62', '/index.php?route=product/category&path=64', '/'], notes: 'OpenCart.' },
  'triggersandbows.com': { platform: 'custom', catalogUrls: ['/'], notes: 'Ecwid on WordPress. Homepage only.' },

  // === FORUM SITES ===
  'canadiangunnutz.com': { platform: 'xenforo', apiConfig: { forumSections: ['exchange-of-hunting-and-sporting-rifles.64', 'exchange-of-modern-sporting-rifles.65', 'exchange-of-pistols-and-revolvers.66', 'exchange-of-shotguns.145', 'exchange-of-rimfire-firearms.160', 'exchange-of-military-surplus-rifle.128', 'exchange-of-precision-and-target-rifles.156', 'exchange-of-12x-prohib-firearms.330', 'exchange-of-optics.67', 'exchange-of-reloading-components-and-equipment.68'] }, notes: 'XenForo forum. 10 exchange/classified sub-forums.' },

  // === CLASSIFIEDS ===
  'townpost.ca': { platform: 'custom', catalogUrls: ['/category/guns/', '/category/sporting-goods/'], notes: 'TownPost classifieds.' },

  // === GUNPOST ===
  'gunpost.ca': { platform: 'drupal', classifiedRules: { wantedDetection: ['^wanted', 'wtb$', 'wtt$', 'iso$', 'wanted$', 'wanted:'], soldDetection: ['class=sold', 'class=ad-sold', 'field-sold Yes', 'SOLD'] }, notes: 'Drupal classifieds behind Cloudflare. 19K+ listings. Sold items stay on site with CSS class. Wanted ads detected by title prefix/suffix and CSS class.' },
};

async function main() {
  var dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('DRY RUN\n');

  var count = 0;
  for (var domain in profiles) {
    var profile = profiles[domain];
    profile.domain = domain;
    profile.lastVerified = '2026-03-29';

    var site = await p.monitoredSite.findUnique({ where: { domain: domain }, select: { id: true, name: true } });
    if (!site) {
      console.log('SKIP ' + domain + ' — not in DB');
      continue;
    }
    profile.name = site.name;

    if (dryRun) {
      console.log(domain + ': ' + JSON.stringify(profile).substring(0, 100) + '...');
    } else {
      await p.monitoredSite.update({
        where: { domain: domain },
        data: { siteProfile: profile },
      });
      console.log('SET ' + domain);
    }
    count++;
  }

  console.log('\n' + (dryRun ? 'Would set' : 'Set') + ' ' + count + ' profiles');
  await p['$disconnect']();
}
main().catch(function(e) { console.error(e); process.exit(1); });
