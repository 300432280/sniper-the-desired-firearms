// Smoke test for sort-detect (Task 5.2)
// Expected results:
//   canadafirstammo.ca (WC + CF-passive) → sortParam ~= ?orderby=date
//   aagcanada.ca (Shopify + CF-passive) → sortParam ~= ?sort_by=created-descending
//   bullseyenorth.com (Celerant) → may return null (path-style sort /orderby/new-arrivals/)

import { runIntake } from '../../intake';
import { runAccessIdentity } from '../../access-identity';
import { runGeographyCount } from '../../geography-count';
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
      const r1 = await runIntake(url);
      if ('stageFailed' in r1) { console.log(JSON.stringify({ site: url, fail: 'Intake ' + r1.reason })); await sleep(2500); continue; }
      const r2 = await runAccessIdentity(r1);
      if ('stageFailed' in r2) { console.log(JSON.stringify({ site: url, fail: 'Access&Identity ' + r2.reason })); await sleep(2500); continue; }
      const r3 = await runGeographyCount(r2);
      if ('stageFailed' in r3) { console.log(JSON.stringify({ site: url, fail: 'Geography&Count ' + r3.reason })); await sleep(2500); continue; }
      const s = await detectSort(r3);
      console.log(JSON.stringify({
        site: url,
        platform: r2.platform,
        sortParam: s.sortParam,
        selectHtml: s.evidence.selectHtml.slice(0, 300),
        candidateParams: s.evidence.candidateParams,
        // Display the URL slug — strip trailing slash first since many platforms
        // (WC, BC Stencil) emit `/product/<slug>/` and `.split('/').pop()` on
        // a trailing-slash URL returns '' which looks like extraction failed.
        idJumpBefore: s.evidence.idJumpBefore?.replace(/\/$/, '').split('/').pop(),
        idJumpAfter: s.evidence.idJumpAfter?.replace(/\/$/, '').split('/').pop(),
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
