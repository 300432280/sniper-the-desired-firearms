/**
 * Site Verification Script
 *
 * For each monitored site, checks ProductIndex coverage:
 * - Total products, tag coverage, price/stock/thumbnail fill rates
 * - Runs standard keyword searches and reports match counts
 * - Flags missing data (no tags, no price, no stock)
 *
 * Usage:
 *   node scripts/verify-site.js                    # all enabled sites
 *   node scripts/verify-site.js bullseyenorth.com  # single site
 */

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

// ── Standard test keywords that cover all product categories ─────────────────
const TEST_KEYWORDS = [
  // Firearms
  { keyword: 'sks', category: 'firearm' },
  { keyword: 'shotgun', category: 'firearm' },
  { keyword: 'rifle', category: 'firearm' },
  { keyword: '22lr', category: 'firearm' },
  // Ammunition
  { keyword: '9mm', category: 'ammunition' },
  { keyword: '308', category: 'ammunition' },
  { keyword: 'federal', category: 'ammunition' },
  // Optics
  { keyword: 'scope', category: 'optics' },
  { keyword: 'vortex', category: 'optics' },
  // Parts & Accessories
  { keyword: 'magazine', category: 'parts' },
  { keyword: 'holster', category: 'gear' },
];

// ── Replicate keyword matcher logic ─────────────────────────────────────────

async function expandKeyword(keyword) {
  const normalized = keyword.toLowerCase().trim();
  const alias = await p.keywordAlias.findUnique({
    where: { alias: normalized },
    include: { group: { include: { aliases: true } } },
  });
  if (alias) return alias.group.aliases.map(a => a.alias);
  return [normalized];
}

function matchesKeyword(title, keyword) {
  const titleLower = title.toLowerCase();
  const kw = keyword.toLowerCase();
  const idx = titleLower.indexOf(kw);
  if (idx === -1) return false;
  const charBefore = idx > 0 ? titleLower[idx - 1] : ' ';
  return !/[a-z0-9]/i.test(charBefore);
}

function matchesMultiWord(title, keyword, extras) {
  const combined = [title, extras?.tags || '', extras?.urlSlug || ''].join(' ');
  if (matchesKeyword(combined, keyword)) return true;
  const words = keyword.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  if (words.length <= 1) return false;
  return words.every(word => matchesKeyword(combined, word));
}

async function searchProductIndex(keyword, siteId) {
  const aliases = await expandKeyword(keyword);

  const sqlTerms = new Set(aliases);
  for (const alias of aliases) {
    const words = alias.split(/\s+/).filter(w => w.length >= 2);
    if (words.length > 1) {
      for (const word of words) {
        sqlTerms.add(word);
        const wordAliases = await expandKeyword(word);
        for (const wa of wordAliases) sqlTerms.add(wa);
      }
    }
  }

  const products = await p.productIndex.findMany({
    where: {
      isActive: true,
      siteId,
      OR: [...sqlTerms].flatMap(term => [
        { title: { contains: term, mode: 'insensitive' } },
        { tags: { contains: term, mode: 'insensitive' } },
        { url: { contains: term, mode: 'insensitive' } },
      ]),
    },
    orderBy: { firstSeenAt: 'desc' },
    take: 500,
  });

  return products.filter(prod => {
    const urlSlug = prod.url.split('/').pop()?.replace(/-/g, ' ') || '';
    return aliases.some(alias =>
      matchesMultiWord(prod.title, alias, { tags: prod.tags, urlSlug })
    );
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const targetDomain = process.argv[2];

  const where = { isEnabled: true };
  if (targetDomain) where.domain = targetDomain;

  const sites = await p.monitoredSite.findMany({ where, orderBy: { domain: 'asc' } });
  if (sites.length === 0) {
    console.log(targetDomain ? `Site "${targetDomain}" not found or not enabled` : 'No enabled sites');
    process.exit(1);
  }

  for (const site of sites) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  ${site.name} (${site.domain})`);
    console.log(`  Adapter: ${site.adapterType} | Category: ${site.siteCategory}`);
    console.log(`${'='.repeat(70)}`);

    // DB stats
    const totalProducts = await p.productIndex.count({ where: { siteId: site.id } });
    const activeProducts = await p.productIndex.count({ where: { siteId: site.id, isActive: true } });
    const withTags = await p.productIndex.count({ where: { siteId: site.id, tags: { not: null } } });
    const withPrice = await p.productIndex.count({ where: { siteId: site.id, price: { not: null } } });
    const withThumbnail = await p.productIndex.count({ where: { siteId: site.id, thumbnail: { not: null } } });
    const withType = await p.productIndex.count({ where: { siteId: site.id, productType: { not: null } } });
    const inStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'in_stock' } });
    const outOfStock = await p.productIndex.count({ where: { siteId: site.id, stockStatus: 'out_of_stock' } });
    const unknownStock = await p.productIndex.count({ where: { siteId: site.id, OR: [{ stockStatus: null }, { stockStatus: 'unknown' }] } });
    const withRegularPrice = await p.productIndex.count({ where: { siteId: site.id, regularPrice: { not: null } } });

    console.log(`\n  DB Stats:`);
    console.log(`    Products:     ${activeProducts} active / ${totalProducts} total`);
    console.log(`    Tags:         ${withTags}/${totalProducts} (${pct(withTags, totalProducts)})`);
    console.log(`    Price:        ${withPrice}/${totalProducts} (${pct(withPrice, totalProducts)})`);
    console.log(`    RegularPrice: ${withRegularPrice}/${totalProducts} (${pct(withRegularPrice, totalProducts)}) -- sale items`);
    console.log(`    Thumbnail:    ${withThumbnail}/${totalProducts} (${pct(withThumbnail, totalProducts)})`);
    console.log(`    ProductType:  ${withType}/${totalProducts} (${pct(withType, totalProducts)})`);
    console.log(`    Stock: ${inStock} in_stock, ${outOfStock} out_of_stock, ${unknownStock} unknown`);

    // Product type breakdown
    const typeBreakdown = await p.productIndex.groupBy({
      by: ['productType'],
      where: { siteId: site.id },
      _count: true,
    });
    if (typeBreakdown.length > 0) {
      console.log(`    Types: ${typeBreakdown.map(t => `${t.productType || 'null'}(${t._count})`).join(', ')}`);
    }

    // Tag breakdown
    const tagBreakdown = await p.productIndex.groupBy({
      by: ['tags'],
      where: { siteId: site.id, tags: { not: null } },
      _count: true,
      orderBy: { _count: { tags: 'desc' } },
      take: 10,
    });
    if (tagBreakdown.length > 0) {
      console.log(`    Tags: ${tagBreakdown.map(t => `${t.tags}(${t._count})`).join(', ')}`);
    }

    // Keyword search tests
    console.log(`\n  Keyword Search Tests:`);
    console.log(`    ${'Keyword'.padEnd(20)} ${'Matches'.padStart(8)}`);
    console.log(`    ${'─'.repeat(30)}`);

    for (const test of TEST_KEYWORDS) {
      const matches = await searchProductIndex(test.keyword, site.id);
      const flag = matches.length === 0 ? ' X' : ' OK';
      console.log(`    ${test.keyword.padEnd(20)} ${String(matches.length).padStart(8)}${flag}`);
    }

    // Sample products missing data
    const sampleMissingPrice = await p.productIndex.findMany({
      where: { siteId: site.id, isActive: true, price: null },
      take: 3,
      select: { title: true },
    });
    if (sampleMissingPrice.length > 0) {
      console.log(`\n  WARNING: Sample products missing price:`);
      for (const s of sampleMissingPrice) {
        console.log(`    - ${s.title.slice(0, 60)}`);
      }
    }

    if (withTags === 0 && totalProducts > 0) {
      console.log(`\n  WARNING: No products have tags -- category search will not work`);
    }
  }

  console.log('\n');
  await p.$disconnect();
})();

function pct(n, total) {
  if (total === 0) return '0%';
  return Math.round(n / total * 100) + '%';
}
