// Smoke test for watermark-method + Room 4 composer (Task 5.3)
// Expected results:
//   canadafirstammo.ca (WC + CF-passive) → Method A (WP REST ?after= filter) or B
//   aagcanada.ca (Shopify + CF-passive)  → Method A (Shopify published_at)
//   bullseyenorth.com (Celerant)         → Method B if dates in listing, else C

import { runRoom1 } from '../../room1-intake';
import { runRoom2 } from '../../room2-access-identity';
import { runRoom3 } from '../../room3-geography-count';
import { runRoom4 } from '../index';

const SITES = [
  'https://canadafirstammo.ca/',
  'https://aagcanada.ca/',
  'https://bullseyenorth.com/',
];

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  for (const url of SITES) {
    const t0 = Date.now();
    process.stderr.write(`\n[${new Date().toISOString()}] === ROOM 4: ${url} ===\n`);
    try {
      const r1 = await runRoom1(url);
      if ('roomFailed' in r1) { console.log(JSON.stringify({ site: url, fail: 'R1 ' + r1.reason })); await sleep(2500); continue; }
      const r2 = await runRoom2(r1);
      if ('roomFailed' in r2) { console.log(JSON.stringify({ site: url, fail: 'R2 ' + r2.reason })); await sleep(2500); continue; }
      const r3 = await runRoom3(r2);
      if ('roomFailed' in r3) { console.log(JSON.stringify({ site: url, fail: 'R3 ' + r3.reason })); await sleep(2500); continue; }
      const r4 = await runRoom4(r3);
      if ('roomFailed' in r4) { console.log(JSON.stringify({ site: url, fail: 'R4 ' + r4.reason })); await sleep(2500); continue; }
      console.log(JSON.stringify({
        site: url,
        platform: r4.platform,
        paginationType: r4.paginationPattern.type,
        paginationPerPage: r4.paginationPattern.perPage,
        sortParam: r4.sortParam,
        watermarkMethod: r4.watermarkMethod,
        watermarkReason: r4.watermarkMethodSelection.reason,
        dateSourceForMethodA: r4.watermarkMethodSelection.dateSourceForMethodA ?? null,
        urlSortVerifiedForMethodB: r4.watermarkMethodSelection.urlSortVerifiedForMethodB ?? null,
        fallbackToMethodCReason: r4.watermarkMethodSelection.fallbackToMethodCReason ?? null,
        dateVerification: r4.sortEvidence.dateVerification
          ? {
              method: r4.sortEvidence.dateVerification.method,
              dates: [
                r4.sortEvidence.dateVerification.page1FirstDate,
                r4.sortEvidence.dateVerification.page1SecondDate,
                r4.sortEvidence.dateVerification.page1ThirdDate,
              ].filter(Boolean),
              monotonicallyDecreasing: r4.sortEvidence.dateVerification.monotonicallyDecreasing,
            }
          : null,
        ms: Date.now() - t0,
      }, null, 2));
    } catch (e) {
      console.error(`ERR on ${url}:`, (e as Error).message);
    }
    await sleep(2500);
  }
}

main();
