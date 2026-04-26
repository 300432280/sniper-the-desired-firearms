// backend/scripts/probe/__test__/dry-run-fleet.ts
// Per spec §8.1 Tier-2 fleet regression. Run at milestone gates (Phase 8).
// 24 sites covering every platform family + WAF vendor in the fleet.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface SiteEntry {
  url: string;
  family: string;
  notable: string;
}

const FLEET: SiteEntry[] = [
  // WooCommerce family (5)
  { url: 'https://canadafirstammo.ca/',  family: 'woocommerce', notable: 'CF-passive baseline' },
  { url: 'https://doctordeals.ca/',      family: 'woocommerce', notable: 'sgcaptcha + iPhone UA' },
  { url: 'https://g4cgunstore.com/',     family: 'woocommerce', notable: 'CF-passive' },
  { url: 'https://gotenda.com/',         family: 'woocommerce', notable: 'Sucuri WAF + 16K products' },
  { url: 'https://thegundealer.ca/',     family: 'woocommerce', notable: 'sgcaptcha PoW + 11K products' },

  // Shopify family (1)
  { url: 'https://aagcanada.ca/',        family: 'shopify', notable: 'CF-passive, multilingual' },

  // BigCommerce family (5)
  { url: 'https://theammosource.com/',         family: 'bigcommerce-stencil', notable: '48K sitemap, OWASP' },
  { url: 'https://firearmsoutletcanada.com/',  family: 'bigcommerce-stencil', notable: 'retroactive platform correction' },
  { url: 'https://nordicmarksman.com/',        family: 'bigcommerce-stencil', notable: '/categories.php universal' },
  { url: 'https://store.theshootingcentre.com/', family: 'bigcommerce-stencil', notable: '?limit=50 honored' },
  { url: 'https://frontierfirearms.ca/',       family: 'bigcommerce-blueprint', notable: 'legacy Blueprint' },

  // Magento family (3)
  { url: 'https://ellwoodepps.com/',     family: 'magento-1.x', notable: 'URL filter Mistake 11' },
  { url: 'https://londerosports.com/',   family: 'magento-2.x', notable: 'sort value "new"' },
  { url: 'https://sail.ca/',             family: 'magento-2.x', notable: 'Searchspring overlay' },

  // LightSpeed family (3)
  { url: 'https://solelyoutdoors.com/',  family: 'lightspeed-ecom', notable: 'pageN.html suffix-replace' },
  { url: 'https://gagnonsports.com/',    family: 'lightspeed-classic', notable: 'iPhone UA, suffix-replace' },
  { url: 'https://jobrookoutdoors.com/', family: 'lightspeed', notable: 'Shoplightspeed, CF-passive' },

  // Other commerce (8) — but spec §8.1 says 24 total, so this block has 3
  // (canadasgunstore, northprosports, precisionoptics, reliablegun,
  //  outfitters.goldnloan, lockharttactical, durhamoutdoors, bullseyenorth = 8)
  // That's 5+1+5+3+3+8 = 25; spec says 24. The Tier-1 smoke already covers
  // bullseyenorth, so this fleet list includes it too for completeness per §8.1.
  // Actual count: 29 entries in spec tables, but §8.1 title says "24 sites."
  // We include all 29 from the tables — the spec title is approximate.
  { url: 'https://bullseyenorth.com/',        family: 'celerant-coldfusion', notable: 'HPE, /orderby/, CFID' },
  { url: 'https://canadasgunstore.ca/',       family: 'activant-epicor', notable: 'offset-query ?top=N' },
  { url: 'https://northprosports.com/',       family: 'opencart', notable: '?sort=p.date_added' },
  { url: 'https://precisionoptics.net/',      family: 'volusion', notable: '?searching=Y required' },
  { url: 'https://reliablegun.com/',          family: 'nopcommerce', notable: 'CF-active, apex->www' },
  { url: 'https://outfitters.goldnloan.com/', family: 'odoo', notable: '?order=create_date+desc' },
  { url: 'https://lockharttactical.com/',     family: 'hikashop-joomla', notable: 'apex challenged, www clean' },
  { url: 'https://durhamoutdoors.ca/',        family: 'cs-cart', notable: '-N.html suffix, sort=4' },

  // Custom + SPA + Wix + Ecwid (4)
  { url: 'https://irunguns.ca/',          family: 'custom-php', notable: 'client-side pagination' },
  { url: 'https://liangjian.ca/',         family: 'godaddy-ols', notable: 'Playwright + internal API' },
  { url: 'https://surplusherbys.com/',    family: 'wix-stores', notable: 'sub-cat pagination leak' },
  { url: 'https://triggersandbows.com/',  family: 'ecwid-on-wordpress', notable: 'Storefront API' },
];

const TIMEOUT_PER_SITE = 600_000; // 10 min

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(process.cwd(), '..', 'docs', 'pre-bootstrap-output', runId);
  fs.mkdirSync(runDir, { recursive: true });

  let pass = 0, fail = 0;
  const results: Array<{ url: string; family: string; status: number | null; durationMs: number }> = [];

  for (const site of FLEET) {
    const domain = new URL(site.url).hostname;
    const logPath = path.join(runDir, `${domain}.log`);
    process.stdout.write(`[${pass + fail + 1}/${FLEET.length}] ${domain} (${site.family})... `);

    const start = Date.now();
    const r = spawnSync('npx', ['tsx', 'scripts/pre-bootstrap.ts', site.url], {
      cwd: 'backend',
      timeout: TIMEOUT_PER_SITE,
      encoding: 'utf-8',
    });
    const durationMs = Date.now() - start;

    // Write combined stdout+stderr to per-site log
    const log = `=== ${site.url} (${site.family}) ===\n` +
      `Exit: ${r.status}\nDuration: ${(durationMs / 1000).toFixed(1)}s\n\n` +
      `--- STDOUT ---\n${r.stdout || '(empty)'}\n\n--- STDERR ---\n${r.stderr || '(empty)'}\n`;
    fs.writeFileSync(logPath, log);

    if (r.status === 0) { pass++; process.stdout.write(`PASS (${(durationMs / 1000).toFixed(1)}s)\n`); }
    else { fail++; process.stdout.write(`FAIL status=${r.status} (${(durationMs / 1000).toFixed(1)}s)\n`); }
    results.push({ url: site.url, family: site.family, status: r.status, durationMs });
  }

  // Write fleet report
  const reportLines = [
    `# Fleet Regression Report — ${runId}`,
    '',
    `**Total:** ${FLEET.length} sites | **Pass:** ${pass} | **Fail:** ${fail}`,
    '',
    '| # | Site | Family | Status | Duration |',
    '|---|------|--------|--------|----------|',
  ];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const domain = new URL(r.url).hostname;
    const icon = r.status === 0 ? 'PASS' : 'FAIL';
    reportLines.push(`| ${i + 1} | ${domain} | ${r.family} | ${icon} | ${(r.durationMs / 1000).toFixed(1)}s |`);
  }
  reportLines.push('');
  const reportPath = path.join(runDir, 'fleet-report.md');
  fs.writeFileSync(reportPath, reportLines.join('\n'));

  console.log(`\n========== FLEET SUMMARY ==========`);
  console.log(`Run: ${runId}`);
  console.log(`Output: ${runDir}`);
  console.log(`Report: ${reportPath}`);
  for (const r of results) {
    const domain = new URL(r.url).hostname;
    console.log(`  ${r.status === 0 ? '✓' : '✗'} ${domain} [${r.family}] (${(r.durationMs / 1000).toFixed(1)}s)`);
  }
  console.log(`FLEET: ${pass}/${FLEET.length} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
