import 'dotenv/config';
import axios from 'axios';

const BASE = 'https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/92697308';
const HDR = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.triggersandbows.com',
  'Referer': 'https://www.triggersandbows.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
const URL_PARAMS = { baseUrl: '/store/', canonicalBaseUrl: 'https://www.triggersandbows.com/store/', isCleanUrls: true, isCanonicalUrlsEnabled: true, isSlugsWithoutIds: false };

async function catalogPost(body: any) {
  return axios.post(BASE + '/catalog', body, { headers: HDR, validateStatus: () => true, timeout: 30000 });
}

async function walkCategory(parentCategoryId: number): Promise<{ total: number; urls: Set<string> }> {
  const urls = new Set<string>();
  let offset = 0;
  const limit = 100;
  let total = 0;
  while (true) {
    const r = await catalogPost({
      categoryViewMode: 'COLLAPSED', lang: 'en', parentCategoryId,
      pagination: { offset, limit }, sortBy: '', urlParams: URL_PARAMS,
    });
    const ec = r.data?.expandedCategories?.[0];
    if (!ec) break;
    total = ec.totalProductsCount ?? 0;
    const prods = ec.products || [];
    for (const p of prods) if (p.seo?.canonicalUrl) urls.add(p.seo.canonicalUrl);
    if (prods.length === 0 || urls.size >= total) break;
    offset += limit;
    if (offset > 10000) break;
  }
  return { total, urls };
}

async function main() {
  console.log('=== Walk with /catalog/search globally (primary path) ===');
  // Use /catalog/search instead — it has access to ALL products regardless of category nesting
  const unionUrls = new Set<string>();
  let offset = 0;
  const limit = 200;
  let lastTotal = 0;
  while (true) {
    const r = await axios.post(BASE + '/catalog/search', {
      lang: 'en',
      pagination: { offset, limit },
      urlParams: URL_PARAMS,
    }, { headers: HDR, validateStatus: () => true, timeout: 30000 });
    const products = r.data?.products || [];
    lastTotal = r.data?.totalProductsCount ?? lastTotal;
    let added = 0;
    for (const p of products) {
      const url = p.seo?.canonicalUrl;
      if (url && !unionUrls.has(url)) {
        unionUrls.add(url);
        added++;
      }
    }
    console.log(`  offset=${offset} got=${products.length} added=${added} total_unique=${unionUrls.size} server_total=${lastTotal}`);
    if (products.length === 0) break;
    offset += limit;
    if (offset > 10000) break;
  }
  console.log(`\nUNION via /catalog/search walk: ${unionUrls.size}`);
  console.log(`Expected (server totalProductsCount): ${lastTotal}`);

  // Now test sort via /catalog/search
  console.log('\n=== /catalog/search sort tests ===');
  for (const sortBy of ['addedTimeDesc', '', 'nameAsc', 'priceAsc']) {
    const r = await axios.post(BASE + '/catalog/search', {
      lang: 'en', pagination: { offset: 0, limit: 3 }, sortBy, urlParams: URL_PARAMS,
    }, { headers: HDR, validateStatus: () => true });
    const first3 = (r.data?.products || []).slice(0, 3).map((p: any) => p.seo?.canonicalUrl?.split('/').pop()?.slice(0, 60));
    console.log(`  sortBy="${sortBy}": ${JSON.stringify(first3)}`);
  }

  // Test date filter — /catalog/search with updatedFrom / dateModifiedFrom
  console.log('\n=== /catalog/search filter field discovery ===');
  for (const bodyExtra of [
    {},
    { filtering: { createTimeFrom: Math.floor(Date.now()/1000) - 86400*7 } },
    { filtering: { createdTimeFrom: Math.floor(Date.now()/1000) - 86400*7 } },
    { filtering: { updatedTimeFrom: Math.floor(Date.now()/1000) - 86400*7 } },
    { filtering: { createDateFrom: new Date(Date.now() - 86400*7*1000).toISOString() } },
    { createTimeFrom: Math.floor(Date.now()/1000) - 86400*7 },
    { filter: { createdFrom: Math.floor(Date.now()/1000) - 86400*7 } },
  ]) {
    const r = await axios.post(BASE + '/catalog/search', {
      lang: 'en', pagination: { offset: 0, limit: 1 }, urlParams: URL_PARAMS, ...bodyExtra,
    }, { headers: HDR, validateStatus: () => true });
    const label = JSON.stringify(bodyExtra).slice(0, 80);
    console.log(`  ${label}: totalProductsCount=${r.data?.totalProductsCount}`);
  }

  // Sample product structure — look for date fields
  console.log('\n=== Product structure — look for date/time fields ===');
  const r = await axios.post(BASE + '/catalog/search', { lang: 'en', pagination: { offset: 0, limit: 1 }, sortBy: 'addedTimeDesc', urlParams: URL_PARAMS }, { headers: HDR, validateStatus: () => true });
  const sample = r.data?.products?.[0];
  if (sample) {
    const keys = Object.keys(sample);
    console.log('  top keys:', keys);
    // Find any field with "time", "date", "added", "created", "modified", "updated"
    const dateFields: any = {};
    function recurse(obj: any, prefix = '') {
      if (!obj || typeof obj !== 'object') return;
      for (const k of Object.keys(obj)) {
        if (/time|date|added|created|modified|updated/i.test(k)) {
          dateFields[prefix + k] = obj[k];
        }
        if (typeof obj[k] === 'object' && !Array.isArray(obj[k])) recurse(obj[k], prefix + k + '.');
      }
    }
    recurse(sample);
    console.log('  date-like fields found:', JSON.stringify(dateFields, null, 2));
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
