// Targeted smoke for Drupal-classifieds generic infrastructure.
// Validates: discoverDrupalViewsCatalogs (form-action discovery) +
// extract.ts platform-aware dispatch to GunpostAdapter for drupal-commerce.

import { runIntake } from '../../intake';
import { runAccessIdentity } from '../../access-identity';
import { runGeographyCount } from '..';

const SITES = [
  'https://gunpost.ca/',           // Drupal-classifieds (the new test target)
  'https://canadafirstammo.ca/',   // WC regression
  'https://aagcanada.ca/',         // Shopify regression (skip walk — too slow)
];

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  for (const url of SITES) {
    const t0 = Date.now();
    process.stderr.write(`\n[${new Date().toISOString()}] ${url}\n`);
    try {
      const r1 = await runIntake(url);
      if ('stageFailed' in r1) { console.log(JSON.stringify({ site: url, fail: 'Intake ' + r1.reason })); await sleep(2500); continue; }
      const r2 = await runAccessIdentity(r1);
      if ('stageFailed' in r2) { console.log(JSON.stringify({ site: url, fail: 'Access&Identity ' + r2.reason })); await sleep(2500); continue; }
      const r3 = await runGeographyCount(r2);
      if ('stageFailed' in r3) {
        console.log(JSON.stringify({ site: url, fail: `Geography&Count ${r3.reason}`, evidence: r3.evidence, ms: Date.now() - t0 }, null, 2));
      } else {
        console.log(JSON.stringify({
          site: url,
          platform: r2.platform,
          catalogUrlSource: r3.catalogUrlSource,
          catalogUrls: r3.catalogUrls.length,
          catalogUrlsList: r3.catalogUrls,
          walkedUniqueCount: r3.walkedUniqueCount,
          globalProductCount: r3.globalProductCount,
          globalProductCountMethod: r3.globalProductCountMethod,
          driftPct: r3.driftPct.toFixed(2) + '%',
          coverageStrategy: r3.coverageStrategy,
          walkCounts: r3.catalogUrlWalkCounts.slice(0, 3),
          ms: Date.now() - t0,
        }, null, 2));
      }
    } catch (e) {
      console.error(`ERR on ${url}:`, (e as Error).message);
    }
    await sleep(2500);
  }
}
main();
