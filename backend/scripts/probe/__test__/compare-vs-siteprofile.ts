// backend/scripts/probe/__test__/compare-vs-siteprofile.ts
// Per-stage validation harness: diff disk profile.json (output of new pipeline)
// against MonitoredSite.siteProfile (DB validated ground truth).
//
// Per memory rule `feedback_per_room_ground_truth.md`: every stage must be
// diffed against validated DB siteProfile WHEN completed. siteProfile is the
// answer key — never modify it; investigate code when there's a mismatch.
//
// Usage (from backend/):
//   npx tsx scripts/probe/__test__/compare-vs-siteprofile.ts canadafirstammo.ca
//   npx tsx scripts/probe/__test__/compare-vs-siteprofile.ts --all   # all profiles in docs/pre-bootstrap-output/

import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../../../src/lib/prisma';

type Verdict = 'MATCH' | 'CONFLICT' | 'PIPELINE-ONLY' | 'DB-ONLY' | 'N/A';
type Row = { field: string; pipeline: string; db: string; verdict: Verdict };

const OUTPUT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'pre-bootstrap-output');

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n - 1) + '…';
  return s + ' '.repeat(n - s.length);
}

function compare(pipeline: string | undefined, db: string | undefined): Verdict {
  if (pipeline == null && db == null) return 'N/A';
  if (pipeline == null) return 'DB-ONLY';
  if (db == null) return 'PIPELINE-ONLY';
  return pipeline === db ? 'MATCH' : 'CONFLICT';
}

function fmt(v: unknown): string {
  if (v == null) return '<null>';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 80);
}

async function compareDomain(domain: string): Promise<void> {
  const profilePath = path.join(OUTPUT_DIR, `${domain}-profile.json`);
  if (!fs.existsSync(profilePath)) {
    console.log(`\n${domain}: NO disk profile (run pre-bootstrap.ts first)`);
    return;
  }
  const pipeline = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  const dbSite = await prisma.monitoredSite.findUnique({
    where: { domain },
    select: {
      domain: true, adapterType: true, hasWaf: true, requiresSucuri: true,
      lastWatermarkUrl: true, isEnabled: true, crawlPhase: true, siteProfile: true,
      _count: { select: { products: true } },
    },
  });
  if (!dbSite) {
    console.log(`\n${domain}: NOT in DB (new site — no comparison possible)`);
    return;
  }
  const sp = (dbSite.siteProfile as Record<string, unknown>) ?? {};
  const crawlers = (sp.crawlers as Record<string, unknown>) ?? {};
  const watermark = (crawlers.watermark as Record<string, unknown>) ?? {};
  const dbPagination = sp.paginationPattern as Record<string, unknown> | undefined;
  const dbCatalogUrls = (sp.catalogUrls as string[]) ?? [];
  const pipelineCatalogUrls: string[] = pipeline.catalogUrls ?? [];

  const rows: Row[] = [
    { field: 'platform', pipeline: fmt(pipeline.platform), db: fmt(sp.platform), verdict: compare(String(pipeline.platform), String(sp.platform)) },
    { field: 'adapter', pipeline: fmt(pipeline.platformMarker?.detectorId ?? pipeline.platform), db: fmt(sp.adapter ?? dbSite.adapterType), verdict: 'N/A' },
    { field: 'wafType', pipeline: fmt(pipeline.wafType), db: fmt(sp.wafType), verdict: compare(String(pipeline.wafType), String(sp.wafType)) },
    { field: 'hasWaf', pipeline: fmt(pipeline.hasWaf), db: fmt(dbSite.hasWaf), verdict: compare(String(pipeline.hasWaf), String(dbSite.hasWaf)) },
    { field: 'sortParam', pipeline: fmt(pipeline.sortParam), db: fmt(sp.sortParam), verdict: compare(String(pipeline.sortParam), String(sp.sortParam)) },
    { field: 'paginationType', pipeline: fmt(pipeline.paginationPattern?.type), db: fmt(dbPagination?.type), verdict: compare(String(pipeline.paginationPattern?.type), String(dbPagination?.type)) },
    { field: 'paginationTemplate', pipeline: fmt(pipeline.paginationPattern?.template), db: fmt(dbPagination?.template), verdict: 'N/A' },
    { field: 'paginationPerPage', pipeline: fmt(pipeline.paginationPattern?.perPage), db: fmt(dbPagination?.perPage), verdict: 'N/A' },
    { field: 'watermarkMethod', pipeline: fmt(pipeline.watermarkMethod), db: fmt(watermark.method), verdict: compare(String(pipeline.watermarkMethod), String(watermark.method)) },
    { field: 'catalogUrls.count', pipeline: String(pipelineCatalogUrls.length), db: String(dbCatalogUrls.length), verdict: pipelineCatalogUrls.length === dbCatalogUrls.length ? 'MATCH' : 'CONFLICT' },
    { field: 'globalProductCount', pipeline: fmt(pipeline.globalProductCount), db: `DB:${dbSite._count.products}, audit:${sp.expectedProductCount ?? '?'}`, verdict: 'N/A' },
    { field: 'walkedUniqueCount', pipeline: fmt(pipeline.walkedUniqueCount), db: '(walk-only metric)', verdict: 'N/A' },
    { field: 'driftPct', pipeline: fmt(pipeline.driftPct), db: '(target ≤ 5%)', verdict: 'N/A' },
  ];

  // catalogUrl set diff (paths only — strip origin)
  const stripOrigin = (u: string) => { try { return new URL(u, 'https://x').pathname; } catch { return u; } };
  const pipePaths = new Set(pipelineCatalogUrls.map(stripOrigin));
  const dbPaths = new Set(dbCatalogUrls.map(stripOrigin));
  const dbOnly = [...dbPaths].filter(p => !pipePaths.has(p));
  const pipeOnly = [...pipePaths].filter(p => !dbPaths.has(p));

  console.log(`\n=== ${domain} ===`);
  console.log(pad('FIELD', 28) + pad('PIPELINE', 50) + pad('DB siteProfile', 50) + 'VERDICT');
  console.log('-'.repeat(140));
  for (const r of rows) console.log(pad(r.field, 28) + pad(r.pipeline, 50) + pad(r.db, 50) + r.verdict);
  console.log(`\nCatalog URL diff (paths):`);
  console.log(`  DB-ONLY (missing from pipeline): ${dbOnly.length === 0 ? 'none' : dbOnly.join(', ')}`);
  console.log(`  PIPELINE-ONLY (extra vs DB):     ${pipeOnly.length === 0 ? 'none' : pipeOnly.join(', ')}`);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx compare-vs-siteprofile.ts <domain> | --all');
    process.exit(2);
  }
  if (arg === '--all') {
    const profileFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('-profile.json'));
    for (const f of profileFiles) {
      const domain = f.replace(/-profile\.json$/, '');
      await compareDomain(domain);
    }
  } else {
    await compareDomain(arg);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
