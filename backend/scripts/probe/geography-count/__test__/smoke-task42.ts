import { runIntake } from '../../intake';
import { runAccessIdentity } from '../../access-identity';
import { getGlobalCount } from '../global-count';

const SITES = [
  'https://canadafirstammo.ca/',
  'https://aagcanada.ca/',
  'https://theammosource.com/',
  'https://bullseyenorth.com/',
  'https://gunpost.ca/',
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
      const c = await getGlobalCount(r2);
      console.log(JSON.stringify({ site: url, platform: r2.platform, count: c?.count ?? null, method: c?.method ?? null, ms: Date.now() - t0, evidence: c?.evidence }, null, 2));
    } catch (e) {
      console.error(`ERR on ${url}:`, (e as Error).message);
    }
    await sleep(2500);
  }
}
main();
