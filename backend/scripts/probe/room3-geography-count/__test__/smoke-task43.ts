import { runRoom1 } from '../../room1-intake';
import { runRoom2 } from '../../room2-access-identity';
import { discoverCatalogUrls } from '../catalog-urls';

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
      const r1 = await runRoom1(url);
      if ('roomFailed' in r1) { console.log(JSON.stringify({ site: url, fail: 'R1 ' + r1.reason })); await sleep(2500); continue; }
      const r2 = await runRoom2(r1);
      if ('roomFailed' in r2) { console.log(JSON.stringify({ site: url, fail: 'R2 ' + r2.reason })); await sleep(2500); continue; }
      const c = await discoverCatalogUrls(r2);
      const urls = c.candidates.map(cc => cc.url);
      console.log(JSON.stringify({ site: url, platform: r2.platform, source: c.source, count: urls.length, sample: urls.slice(0, 5), ms: Date.now() - t0 }, null, 2));
    } catch (e) {
      console.error(`ERR on ${url}:`, (e as Error).message);
    }
    await sleep(2500);
  }
}
main();
