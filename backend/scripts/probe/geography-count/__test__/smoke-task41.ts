// Smoke test for Task 4.1 sitemap-parse against the 5 Tier-1 sites.
// Run: cd backend && npx tsx scripts/probe/geography-count/__test__/smoke-task41.ts
// Anti-ban: 2.5s delay between sites.

import { discoverProductSitemap } from '../sitemap-parse';

const SITES = [
  'https://canadafirstammo.ca',
  'https://aagcanada.ca',
  'https://theammosource.com',
  'https://bullseyenorth.com',
  'https://gunpost.ca',
];

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  for (const site of SITES) {
    const t0 = Date.now();
    process.stderr.write(`\n[${new Date().toISOString()}] probing ${site}...\n`);
    try {
      const r = await discoverProductSitemap(site);
      console.log(JSON.stringify({
        site,
        urls: r.productUrls.length,
        shards: r.shardsCounted.length,
        shardsCounted: r.shardsCounted,
        dupes: r.duplicateShardsByMd5,
        totalLocs: r.totalLocs,
        wafBailed: r.wafBailedOut,
        ms: Date.now() - t0,
        sample: r.productUrls.slice(0, 3),
      }, null, 2));
    } catch (e) {
      console.error(`ERR on ${site}:`, (e as Error).message);
    }
    await sleep(2500);  // anti-ban
  }
}

main();
