// backend/scripts/probe/__test__/dry-run-smoke.ts
// Per spec §8.3 Tier-1 smoke. Run every commit that touches a probe-stage module.
import { spawnSync } from 'child_process';

const SITES = [
  'https://canadafirstammo.ca/',
  'https://aagcanada.ca/',
  'https://theammosource.com/',
  'https://bullseyenorth.com/',
  'https://gunpost.ca/',
];

let pass = 0, fail = 0;
const results: Array<{ url: string; status: number | null }> = [];
for (const url of SITES) {
  process.stdout.write(`\n=== ${url} ===\n`);
  const r = spawnSync('npx', ['tsx', 'scripts/pre-bootstrap.ts', url], {
    stdio: 'inherit',
    cwd: 'backend',
    timeout: 600_000,  // 10 min per site
  });
  if (r.status === 0) pass++; else fail++;
  results.push({ url, status: r.status });
}
console.log(`\n========== SMOKE SUMMARY ==========`);
for (const r of results) console.log(`  ${r.status === 0 ? '✓' : '✗'} ${r.url} (status=${r.status})`);
console.log(`SMOKE: ${pass}/${SITES.length} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
