// Smoke test for pagination-detect (Task 5.1)
// Expected results:
//   canadafirstammo.ca (WC + CF-passive) → path /page/{N} or query page
//   aagcanada.ca (Shopify + CF-passive) → query page
//   bullseyenorth.com (Celerant) → path /page/{N}

import { runIntake } from '../../intake';
import { runAccessIdentity } from '../../access-identity';
import { runGeographyCount } from '../../geography-count';
import { detectPagination } from '../../geography-count/pagination-detect';

const SITES = [
  'https://canadafirstammo.ca/',
  'https://aagcanada.ca/',
  'https://bullseyenorth.com/',
];

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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
      if ('stageFailed' in r3) { console.log(JSON.stringify({ site: url, fail: 'Geography&Count ' + r3.reason })); await sleep(2500); continue; }
      const p = await detectPagination(r3);
      console.log(JSON.stringify({
        site: url,
        platform: r2.platform,
        paginationType: p.pattern.type,
        template: p.pattern.template,
        match: p.pattern.match,
        perPage: p.pattern.perPage,
        totalPages: p.evidence.totalPagesEstimate,
        totalPagesSource: p.evidence.totalPagesSource,
        tests: {
          A: p.evidence.testA_page1_vs_page2.passed,
          B: p.evidence.testB_pageN_vs_pageN_1.passed,
          C: p.evidence.testC_overflow_vs_page1.passed,
          D: p.evidence.testD_perPage_sanity.passed,
        },
        ms: Date.now() - t0,
      }, null, 2));
    } catch (e) {
      console.error(`ERR on ${url}:`, (e as Error).message);
    }
    await sleep(2500);
  }
}

main();
