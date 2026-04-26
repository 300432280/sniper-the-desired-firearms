// Smoke test for sort-detect (Task 5.2)
// Expected results:
//   canadafirstammo.ca (WC + CF-passive) → sortParam ~= ?orderby=date
//   aagcanada.ca (Shopify + CF-passive) → sortParam ~= ?sort_by=created-descending
//   bullseyenorth.com (Celerant) → may return null (path-style sort /orderby/new-arrivals/)

import { runRoom1 } from '../../room1-intake';
import { runRoom2 } from '../../room2-access-identity';
import { runRoom3 } from '../../room3-geography-count';
import { detectSort } from '../sort-detect';

const SITES = [
  'https://canadafirstammo.ca/',
  'https://aagcanada.ca/',
  'https://bullseyenorth.com/',
];

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  for (const url of SITES) {
    const t0 = Date.now();
    process.stderr.write(`\n[${new Date().toISOString()}] === SORT DETECT: ${url} ===\n`);
    try {
      const r1 = await runRoom1(url);
      if ('roomFailed' in r1) { console.log(JSON.stringify({ site: url, fail: 'R1 ' + r1.reason })); await sleep(2500); continue; }
      const r2 = await runRoom2(r1);
      if ('roomFailed' in r2) { console.log(JSON.stringify({ site: url, fail: 'R2 ' + r2.reason })); await sleep(2500); continue; }
      const r3 = await runRoom3(r2);
      if ('roomFailed' in r3) { console.log(JSON.stringify({ site: url, fail: 'R3 ' + r3.reason })); await sleep(2500); continue; }
      const s = await detectSort(r3);
      console.log(JSON.stringify({
        site: url,
        platform: r2.platform,
        sortParam: s.sortParam,
        selectHtml: s.evidence.selectHtml.slice(0, 300),
        candidateParams: s.evidence.candidateParams,
        idJumpBefore: s.evidence.idJumpBefore?.split('/').pop(),
        idJumpAfter: s.evidence.idJumpAfter?.split('/').pop(),
        dateVerification: s.evidence.dateVerification,
        ms: Date.now() - t0,
      }, null, 2));
    } catch (e) {
      console.error(`ERR on ${url}:`, (e as Error).message);
    }
    await sleep(2500);
  }
}

main();
