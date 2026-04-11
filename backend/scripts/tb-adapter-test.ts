// Live test of the ecwid-storefront-api branch in generic-retail adapter.
// Loads Site 32 (triggersandbows) profile from DB, injects into adapter-registry
// cache, then calls fetchCatalogPage() and prints results.
import { PrismaClient } from '@prisma/client';
import { GenericRetailAdapter } from '../src/services/scraper/adapters/generic-retail';
import { getAdapterForUrl } from '../src/services/scraper/adapter-registry';

async function main() {
  const prisma = new PrismaClient();
  try {
    // Warm registry cache by doing a lookup — refreshes from DB.
    await getAdapterForUrl('https://www.triggersandbows.com/');

    const site = await prisma.monitoredSite.findFirst({
      where: { domain: 'triggersandbows.com' },
      select: { domain: true, siteProfile: true },
    });
    if (!site) throw new Error('Site not found in DB');

    const profile: any = site.siteProfile;
    console.log('profile.apiAlternative.type:', profile?.apiAlternative?.type);
    console.log('profile.apiAlternative.endpoint:', profile?.apiAlternative?.endpoint);
    if (profile?.apiAlternative?.type !== 'ecwid-storefront-api') {
      throw new Error('Site 32 profile does not declare ecwid-storefront-api');
    }

    const adapter = new GenericRetailAdapter();
    const origin = 'https://www.triggersandbows.com';

    const page1 = await adapter.fetchCatalogPage(origin, 1, { sortBy: 'newest', perPage: 10 });
    console.log('\n=== Page 1 ===');
    console.log('products.length:', page1?.products?.length);
    console.log('totalPages:', page1?.totalPages);
    console.log('nextPageUrl:', page1?.nextPageUrl);
    if (page1?.products?.[0]) {
      const p = page1.products[0];
      console.log('first product:');
      console.log('  url:', p.url);
      console.log('  title:', p.title);
      console.log('  sourceId:', p.sourceId);
      console.log('  price:', p.price);
      console.log('  stockStatus:', p.stockStatus);
    }
    if (page1?.products?.[1]) {
      console.log('second product url:', page1.products[1].url);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
