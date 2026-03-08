const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const site = await p.monitoredSite.findFirst({ where: { url: { contains: 'alflahertys' } } });

  // Get recent crawl events (rolling window of 20)
  const events = await p.crawlEvent.findMany({
    where: { siteId: site.id },
    orderBy: { crawledAt: 'desc' },
    take: 20,
    select: { status: true, responseTimeMs: true, statusCode: true, crawledAt: true, matchesFound: true },
  });

  console.log(`Last ${events.length} crawl events for ${site.name}:`);
  events.forEach((e, i) => {
    const time = e.crawledAt.toISOString().replace('T', ' ').slice(0, 19);
    console.log(`  [${i}] ${time} | ${e.status.padEnd(10)} | ${(e.statusCode || '?').toString().padEnd(3)} | ${(e.responseTimeMs || 0).toString().padEnd(6)}ms | ${e.matchesFound || 0} matches`);
  });

  // Compute pressure components
  const total = events.length;
  const failures = events.filter(e => e.status === 'fail' || e.status === 'timeout');
  const blocks = events.filter(e => e.status === 'blocked' || e.status === 'captcha' || e.statusCode === 429);
  const responseTimes = events.map(e => e.responseTimeMs).filter(t => t != null);
  const avgMs = responseTimes.length > 0 ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0;
  // WAF/Playwright sites use wider latency range (5s-45s vs 500ms-10s)
  const latencyScore = site.hasWaf
    ? Math.min(1, Math.max(0, (avgMs - 5000) / 40000))
    : Math.min(1, Math.max(0, (avgMs - 500) / 9500));
  const extractionFailures = events.filter(e => e.status === 'fail' && e.statusCode >= 200 && e.statusCode < 300);

  const failureRate = failures.length / total;
  const blockRate = blocks.length / total;
  const extractionFailureRate = extractionFailures.length / total;

  const pressure = 0.4 * failureRate + 0.2 * blockRate + 0.2 * latencyScore + 0.2 * extractionFailureRate;
  const capacity = Math.exp(-3 * pressure);

  console.log(`\n=== PRESSURE BREAKDOWN ===`);
  console.log(`Failures: ${failures.length}/${total} (rate: ${(failureRate * 100).toFixed(1)}%) — weight 0.4`);
  failures.forEach(f => console.log(`  ${f.status} | ${f.statusCode} | ${(f.url || '').slice(0, 60)}`));
  console.log(`Blocks: ${blocks.length}/${total} (rate: ${(blockRate * 100).toFixed(1)}%) — weight 0.2`);
  console.log(`Avg latency: ${avgMs.toFixed(0)}ms (score: ${(latencyScore * 100).toFixed(1)}%) — weight 0.2`);
  console.log(`Extraction failures: ${extractionFailures.length}/${total} (rate: ${(extractionFailureRate * 100).toFixed(1)}%) — weight 0.2`);
  console.log(`\nPressure: ${(pressure * 100).toFixed(1)}%`);
  console.log(`Capacity: ${(capacity * 100).toFixed(1)}%`);

  await p.$disconnect();
})();
