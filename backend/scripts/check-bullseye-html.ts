/**
 * Diagnostic script: inspect bullseyenorth.com HTML to find stable product IDs.
 *
 * Usage: cd backend && npx tsx scripts/check-bullseye-html.ts
 */
import { fetchWithPlaywright } from '../src/services/scraper/playwright-fetcher';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const url = 'https://www.bullseyenorth.com/firearms';
  console.log(`Fetching ${url} with Playwright...`);

  const result = await fetchWithPlaywright(url, { timeout: 30000, waitForSelector: 'a.product' });
  console.log(`Fetched ${result.html.length} chars in ${result.responseTimeMs}ms`);

  // Save HTML for manual inspection
  const outPath = path.join(__dirname, 'bullseye-firearms.html');
  fs.writeFileSync(outPath, result.html, 'utf-8');
  console.log(`HTML saved to ${outPath}\n`);

  const $ = cheerio.load(result.html);

  // ── 1. Check a.product elements ──────────────────────────────────────
  const productAnchors = $('a.product');
  console.log(`=== a.product elements: ${productAnchors.length} ===\n`);

  if (productAnchors.length > 0) {
    // Show first 5 with ALL attributes
    productAnchors.slice(0, 5).each((i, el) => {
      const elem = $(el);
      const attrs = el.attribs || {};
      console.log(`--- Product ${i + 1} ---`);
      console.log('  Attributes:', JSON.stringify(attrs, null, 2));
      console.log('  href:', attrs.href || 'NONE');
      console.log('  Text (first 100):', elem.text().trim().replace(/\s+/g, ' ').slice(0, 100));

      // Check child elements for IDs
      const children = elem.find('[id], [data-id], [data-product-id], [data-item-id], [data-sku]');
      if (children.length) {
        console.log('  Children with ID attrs:');
        children.each((_, child) => {
          console.log('    ', child.tagName, JSON.stringify(child.attribs));
        });
      }
      console.log('');
    });
  }

  // ── 2. Search for ANY data-*-id or id attributes on product-like elements ──
  console.log('=== Elements with data-*id attributes ===\n');
  const idSelectors = [
    '[data-product-id]',
    '[data-item-id]',
    '[data-id]',
    '[data-sku]',
    '[data-product]',
    '[data-pid]',
    '[data-productid]',
    '[data-entity-id]',
  ];
  for (const sel of idSelectors) {
    const found = $(sel);
    if (found.length > 0) {
      console.log(`  ${sel}: ${found.length} elements`);
      found.slice(0, 3).each((_, el) => {
        console.log('    ', el.tagName, JSON.stringify(el.attribs));
      });
    }
  }

  // ── 3. Analyze product URLs for numeric IDs ─────────────────────────
  console.log('\n=== Product URL patterns ===\n');
  const hrefs: string[] = [];
  productAnchors.each((_, el) => {
    const href = $(el).attr('href');
    if (href) hrefs.push(href);
  });

  // Also gather /shop/ links from anywhere
  $('a[href*="/shop/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !hrefs.includes(href)) hrefs.push(href);
  });

  const uniqueHrefs = [...new Set(hrefs)].slice(0, 20);
  console.log(`Sample product URLs (${uniqueHrefs.length} shown):`);
  for (const href of uniqueHrefs) {
    // Check for numeric patterns
    const numericMatch = href.match(/[-\/](\d{3,})/);
    console.log(`  ${href}  ${numericMatch ? `=> numeric ID: ${numericMatch[1]}` : '=> no numeric ID found'}`);
  }

  // ── 4. Check outer HTML of first product for full structure ─────────
  console.log('\n=== Full outer HTML of first a.product ===\n');
  const first = productAnchors.first();
  if (first.length) {
    const outerHtml = $.html(first);
    console.log(outerHtml.slice(0, 2000));
  }

  // ── 5. Check parent elements of a.product for IDs ──────────────────
  console.log('\n=== Parent elements of a.product ===\n');
  if (productAnchors.length > 0) {
    const firstProduct = productAnchors.first();
    let current = firstProduct.parent();
    for (let i = 0; i < 4 && current.length; i++) {
      const tag = current.prop('tagName');
      const attrs = current.get(0)?.attribs || {};
      console.log(`  Parent ${i + 1}: <${tag}> attrs=${JSON.stringify(attrs)}`);
      current = current.parent();
    }
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
