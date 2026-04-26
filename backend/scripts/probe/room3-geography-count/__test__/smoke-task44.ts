import { runRoom1 } from '../../room1-intake';
import { runRoom2 } from '../../room2-access-identity';
import { runRoom3 } from '..';

const SITES = [
  'https://canadafirstammo.ca/',
  'https://aagcanada.ca/',
  'https://bullseyenorth.com/',
];
// NOTE: theammosource.com (47K products, 27 catalogUrls) and gunpost.ca (Drupal-classifieds, 0 catalogUrls
// from Task 4.3 = R3 hard-fail) are intentionally excluded from this smoke. They WILL be run in Phase 8
// Tier-2 fleet regression with proper budgets. theammosource alone takes ~30 min for full walk; gunpost
// is the documented Mistake 37 deferral.

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  for (const url of SITES) {
    const t0 = Date.now();
    process.stderr.write(`\n[${new Date().toISOString()}] ${url}\n`);
    try {
      const r1 = await runRoom1(url);
      if ('roomFailed' in r1) { console.log(JSON.stringify({ site: url, fail: 'R1 ' + r1.reason })); await sleep(2500); continue; }
      const r2 = await runRoom2(r1);
      if ('roomFailed' in r2) { console.log(JSON.stringify({ site: url, fail: 'R2 ' + r2.reason })); await sleep(2500); continue; }
      const r3 = await runRoom3(r2);
      if ('roomFailed' in r3) {
        console.log(JSON.stringify({ site: url, fail: `R3 ${r3.reason}`, evidence: r3.evidence, ms: Date.now() - t0 }, null, 2));
      } else {
        console.log(JSON.stringify({
          site: url,
          platform: r2.platform,
          catalogUrlSource: r3.catalogUrlSource,
          catalogUrls: r3.catalogUrls.length,
          walkedUniqueCount: r3.walkedUniqueCount,
          globalProductCount: r3.globalProductCount,
          globalProductCountMethod: r3.globalProductCountMethod,
          driftPct: r3.driftPct.toFixed(2) + '%',
          coverageStrategy: r3.coverageStrategy,
          walkCounts: r3.catalogUrlWalkCounts.slice(0, 5),  // first 5 for brevity
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
