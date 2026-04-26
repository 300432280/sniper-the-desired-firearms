// backend/scripts/pre-bootstrap.ts
// Orchestrator. Composes Rooms 1-4. Writes profile JSON + human report. No detection logic.

import { runRoom1 } from './probe/room1-intake';
import { runRoom2 } from './probe/room2-access-identity';
import { runRoom3 } from './probe/room3-geography-count';
import { runRoom4 } from './probe/room4-navigation';
import * as fs from 'fs/promises';
import * as path from 'path';

const OUTPUT_DIR = path.join(process.cwd(), '..', 'docs', 'pre-bootstrap-output');

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('Usage: npx tsx backend/scripts/pre-bootstrap.ts <url>'); process.exit(2); }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let state: any = await runRoom1(url);
  if ('roomFailed' in state) return halt(state, url);

  state = await runRoom2(state);
  if ('roomFailed' in state) return halt(state, url);

  state = await runRoom3(state);
  if ('roomFailed' in state) return halt(state, url);

  state = await runRoom4(state);
  if ('roomFailed' in state) return halt(state, url);

  const domain = new URL(state.canonicalOrigin).hostname;
  const profilePath = path.join(OUTPUT_DIR, `${domain}-profile.json`);
  const reportPath = path.join(OUTPUT_DIR, `${domain}-report.md`);
  await fs.writeFile(profilePath, JSON.stringify(state, null, 2));
  await fs.writeFile(reportPath, renderReport(state));
  console.log(`✓ ${domain}: probe complete`);
  console.log(`  profile: ${profilePath}`);
  console.log(`  report:  ${reportPath}`);
}

async function halt(failure: any, url: string) {
  const safeName = url.replace(/[^a-z0-9]/gi, '_');
  const failPath = path.join(OUTPUT_DIR, `${safeName}-FAILURE.json`);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(failPath, JSON.stringify(failure, null, 2));
  console.error(`✗ Room ${failure.roomNumber} HARD FAIL: ${failure.reason}`);
  console.error(`  evidence: ${failPath}`);
  process.exit(1);
}

function renderReport(s: any): string {
  return `# Pre-Bootstrap Probe Report — ${new URL(s.canonicalOrigin).hostname}

**Run:** ${s.runId} at ${s.timestamp}

## Access & Identity
- Canonical origin: \`${s.canonicalOrigin}\`
- WAF: \`${s.wafType ?? 'none'}\` (hasWaf: ${s.hasWaf})
- Platform: \`${s.platform}\`
- Access method: \`${s.accessMethod}\`
- needsPlaywright: ${s.needsPlaywright}

## Geography & Count
- Global count: **${s.globalProductCount}** via \`${s.globalProductCountMethod}\`
- catalogUrls (${s.catalogUrls.length}): ${s.catalogUrls.slice(0, 5).map((u:string) => `\`${u}\``).join(', ')}${s.catalogUrls.length > 5 ? `, ... (+${s.catalogUrls.length - 5})` : ''}
- Walked unique: ${s.walkedUniqueCount}
- Drift: ${s.driftPct.toFixed(2)}%

## Navigation
- Pagination: \`${s.paginationPattern.type}\` perPage=${s.paginationPattern.perPage}
- Sort: \`${s.sortParam ?? 'none'}\`
- Watermark method: **${s.watermarkMethod}**

## Next step

Review this report. If acceptable, run:
\`\`\`
npx tsx backend/scripts/bootstrap.ts ${new URL(s.canonicalOrigin).hostname}
\`\`\`
`;
}

main().catch(err => { console.error(err); process.exit(1); });
