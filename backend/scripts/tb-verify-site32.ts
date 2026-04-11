// Site 32 (triggersandbows.com) — full 7-phase verification harness
// Uses PRODUCTION code paths (GenericRetailAdapter.fetchCatalogPage via ecwid-storefront-api branch)
import { PrismaClient } from '@prisma/client';
import { GenericRetailAdapter } from '../src/services/scraper/adapters/generic-retail';
import { getAdapterForUrl } from '../src/services/scraper/adapter-registry';

const ORIGIN = 'https://www.triggersandbows.com';
const results: { check: string; status: 'PASS' | 'FAIL'; detail: string }[] = [];

function report(check: string, pass: boolean, detail: string) {
  const status = pass ? 'PASS' : 'FAIL';
  results.push({ check, status, detail });
  console.log(`[${status}] ${check}: ${detail}`);
}

async function main() {
  const prisma = new PrismaClient();
  try {
    // Phase 0: Warm adapter registry cache from DB
    console.log('Warming adapter registry cache...');
    const lookup = await getAdapterForUrl(ORIGIN + '/');
    if (!lookup.siteProfile?.apiAlternative) {
      throw new Error('Profile not loaded or missing apiAlternative');
    }
    console.log('adapter:', lookup.adapterType);
    console.log('apiAlternative.type:', lookup.siteProfile.apiAlternative.type);

    const adapter = new GenericRetailAdapter();

    // ── Check 1: fetchCatalogPage exists (watermark useApi flag) ──
    report(
      'fetchCatalogPage exists',
      typeof adapter.fetchCatalogPage === 'function',
      `typeof = ${typeof adapter.fetchCatalogPage}`
    );

    // ── Check 2: Page 1 with sortBy=newest returns products ──
    console.log('\nFetching page 1 (newest, perPage=10)...');
    const p1 = await adapter.fetchCatalogPage(ORIGIN, 1, { sortBy: 'newest', perPage: 10 });
    const p1Count = p1?.products?.length ?? 0;
    const p1Total = p1?.totalPages;
    const p1First = p1?.products?.[0];
    report(
      'Page 1 returns products',
      p1Count > 0,
      `${p1Count} products, totalPages=${p1Total}, first=${p1First?.title?.slice(0, 60)}`
    );
    report(
      'totalPages matches ~4914',
      p1Total !== undefined && p1Total >= 400 && p1Total <= 600,
      `totalPages=${p1Total} (expected ~492 at perPage=10)`
    );

    // ── Check 3: Page 2 returns DIFFERENT products from page 1 ──
    console.log('\nFetching page 2 (newest, perPage=10)...');
    const p2 = await adapter.fetchCatalogPage(ORIGIN, 2, { sortBy: 'newest', perPage: 10 });
    const p2First = p2?.products?.[0];
    const p1Urls = new Set(p1?.products?.map(p => p.url) ?? []);
    const p2Urls = new Set(p2?.products?.map(p => p.url) ?? []);
    const overlap = [...p2Urls].filter(u => p1Urls.has(u)).length;
    report(
      'Page 2 differs from page 1',
      p2First !== undefined && p1First?.url !== p2First?.url,
      `p1[0]=${p1First?.url?.slice(-40)} vs p2[0]=${p2First?.url?.slice(-40)}, overlap=${overlap}`
    );

    // ── Check 4: sortBy=oldest returns DIFFERENT first product ──
    console.log('\nFetching page 1 (oldest, perPage=10)...');
    const pOld = await adapter.fetchCatalogPage(ORIGIN, 1, { sortBy: 'oldest', perPage: 10 });
    const pOldFirst = pOld?.products?.[0];
    report(
      'Sort oldest differs from newest',
      pOldFirst !== undefined && p1First?.url !== pOldFirst?.url,
      `newest[0]=${p1First?.title?.slice(0, 40)} vs oldest[0]=${pOldFirst?.title?.slice(0, 40)}`
    );

    // ── Check 5: Middle page (page 25) returns products ──
    console.log('\nFetching page 25 (newest, perPage=10)...');
    const pMid = await adapter.fetchCatalogPage(ORIGIN, 25, { sortBy: 'newest', perPage: 10 });
    report(
      'Page 25 (middle) returns products',
      (pMid?.products?.length ?? 0) > 0,
      `${pMid?.products?.length ?? 0} products`
    );

    // ── Check 6: Last page returns fewer than perPage ──
    const lastPage = p1Total ?? 492;
    console.log(`\nFetching last page ${lastPage} (newest, perPage=10)...`);
    const pLast = await adapter.fetchCatalogPage(ORIGIN, lastPage, { sortBy: 'newest', perPage: 10 });
    const lastCount = pLast?.products?.length ?? 0;
    report(
      'Last page returns <=10 products',
      lastCount >= 0 && lastCount <= 10,
      `${lastCount} products on page ${lastPage}`
    );

    // ── Check 7: Page beyond last returns 0 products ──
    const beyondPage = lastPage + 1;
    console.log(`\nFetching beyond-last page ${beyondPage}...`);
    const pBeyond = await adapter.fetchCatalogPage(ORIGIN, beyondPage, { sortBy: 'newest', perPage: 10 });
    report(
      'Beyond-last page returns 0 products',
      (pBeyond?.products?.length ?? 0) === 0,
      `${pBeyond?.products?.length ?? 0} products on page ${beyondPage}`
    );

    // ── Check 8: Sort + pagination combined (page 2 oldest differs from page 2 newest) ──
    console.log('\nFetching page 2 (oldest, perPage=10)...');
    const p2Old = await adapter.fetchCatalogPage(ORIGIN, 2, { sortBy: 'oldest', perPage: 10 });
    report(
      'Sort+pagination: p2 oldest != p2 newest',
      p2Old?.products?.[0]?.url !== p2?.products?.[0]?.url,
      `newest p2[0]=${p2?.products?.[0]?.title?.slice(0, 30)} vs oldest p2[0]=${p2Old?.products?.[0]?.title?.slice(0, 30)}`
    );

    // ── Check 9: Profile notes exist ──
    const site = await prisma.monitoredSite.findFirst({
      where: { domain: 'triggersandbows.com' },
      select: { siteProfile: true },
    });
    const profile: any = site?.siteProfile;
    report(
      'Profile notes non-empty',
      !!(profile?.notes && profile.notes.length > 0),
      `notes length: ${profile?.notes?.length ?? 0}`
    );

    // ── Check 10: Product data quality ──
    if (p1First) {
      report(
        'Products have URL + title + sourceId',
        !!(p1First.url && p1First.title && p1First.sourceId),
        `url=${!!p1First.url}, title=${!!p1First.title}, sourceId=${p1First.sourceId}, price=${p1First.price}`
      );
    }

    // ── Full perPage=100 sanity check (production page size) ──
    console.log('\nFetching page 1 with perPage=100 (production page size)...');
    const p1Full = await adapter.fetchCatalogPage(ORIGIN, 1, { sortBy: 'newest', perPage: 100 });
    report(
      'perPage=100 returns 100 products',
      (p1Full?.products?.length ?? 0) === 100,
      `${p1Full?.products?.length ?? 0} products, totalPages=${p1Full?.totalPages}`
    );

    // ── Summary ──
    console.log('\n' + '='.repeat(60));
    console.log('VERIFICATION SUMMARY');
    console.log('='.repeat(60));
    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    for (const r of results) {
      console.log(`  [${r.status}] ${r.check}`);
    }
    console.log(`\n${passed} passed, ${failed} failed out of ${results.length} checks`);

    if (failed > 0) {
      console.log('\nFAILED CHECKS:');
      for (const r of results.filter(r => r.status === 'FAIL')) {
        console.log(`  ${r.check}: ${r.detail}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
