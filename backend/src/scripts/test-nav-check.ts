import { scrapeWithAdapter } from '../services/scraper/index';
import { prisma } from '../lib/prisma';

async function main() {
  const sites = await prisma.monitoredSite.findMany({
    where: { isEnabled: true, siteType: 'retailer' },
    orderBy: { domain: 'asc' },
  });

  console.log(`Checking ${sites.length} retailer sites for nav/junk matches...\n`);

  const navPatterns = /\/(product-category|category|categories|collections|brands|departments|tags|subcategory|shop\/?\?|manufacturer|menu|nav)\b/i;
  const junkPatterns = /^(GUN PARTS|ACCESSORIES|MAGAZINES|FIREARMS|AMMUNITION|OPTICS|CLOTHING|HOME|ABOUT|CONTACT|CART|LOGIN|MY ACCOUNT|CATEGORIES)/i;

  const issues: Array<{ domain: string; title: string; url: string; reason: string }> = [];
  let checked = 0;

  for (const site of sites) {
    try {
      const result = await scrapeWithAdapter(site.url, 'sks', { fast: true });
      checked++;

      for (const m of result.matches) {
        // Check for nav/category URLs
        if (navPatterns.test(m.url)) {
          issues.push({ domain: site.domain, title: m.title.slice(0, 60), url: m.url.slice(0, 80), reason: 'NAV URL' });
        }
        // Check for junk titles (menu items, category listings)
        else if (junkPatterns.test(m.title)) {
          issues.push({ domain: site.domain, title: m.title.slice(0, 60), url: m.url.slice(0, 80), reason: 'JUNK TITLE' });
        }
        // Check for very long titles (likely menu dumps)
        else if (m.title.length > 120) {
          issues.push({ domain: site.domain, title: m.title.slice(0, 60) + '...', url: m.url.slice(0, 80), reason: 'LONG TITLE' });
        }
        // Check for no price AND no thumbnail (might be nav link)
        else if (!m.price && !m.thumbnail && m.title.split(' ').length <= 3) {
          issues.push({ domain: site.domain, title: m.title.slice(0, 60), url: m.url.slice(0, 80), reason: 'SHORT+NO DATA' });
        }
      }

      const matchInfo = result.matches.length > 0 ? `${result.matches.length} matches` : 'no matches';
      process.stdout.write(`  [${checked}/${sites.length}] ${site.domain.padEnd(35)} ${matchInfo}\n`);
    } catch (e: any) {
      checked++;
      process.stdout.write(`  [${checked}/${sites.length}] ${site.domain.padEnd(35)} ERROR: ${e.message?.slice(0, 40)}\n`);
    }
  }

  console.log(`\n=== ISSUES FOUND: ${issues.length} ===`);
  for (const issue of issues) {
    console.log(`  [${issue.reason}] ${issue.domain}: "${issue.title}" → ${issue.url}`);
  }

  if (issues.length === 0) {
    console.log('  No issues found!');
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(console.error);
