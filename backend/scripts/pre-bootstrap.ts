// backend/scripts/pre-bootstrap.ts
// Orchestrator. Composes Intake / Access&Identity / Geography&Count / Navigation stages.
// Writes profile JSON + human report. No detection logic.
// Bug R2-3 fix: explicit cleanup (Playwright browser + Redis) before exit.

import { runIntake } from './probe/intake';
import { runAccessIdentity } from './probe/access-identity';
import { runGeographyCount } from './probe/geography-count';
import { runNavigation } from './probe/navigation';
import { closeBrowser } from '../src/services/scraper/playwright-fetcher';
import { redisConnection } from '../src/services/queue';
import * as fs from 'fs/promises';
import * as path from 'path';

// Resolve relative to this script's location, NOT process.cwd() — so the
// orchestrator works whether invoked from project root, backend/, or anywhere.
// __dirname here is backend/scripts/ at runtime under tsx (CJS).
const OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'docs', 'pre-bootstrap-output');

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('Usage: npx tsx backend/scripts/pre-bootstrap.ts <url>'); process.exit(2); }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let state: any = await runIntake(url);
  if ('stageFailed' in state) return halt(state, url);

  state = await runAccessIdentity(state);
  if ('stageFailed' in state) return halt(state, url);

  state = await runGeographyCount(state);
  if ('stageFailed' in state) return halt(state, url);

  state = await runNavigation(state);
  if ('stageFailed' in state) return halt(state, url);

  const domain = new URL(state.canonicalOrigin).hostname;
  const profilePath = path.join(OUTPUT_DIR, `${domain}-profile.json`);
  const reportPath = path.join(OUTPUT_DIR, `${domain}-report.md`);
  await fs.writeFile(profilePath, JSON.stringify(state, null, 2));
  await fs.writeFile(reportPath, renderReport(state));
  console.log(`✓ ${domain}: probe complete`);
  console.log(`  profile: ${profilePath}`);
  console.log(`  report:  ${reportPath}`);

  await cleanup();
}

async function halt(failure: any, url: string) {
  const safeName = url.replace(/[^a-z0-9]/gi, '_');
  const failPath = path.join(OUTPUT_DIR, `${safeName}-FAILURE.json`);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(failPath, JSON.stringify(failure, null, 2));
  console.error(`✗ Stage ${failure.stageNumber} HARD FAIL: ${failure.reason}`);
  console.error(`  evidence: ${failPath}`);
  await cleanup();
  process.exit(1);
}

/** Bug R2-3: Close Playwright browser + disconnect Redis so the process can exit cleanly. */
async function cleanup() {
  const CLEANUP_TIMEOUT = 5000; // 5s max for cleanup
  try {
    await Promise.race([
      Promise.allSettled([
        closeBrowser().catch(() => {}),
        redisConnection.quit().catch(() => {}),
      ]),
      new Promise(resolve => setTimeout(resolve, CLEANUP_TIMEOUT)),
    ]);
  } catch {
    // Best-effort cleanup — don't let cleanup failures block exit
  }
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

main().catch(async err => { console.error(err); await cleanup(); process.exit(1); });
