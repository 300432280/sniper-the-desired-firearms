/**
 * Comprehensive site diagnostic: Tests every 0-product site with both
 * static HTTP and Playwright, runs adapter selectors against real HTML,
 * and reports exactly what's working vs broken.
 */
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { getAdapterByType } from '../src/services/scraper/adapter-registry';

const prisma = new PrismaClient();

interface DiagResult {
  domain: string;
  adapterType: string;
  notes: string | null;
  // Static HTTP
  staticStatus: number | string;
  staticHtmlSize: number;
  staticWafDetected: boolean;
  // Playwright
  pwHtmlSize: number;
  pwError: string | null;
  // Adapter selectors on Playwright HTML
  selectorMatches: Record<string, number>;
  catalogProductCount: number;
  // Links analysis
  productLinkCount: number;
  sampleTitles: string[];
  // Verdict
  verdict: string;
}

async function testSite(site: {
  domain: string;
  url: string;
  adapterType: string;
  notes: string | null;
  hasWaf: boolean;
  requiresAuth: boolean;
}): Promise<DiagResult> {
  const result: DiagResult = {
    domain: site.domain,
    adapterType: site.adapterType,
    notes: site.notes,
    staticStatus: 'N/A',
    staticHtmlSize: 0,
    staticWafDetected: false,
    pwHtmlSize: 0,
    pwError: null,
    selectorMatches: {},
    catalogProductCount: 0,
    productLinkCount: 0,
    sampleTitles: [],
    verdict: 'unknown',
  };

  // 1. Static HTTP fetch
  try {
    const resp = await axios.get(site.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    result.staticStatus = resp.status;
    result.staticHtmlSize = typeof resp.data === 'string' ? resp.data.length : JSON.stringify(resp.data).length;
    const html = typeof resp.data === 'string' ? resp.data : '';
    result.staticWafDetected = html.includes('_Incapsula_Resource') ||
      html.includes('Access Denied') || html.includes('403 Forbidden') ||
      html.includes('cf-browser-verification') || html.includes('challenge-platform') ||
      html.includes('Just a moment...') || resp.status === 403 || resp.status === 202;
  } catch (err: any) {
    result.staticStatus = `ERROR: ${err.message?.slice(0, 80)}`;
  }

  // 2. Playwright fetch
  try {
    const { fetchWithPlaywright } = await import('../src/services/scraper/playwright-fetcher');
    const pwResult = await fetchWithPlaywright(site.url, { timeout: 35000 });
    result.pwHtmlSize = pwResult.html.length;

    // 3. Run adapter selectors on Playwright HTML
    const $ = cheerio.load(pwResult.html);
    const adapter = getAdapterByType(site.adapterType);

    // Common selectors to test
    const testSelectors = [
      'li.product', '[class*="product-card"]', '[class*="product-item"]',
      '[data-product-id]', '[data-product]', 'article',
      '[class*="node--type"]', '[class*="teaser"]', '[class*="views-row"]',
      '[class*="lot-item"]', '[class*="lotContainer"]', '[class*="LotTile"]',
      '[class*="structItem"]', '[class*="listing"]', '[class*="classified"]',
      '.card', '.product-thumb', 'li[class*="product"]',
      '[class*="product-tile"]', '[class*="item-card"]',
      '.woocommerce-loop-product', '.productborder',
      '[class*="grid-item"]', '[class*="search-result"]',
    ];

    for (const sel of testSelectors) {
      const count = $(sel).length;
      if (count > 0) result.selectorMatches[sel] = count;
    }

    // 4. Try the adapter's extractCatalogProducts method
    if (adapter.extractCatalogProducts) {
      // Determine the catalog URL the adapter would use
      let catalogUrl = site.url;
      if (adapter.getNewArrivalsUrl) {
        catalogUrl = adapter.getNewArrivalsUrl(new URL(site.url).origin);
      }

      // If current page IS the catalog page (or close), run extraction
      const products = adapter.extractCatalogProducts($, site.url);
      result.catalogProductCount = products.length;
      result.sampleTitles = products.slice(0, 3).map(p => `${p.title.slice(0, 60)} [${p.price ?? 'no price'}]`);
    }

    // 5. Count product-like links
    const productLinks = $('a[href]').filter((_, el) => {
      const href = $(el).attr('href') || '';
      return /\/(product|item|ad|lot|listing|p\/)/i.test(href) && !/(cart|login|register|account|category|collection)/i.test(href);
    });
    result.productLinkCount = productLinks.length;

    // If no catalog products but we have product links, show some
    if (result.catalogProductCount === 0 && result.productLinkCount > 0) {
      productLinks.slice(0, 3).each((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim().slice(0, 60);
        if (text.length > 3) result.sampleTitles.push(`LINK: ${text} → ${href?.slice(0, 60)}`);
      });
    }

    // Show page title for context
    const pageTitle = $('title').text().trim().slice(0, 80);
    if (result.sampleTitles.length === 0) {
      result.sampleTitles.push(`PAGE TITLE: ${pageTitle}`);
      // Show a few class names from the body for debugging
      const bodyClasses: string[] = [];
      $('body > div, body > main, body > section, body > article').slice(0, 5).each((_, el) => {
        const cls = $(el).attr('class')?.slice(0, 80);
        if (cls) bodyClasses.push(cls);
      });
      if (bodyClasses.length > 0) result.sampleTitles.push(`TOP CLASSES: ${bodyClasses.join(' | ')}`);
    }

  } catch (err: any) {
    result.pwError = err.message?.slice(0, 100) || 'Unknown error';
  }

  // 6. Determine verdict
  if (result.catalogProductCount > 0) {
    result.verdict = 'WORKING — adapter extracts products from Playwright HTML';
  } else if (result.pwError) {
    result.verdict = 'PLAYWRIGHT_FAIL — cannot render page at all';
  } else if (result.pwHtmlSize < 2000) {
    result.verdict = 'EMPTY_HTML — Playwright got minimal HTML (SPA/WAF challenge unsolved)';
  } else if (Object.keys(result.selectorMatches).length > 0) {
    result.verdict = 'SELECTOR_CLOSE — elements found but adapter extraction returns 0 (selectors need tuning)';
  } else if (result.productLinkCount > 0) {
    result.verdict = 'LINKS_ONLY — product links exist but no structured elements match any selector';
  } else if (result.staticWafDetected && result.pwHtmlSize > 5000) {
    result.verdict = 'WAF_BYPASSED_BUT_EMPTY — Playwright bypassed WAF but page has no products on homepage';
  } else if (result.staticWafDetected) {
    result.verdict = 'WAF_BLOCKED — both static and Playwright blocked by WAF';
  } else {
    result.verdict = 'NO_PRODUCTS — page loaded but no product elements or links found';
  }

  return result;
}

async function main() {
  // Find all sites with 0 products
  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true },
    select: {
      id: true, domain: true, url: true, adapterType: true,
      notes: true, hasWaf: true, requiresAuth: true,
      _count: { select: { products: true } },
    },
    orderBy: { domain: 'asc' },
  });

  const zeroProductSites = sites.filter(s => s._count.products === 0);
  console.log(`=== Diagnosing ${zeroProductSites.length} sites with 0 products ===\n`);

  const results: DiagResult[] = [];

  for (const site of zeroProductSites) {
    console.log(`Testing ${site.domain} (${site.adapterType})...`);
    try {
      const diag = await testSite(site);
      results.push(diag);

      // Print summary
      console.log(`  Static: ${diag.staticStatus} (${diag.staticHtmlSize}b) WAF=${diag.staticWafDetected}`);
      console.log(`  Playwright: ${diag.pwError ? `FAIL: ${diag.pwError}` : `${diag.pwHtmlSize}b`}`);
      if (Object.keys(diag.selectorMatches).length > 0) {
        console.log(`  Selectors: ${JSON.stringify(diag.selectorMatches)}`);
      }
      console.log(`  Catalog products: ${diag.catalogProductCount}, Product links: ${diag.productLinkCount}`);
      if (diag.sampleTitles.length > 0) {
        for (const t of diag.sampleTitles) console.log(`    → ${t}`);
      }
      console.log(`  VERDICT: ${diag.verdict}`);
      console.log();
    } catch (err: any) {
      console.log(`  CRASH: ${err.message}`);
      console.log();
    }
  }

  // Summary table
  console.log('\n=== SUMMARY BY VERDICT ===\n');
  const byVerdict = new Map<string, string[]>();
  for (const r of results) {
    const list = byVerdict.get(r.verdict) || [];
    list.push(r.domain);
    byVerdict.set(r.verdict, list);
  }
  for (const [verdict, domains] of byVerdict) {
    console.log(`${verdict} (${domains.length}):`);
    for (const d of domains) console.log(`  - ${d}`);
    console.log();
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
