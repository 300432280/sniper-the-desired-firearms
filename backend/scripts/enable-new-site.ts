// backend/scripts/enable-new-site.ts
/**
 * enable-new-site — post-review DB insert + one-shot bootstrap.
 *
 * Prereq: audit-review-pipeline.ts has approved the candidate profile.
 *
 * Steps:
 *   1. Load approved profile JSON
 *   2. INSERT MonitoredSite (isEnabled=false, hasWaf from profile, adapterType from profile)
 *   3. Enqueue ONE catalog-crawler pass via existing BullMQ queue
 *   4. Wait for completion (poll job status; max 10 min)
 *   5. Verify ProductIndex count >= 50% of expectedProductCount
 *   6. If PASS: flip isEnabled=true, log success
 *   7. If FAIL: leave disabled, surface to operator
 *
 * CLI:
 *   npx tsx backend/scripts/enable-new-site.ts <approved-profile-json-path>
 *   npx tsx backend/scripts/enable-new-site.ts <approved-profile-json-path> --dry-run
 *
 * Exit codes:
 *   0 — success (PASS or dry-run completed)
 *   1 — bootstrap walk failed verification
 *   2 — site already exists; use audit-update flow
 *   3 — generic error
 *   4 — review JSON missing or not approved
 */

import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../src/lib/prisma';
import { scrapeQueue } from '../src/services/queue';

async function main() {
  const args = process.argv.slice(2);
  const profilePath = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');

  if (!profilePath) {
    console.error('Usage: npx tsx backend/scripts/enable-new-site.ts <profile-json> [--dry-run]');
    process.exit(3);
  }

  // Load profile
  const resolved = path.resolve(profilePath);
  const profile = JSON.parse(fs.readFileSync(resolved, 'utf-8'));

  // Derive domain + url from profile
  const firstCatUrl = (profile.catalogUrls ?? [])[0] ?? profile.canonicalUrl;
  if (!firstCatUrl) { console.error('Profile has no catalogUrls or canonicalUrl'); process.exit(3); }
  const parsed = new URL(firstCatUrl);
  const domain = profile.canonicalDomain ?? parsed.hostname.replace(/^www\./, '');
  const siteUrl = profile.canonicalUrl ?? `${parsed.protocol}//${parsed.host}`;
  const siteName = profile.siteName ?? domain;

  // Check sibling review JSON
  const reviewPath = resolved.replace(/\.json$/, '-review.json');
  if (!fs.existsSync(reviewPath)) {
    console.error(`No review file found at ${reviewPath}; run audit-review-pipeline.ts first`);
    process.exit(4);
  }
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf-8'));
  if (review.approvedForDbWrite !== true) {
    console.error('Profile not approved (approvedForDbWrite: false); operator must approve via --approve flag');
    process.exit(4);
  }

  // Check if site already exists
  const existing = await prisma.monitoredSite.findUnique({ where: { domain } });
  if (existing) {
    console.error(`Site '${domain}' already exists (id=${existing.id}); use existing audit-update flow`);
    if (dryRun) console.log(`Dry-run: site already exists -- exit 2 is correct behavior`);
    await prisma.$disconnect();
    process.exit(2);
  }

  // Build row data
  const data = {
    domain,
    name: siteName,
    url: siteUrl,
    siteType: profile.siteType ?? 'retailer',
    adapterType: profile.adapterType ?? 'generic',
    hasWaf: profile.hasWaf ?? false,
    siteProfile: profile,
    isEnabled: false,
    siteCategory: profile.siteCategory ?? 'retailer',
    crawlPhase: 'bootstrap' as const,
  };

  if (dryRun) {
    console.log(`Dry-run: would insert MonitoredSite ${JSON.stringify({ domain, name: siteName, url: siteUrl, adapterType: data.adapterType })}`);
    try {
      await prisma.$transaction(async (tx) => {
        await tx.monitoredSite.create({ data });
        throw new Error('ROLLBACK_DRY_RUN');
      });
    } catch (e: any) {
      if (e.message !== 'ROLLBACK_DRY_RUN') throw e;
    }
    console.log('Dry-run: transaction rolled back successfully');
    await prisma.$disconnect();
    process.exit(0);
  }

  // Real insert
  const site = await prisma.monitoredSite.create({ data });
  console.log(`Inserted MonitoredSite id=${site.id} domain=${domain}`);

  // Enqueue ONE catalog crawl via existing scrapeQueue
  const tierState = JSON.stringify({ tier: 4, currentPage: 1, cycleId: `bootstrap-${Date.now()}` });
  await scrapeQueue.add('crawl-catalog', {
    siteId: site.id, domain, url: siteUrl,
    baseBudget: site.baseBudget, capacity: site.capacity,
    tierState, activeTiers: { tier2: false, tier3: false, tier4: true },
    hasWaf: site.hasWaf, crawlTuning: null,
  }, { jobId: `bootstrap-${site.id}-${Date.now()}`, priority: 1, attempts: 1 });
  console.log('Enqueued bootstrap crawl-catalog job');

  // Poll for completion (max 10 min, every 30s)
  // Wait until the full crawl chain finishes: crawlLock released AND at least one success event.
  // Bootstrap crawls self-queue continuation jobs, so a single CrawlEvent does NOT mean done.
  const expected = profile.expectedProductCount ?? 0;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 30_000));
    const current = await prisma.monitoredSite.findUnique({
      where: { id: site.id },
      select: { crawlLock: true },
    });
    const successEvent = await prisma.crawlEvent.findFirst({
      where: { siteId: site.id, status: 'success' },
      orderBy: { createdAt: 'desc' },
    });
    // crawlLock released AND at least one success = chain complete
    if (!current?.crawlLock && successEvent) {
      const count = await prisma.productIndex.count({ where: { siteId: site.id } });
      const threshold = Math.floor(expected * 0.5);
      console.log(`Products: ${count}, threshold: ${threshold} (50% of ${expected})`);
      if (count >= threshold) {
        await prisma.monitoredSite.update({ where: { id: site.id }, data: { isEnabled: true } });
        console.log(`PASS: ${count} products indexed, isEnabled=true`);
        await prisma.$disconnect();
        process.exit(0);
      }
      console.error(`FAIL: ${count} < ${threshold}; isEnabled remains false`);
      await prisma.$disconnect();
      process.exit(1);
    }
  }
  console.error('Timeout: bootstrap did not complete in 10 minutes; left disabled');
  await prisma.$disconnect();
  process.exit(3);
}

main().catch(e => { console.error(e); process.exit(3); });
