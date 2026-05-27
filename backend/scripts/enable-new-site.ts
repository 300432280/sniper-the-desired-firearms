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
import { detectStreams, initStreamState, probeStreamTotalPages, parseStreamState } from '../src/services/stream-detector';
import { invalidateAdapterCache } from '../src/services/scraper/adapter-registry';
import { normalizeDomain } from '../src/services/scraper/utils/url';
import { COVERAGE_THRESHOLD } from '../src/services/product-count-probe';

/**
 * Bootstrap is "complete" when the streams[0]:T4 tier has a
 * `lastCycleCompletedAt` timestamp recorded. The worker's
 * `processStreamCatalogCrawl` at worker.ts:189 is hard-coded to drive
 * `streamState.streams[0]` only -- other streams' tier states are NEVER
 * updated, so requiring lastCycleCompletedAt on every tier hangs the polling
 * loop forever for any multi-stream site.
 *
 * worker.ts:294-300 sets lastCycleCompletedAt on T2/T3 of streams[0] when the
 * coverage gate clears, but bootstrap initState only creates a T4 key
 * (stream-detector.ts:172 tierList=[4] for crawlPhase==='bootstrap'), so T4
 * is the authoritative completion signal.
 *
 * Returns { done, coverageWarning }:
 *   done             — bootstrap iteration finished (regardless of coverage)
 *   coverageWarning  — the worker shipped after 3 failed coverage retries
 *                      (worker.ts:278); set on the tier when coverage stayed
 *                      below COVERAGE_THRESHOLD across all retry passes.
 */
function readBootstrapStatus(streamStateValue: unknown): { done: boolean; coverageWarning: boolean } {
  const ss = parseStreamState(streamStateValue);
  if (!ss) return { done: false, coverageWarning: false };
  const first = ss.streams[0];
  if (!first) return { done: false, coverageWarning: false };
  const bootstrapTier = ss.tiers[`${first.id}:4`];
  if (!bootstrapTier || !bootstrapTier.lastCycleCompletedAt) {
    return { done: false, coverageWarning: false };
  }
  return { done: true, coverageWarning: Boolean((bootstrapTier as any).coverageWarning) };
}

/**
 * Resolve the canonical origin (protocol+host) from a site profile.
 * Per SKILL.md Stage 4, `catalogUrls` may be path-only strings ("/shop/").
 * Fall back to `canonicalUrl`, then any absolute catalogUrls, then
 * extractionSample[].url (always absolute) to derive the origin.
 */
function resolveProfileOrigin(profile: any): string | null {
  if (typeof profile.canonicalUrl === 'string' && profile.canonicalUrl.startsWith('http')) {
    try { return new URL(profile.canonicalUrl).origin; } catch { /* fall through */ }
  }
  const urls: any[] = profile.catalogUrls || [];
  for (const u of urls) {
    if (typeof u === 'string' && u.startsWith('http')) {
      try { return new URL(u).origin; } catch { /* skip */ }
    }
  }
  const samples: any[] = profile.extractionSample || [];
  for (const s of samples) {
    if (s && typeof s.url === 'string' && s.url.startsWith('http')) {
      try { return new URL(s.url).origin; } catch { /* skip */ }
    }
  }
  return null;
}

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

  // Derive domain + url from profile. catalogUrls can be path-only per
  // SKILL.md Stage 4, so resolve origin via resolveProfileOrigin (which falls
  // back to canonicalUrl / absolute catalogUrls / extractionSample).
  const origin = resolveProfileOrigin(profile);
  if (!origin) {
    console.error('Profile has no resolvable origin (canonicalUrl absent + all catalogUrls path-only + no extractionSample). Cannot insert site row.');
    process.exit(3);
  }
  const parsed = new URL(origin);
  // Always normalize the cache key (strip www, lowercase) so it matches the
  // lookups in adapter-registry which run through normalizeDomain at every
  // call site (utils/url.ts:28). A raw `canonicalDomain` like "WWW.Foo.COM"
  // would miss otherwise.
  const domain = normalizeDomain(profile.canonicalDomain ?? parsed.hostname);
  const siteUrl = profile.canonicalUrl ?? origin;
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
  // hasCaptcha is a MonitoredSite column read by the operator triage UI; setting
  // it from the profile keeps the column in sync with the JSON. Default false
  // matches schema.prisma. The other captcha details live in siteProfile.
  const data = {
    domain,
    name: siteName,
    url: siteUrl,
    siteType: profile.siteType ?? 'retailer',
    adapterType: profile.adapterType ?? 'generic',
    hasWaf: profile.hasWaf ?? false,
    hasCaptcha: profile.hasCaptcha ?? false,
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

  // Refresh the adapter-registry cache so the worker picks up the new site's
  // profile during bootstrap. The cache loads bootstrap-phase sites since the
  // 2026-05-25 widening of refreshCache's WHERE clause, but its 5-minute TTL
  // means a hot process may not see the new row immediately.
  invalidateAdapterCache();

  // ── Initialize streamState BEFORE enqueueing ───────────────────────────────
  // Without this, worker.ts:90-96 falls to the LEGACY one-shot path and the
  // bootstrap completes after a single catalog-job pass with no self-queue.
  // For sites with > ~1 token-budget worth of pages, the 50% coverage check
  // then reports FAIL even though the site is reachable.
  // The scheduler does this same init for ALREADY-ENABLED sites at
  // crawl-scheduler.ts:234-271; we mirror it here for the bootstrap entry path.
  //
  // Hard requirement: detectStreams MUST return >= 1 stream. The "legacy path"
  // fallback (worker.ts:96) does not self-queue continuation jobs AND the
  // polling logic has no way to detect completion (`crawlLock` is set by the
  // scheduler, not by direct queue.add, so enable-new-site never sees it
  // toggle). If detection fails, roll back the row and surface to the operator
  // -- silently leaving a stranded MonitoredSite row is worse than failing.
  let initializedStreamState: unknown = null;
  let streamInitError: string | null = null;
  let streamInitErrorStack: string | null = null;
  try {
    const streams = await detectStreams(siteUrl, { hasWaf: site.hasWaf, siteProfile: profile });
    if (streams.length > 0) {
      await probeStreamTotalPages(streams, siteUrl, { hasWaf: site.hasWaf });
      initializedStreamState = initStreamState(streams, 'bootstrap');
      await prisma.monitoredSite.update({
        where: { id: site.id },
        data: { streamState: initializedStreamState as any },
      });
      const pagesInfo = streams.filter(s => s.totalPages).map(s => `${s.id}:${s.totalPages}p`).join(', ');
      console.log(`Detected ${streams.length} stream(s): ${streams.map(s => s.id).join(', ')}${pagesInfo ? ` (pages: ${pagesInfo})` : ''}`);
    } else {
      streamInitError = 'detectStreams returned 0 streams; candidate may have an unrecognized platform or empty catalogUrls';
    }
  } catch (err) {
    streamInitError = `detectStreams/probeStreamTotalPages threw: ${err instanceof Error ? err.message : String(err)}`;
    streamInitErrorStack = err instanceof Error ? (err.stack ?? null) : null;
  }

  if (streamInitError !== null) {
    console.error(`Stream init failed: ${streamInitError}`);
    if (streamInitErrorStack) console.error(streamInitErrorStack);
    console.error(`Rolling back inserted row id=${site.id} domain=${domain}`);
    await prisma.monitoredSite.delete({ where: { id: site.id } });
    invalidateAdapterCache();
    await prisma.$disconnect();
    process.exit(1);
  }

  // Enqueue the first catalog crawl. When streamState is present in the payload
  // the worker takes the stream path (processStreamCatalogCrawl) which
  // self-queues continuation jobs until the coverage gate is satisfied.
  const tierState = JSON.stringify({ tier: 4, currentPage: 1, cycleId: `bootstrap-${Date.now()}` });
  await scrapeQueue.add('crawl-catalog', {
    siteId: site.id, domain, url: siteUrl,
    baseBudget: site.baseBudget, capacity: site.capacity,
    tierState, activeTiers: { tier2: false, tier3: false, tier4: true },
    hasWaf: site.hasWaf, crawlTuning: null,
    streamState: initializedStreamState ?? undefined,
  }, { jobId: `bootstrap-${site.id}-${Date.now()}`, priority: 1, attempts: 1 });
  console.log('Enqueued bootstrap crawl-catalog job');

  // ── Poll until bootstrap actually finishes ─────────────────────────────────
  // Authoritative completion signal: streams[0]:T4 has lastCycleCompletedAt
  // set (see readBootstrapStatus above for the rationale).
  //
  // Coverage threshold matches the worker's internal gate at COVERAGE_THRESHOLD
  // (95%). A bootstrap is "safe to enable" only when:
  //   (a) ProductIndex.count >= 95% of siteProfile.expectedProductCount, AND
  //   (b) the worker did NOT set coverageWarning:true (which means the worker
  //       shipped after 3 failed retries despite coverage staying < 95%).
  // The previous 50% gate was a rubber-stamp -- it would flip isEnabled:true
  // for a site that indexed half its catalog, leaving the operator to discover
  // the gap later.
  //
  // Poll every 30s for up to 30 minutes. Larger sites time out and the site
  // is left disabled for operator intervention.
  const expected = profile.expectedProductCount ?? 0;
  const POLL_INTERVAL_MS = 30_000;
  const POLL_ITERATIONS = 60; // 30 min total

  for (let i = 0; i < POLL_ITERATIONS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const current = await prisma.monitoredSite.findUnique({
      where: { id: site.id },
      select: { streamState: true },
    });

    const status = readBootstrapStatus(current?.streamState);
    if (status.done) {
      const count = await prisma.productIndex.count({ where: { siteId: site.id } });
      const threshold = Math.floor(expected * COVERAGE_THRESHOLD);
      const pct = expected > 0 ? Math.round((count / expected) * 100) : 0;
      console.log(`Bootstrap done after ${(i + 1) * (POLL_INTERVAL_MS / 1000)}s. Products: ${count}/${expected} (${pct}%), threshold: ${threshold} (${Math.round(COVERAGE_THRESHOLD * 100)}% of expected)`);
      if (status.coverageWarning) {
        console.error(`FAIL: worker set coverageWarning=true (shipped after 3 failed coverage retries). isEnabled remains false.`);
        console.error(`  Operator: investigate why the site has fewer products than siteProfile.expectedProductCount=${expected}.`);
        console.error(`  Likely causes: stale expectedProductCount, wrong extraction selectors, or hidden inventory not reachable via catalogUrls.`);
        await prisma.$disconnect();
        process.exit(1);
      }
      if (count >= threshold) {
        await prisma.monitoredSite.update({ where: { id: site.id }, data: { isEnabled: true } });
        invalidateAdapterCache();
        console.log(`PASS: ${count} products indexed (>=${Math.round(COVERAGE_THRESHOLD * 100)}% coverage), isEnabled=true`);
        await prisma.$disconnect();
        process.exit(0);
      }
      console.error(`FAIL: ${count} < ${threshold} (${pct}% < ${Math.round(COVERAGE_THRESHOLD * 100)}% coverage). isEnabled remains false.`);
      await prisma.$disconnect();
      process.exit(1);
    }
  }
  console.error(`Timeout: bootstrap did not complete in ${(POLL_ITERATIONS * POLL_INTERVAL_MS) / 60_000} minutes; row left in place with isEnabled=false.`);
  console.error(`The scheduler will NOT auto-resume disabled sites (crawl-scheduler.ts:107 filters isEnabled:true).`);
  console.error(`Operator options for site id=${site.id} domain=${domain}:`);
  console.error(`  (a) verify ProductIndex.count manually and flip isEnabled=true via prisma studio if coverage is acceptable;`);
  console.error(`  (b) delete the row (and its streamState) and re-run enable-new-site.ts after fixing the candidate;`);
  console.error(`  (c) tail the worker logs to see whether bootstrap is still progressing -- the crawl-catalog job may self-queue another pass.`);
  await prisma.$disconnect();
  process.exit(3);
}

main().catch(e => { console.error(e); process.exit(3); });
