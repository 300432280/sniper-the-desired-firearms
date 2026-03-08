import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const sites = await p.monitoredSite.findMany({
    where: { isEnabled: true },
    select: { domain: true, crawlIntervalMin: true, difficultyScore: true, avgResponseTimeMs: true, consecutiveFailures: true, hasWaf: true, hasRateLimit: true, hasCaptcha: true },
    orderBy: { crawlIntervalMin: 'desc' },
  });

  for (const s of sites) {
    const flags = [s.hasWaf ? 'WAF' : '', s.hasRateLimit ? 'RL' : '', s.hasCaptcha ? 'CAP' : ''].filter(Boolean).join(',');
    console.log(
      `${String(s.crawlIntervalMin).padStart(4)}min  diff=${String(s.difficultyScore).padStart(3)}  resp=${String(s.avgResponseTimeMs || '-').padStart(6)}ms  fails=${s.consecutiveFailures}  ${flags.padEnd(8)} ${s.domain}`
    );
  }

  // Optional: check search status for a keyword (pass as CLI arg)
  const keyword = process.argv[2];
  if (keyword) {
    const searches = await p.search.findMany({
      where: { keyword: { contains: keyword, mode: 'insensitive' } },
      select: { isActive: true, createdAt: true, websiteUrl: true },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });
    console.log(`\nSearch status for "${keyword}":`);
    for (const s of searches) {
      console.log(`  ${s.isActive ? 'ACTIVE' : 'INACTIVE'}  created: ${s.createdAt}  ${s.websiteUrl}`);
    }
  }

  await p.$disconnect();
}
main();
