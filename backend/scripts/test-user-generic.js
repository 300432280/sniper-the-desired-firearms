/**
 * User-Perspective Generic Retail Test
 *
 * Tests 30 keywords against alflahertys.com and bullseyenorth.com.
 * For each keyword x site:
 *   1. Query ProductIndex (ILIKE title match, isActive, first 10)
 *   2. Check field quality: title, price, thumbnail, sourceId
 *   3. URL check first 2 results per keyword (with 500ms rate limit)
 *   4. Per-site per-keyword summary + overall report
 *
 * Usage:  node scripts/test-user-generic.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const prisma = new PrismaClient();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Colors ──────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', white: '\x1b[37m', magenta: '\x1b[35m',
};

function pass(msg) { return `  ${C.green}PASS${C.reset} ${msg}`; }
function fail(msg) { return `  ${C.red}FAIL${C.reset} ${msg}`; }
function info(msg) { return `  ${C.cyan}INFO${C.reset} ${msg}`; }
function warn(msg) { return `  ${C.yellow}WARN${C.reset} ${msg}`; }
function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── Keywords ────────────────────────────────────────────────────────────────
const KEYWORDS = [
  'SKS', '9mm', '.308', '.22 LR', '7.62x39',
  'Ruger 10/22', 'AR-15', 'tikka t3x', 'GSG-16', 'magazine',
  'shotgun', 'surplus', 'scope', 'Federal', 'FMJ',
  'primer', 'holster', 'Glock 19', '12 gauge', 'used rifle',
  'Savage 110 Ultralite .308', 'Winchester SXP 12ga pump',
  'Vortex Crossfire II 4-12x44', 'CCI Blazer 9mm 115gr FMJ',
  'Remington 870 Express 12 gauge pump shotgun',
  'norinco type 97', 'stripped lower receiver',
  '10 round magazine .223', '$500 rifle', 'mauser 270 win bolt action',
];

const TARGET_DOMAINS = ['alflahertys.com', 'bullseyenorth.com'];

// ── URL check ───────────────────────────────────────────────────────────────
async function checkUrl(url, hasWaf) {
  if (!url) return { ok: false, reason: 'null', wafNote: false };
  try {
    var resp = await axios.get(url, {
      headers: { 'User-Agent': UA },
      timeout: 12000,
      maxRedirects: 5,
      validateStatus: function() { return true; },
    });
    if (resp.status >= 200 && resp.status < 400) return { ok: true, status: resp.status, wafNote: false };
    if (resp.status === 403 && hasWaf) return { ok: false, status: 403, reason: 'WAF block (expected)', wafNote: true };
    if (resp.status === 403) return { ok: false, status: 403, reason: 'HTTP 403', wafNote: false };
    return { ok: false, status: resp.status, reason: 'HTTP ' + resp.status, wafNote: false };
  } catch (err) {
    var msg = err.message.substring(0, 80);
    if (hasWaf) return { ok: false, reason: msg + ' (WAF site)', wafNote: true };
    return { ok: false, reason: msg, wafNote: false };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}=== User-Perspective Generic Retail Test ===${C.reset}`);
  console.log(`  Testing ${KEYWORDS.length} keywords against ${TARGET_DOMAINS.length} sites\n`);

  // Resolve site IDs
  var sites = await prisma.monitoredSite.findMany({
    where: { domain: { in: TARGET_DOMAINS } },
    select: { id: true, domain: true, name: true, hasWaf: true, adapterType: true },
  });

  if (sites.length === 0) {
    console.log(fail('No matching sites found in MonitoredSite for: ' + TARGET_DOMAINS.join(', ')));
    return;
  }

  for (var s of sites) {
    console.log(info(`Found site: ${s.name} (${s.domain}) adapter=${s.adapterType} hasWaf=${s.hasWaf}`));
  }
  console.log('');

  // Overall tallies
  var overallReport = [];

  for (var site of sites) {
    console.log(`${C.bold}${C.magenta}── ${site.name} (${site.domain}) ──${C.reset}`);

    var siteStats = {
      domain: site.domain,
      name: site.name,
      totalKeywords: KEYWORDS.length,
      keywordsWithResults: 0,
      keywordsWithZero: 0,
      totalProducts: 0,
      missingTitle: 0,
      missingPrice: 0,
      missingThumbnail: 0,
      missingSourceId: 0,
      urlChecks: 0,
      urlPass: 0,
      urlFail: 0,
      urlWafBlock: 0,
      keywordDetails: [],
    };

    for (var ki = 0; ki < KEYWORDS.length; ki++) {
      var kw = KEYWORDS[ki];
      var products = await prisma.productIndex.findMany({
        where: {
          siteId: site.id,
          isActive: true,
          title: { contains: kw, mode: 'insensitive' },
        },
        take: 10,
        orderBy: { lastSeenAt: 'desc' },
      });

      var kwStats = {
        keyword: kw,
        count: products.length,
        missingTitle: 0,
        missingPrice: 0,
        missingThumbnail: 0,
        missingSourceId: 0,
        urlResults: [],
      };

      if (products.length === 0) {
        siteStats.keywordsWithZero++;
        console.log(warn(`[${ki+1}/${KEYWORDS.length}] "${kw}" -> 0 results`));
      } else {
        siteStats.keywordsWithResults++;
        siteStats.totalProducts += products.length;

        // Field quality checks
        for (var p of products) {
          if (!p.title || p.title.trim() === '') kwStats.missingTitle++;
          if (p.price === null || p.price === undefined) kwStats.missingPrice++;
          if (!p.thumbnail) kwStats.missingThumbnail++;
          if (!p.sourceId) kwStats.missingSourceId++;
        }

        siteStats.missingTitle += kwStats.missingTitle;
        siteStats.missingPrice += kwStats.missingPrice;
        siteStats.missingThumbnail += kwStats.missingThumbnail;
        siteStats.missingSourceId += kwStats.missingSourceId;

        var fieldIssues = [];
        if (kwStats.missingTitle > 0) fieldIssues.push('title:' + kwStats.missingTitle);
        if (kwStats.missingPrice > 0) fieldIssues.push('price:' + kwStats.missingPrice);
        if (kwStats.missingThumbnail > 0) fieldIssues.push('thumb:' + kwStats.missingThumbnail);
        if (kwStats.missingSourceId > 0) fieldIssues.push('srcId:' + kwStats.missingSourceId);

        var fieldStr = fieldIssues.length > 0 ? ` ${C.red}missing=[${fieldIssues.join(', ')}]${C.reset}` : ` ${C.green}fields OK${C.reset}`;

        // Sample: show first product
        var sample = products[0];
        var priceStr = sample.price !== null ? ('$' + sample.price.toFixed(2)) : 'NULL';
        console.log(pass(`[${ki+1}/${KEYWORDS.length}] "${kw}" -> ${products.length} results${fieldStr}`));
        console.log(`       sample: ${C.dim}${sample.title.substring(0, 70)}${C.reset}  ${priceStr}  srcId=${sample.sourceId || 'NULL'}`);

        // URL checks: first 2
        var urlCheckCount = Math.min(2, products.length);
        for (var ui = 0; ui < urlCheckCount; ui++) {
          siteStats.urlChecks++;
          var result = await checkUrl(products[ui].url, site.hasWaf);
          kwStats.urlResults.push({ url: products[ui].url, result: result });

          if (result.ok) {
            siteStats.urlPass++;
            console.log(`       ${C.green}URL OK${C.reset} (${result.status}) ${C.dim}${products[ui].url.substring(0, 70)}${C.reset}`);
          } else if (result.wafNote) {
            siteStats.urlWafBlock++;
            console.log(`       ${C.yellow}URL WAF${C.reset} ${result.reason} ${C.dim}${products[ui].url.substring(0, 70)}${C.reset}`);
          } else {
            siteStats.urlFail++;
            console.log(`       ${C.red}URL FAIL${C.reset} ${result.reason} ${C.dim}${products[ui].url.substring(0, 70)}${C.reset}`);
          }
          await delay(500); // rate limit
        }
      }

      siteStats.keywordDetails.push(kwStats);
    }

    // Per-site summary
    console.log(`\n${C.bold}${C.cyan}Summary: ${site.name}${C.reset}`);
    console.log(`  Keywords tested:      ${siteStats.totalKeywords}`);
    console.log(`  Keywords with results: ${C.green}${siteStats.keywordsWithResults}${C.reset}`);
    console.log(`  Keywords with 0:       ${siteStats.keywordsWithZero > 0 ? C.yellow : C.green}${siteStats.keywordsWithZero}${C.reset}`);
    console.log(`  Total products found:  ${siteStats.totalProducts}`);
    console.log(`  Missing title:         ${siteStats.missingTitle > 0 ? C.red + siteStats.missingTitle + C.reset : C.green + '0' + C.reset}`);
    console.log(`  Missing price:         ${siteStats.missingPrice > 0 ? C.red + siteStats.missingPrice + C.reset : C.green + '0' + C.reset}`);
    console.log(`  Missing thumbnail:     ${siteStats.missingThumbnail > 0 ? C.red + siteStats.missingThumbnail + C.reset : C.green + '0' + C.reset}`);
    console.log(`  Missing sourceId:      ${siteStats.missingSourceId > 0 ? C.red + siteStats.missingSourceId + C.reset : C.green + '0' + C.reset}`);
    console.log(`  URL checks:            ${siteStats.urlChecks} (pass=${C.green}${siteStats.urlPass}${C.reset} fail=${siteStats.urlFail > 0 ? C.red + siteStats.urlFail + C.reset : C.green + '0' + C.reset} waf=${C.yellow}${siteStats.urlWafBlock}${C.reset})`);

    overallReport.push(siteStats);
    console.log('');
  }

  // ── Overall Report ──────────────────────────────────────────────────────
  console.log(`${C.bold}${C.cyan}=== OVERALL REPORT ===${C.reset}\n`);

  var totalFails = 0;
  for (var r of overallReport) {
    var siteFails = r.missingTitle + r.missingPrice + r.missingThumbnail + r.missingSourceId + r.urlFail;
    totalFails += siteFails;

    var grade = siteFails === 0 ? `${C.green}CLEAN${C.reset}` : `${C.red}${siteFails} ISSUES${C.reset}`;
    console.log(`  ${C.bold}${r.name}${C.reset} (${r.domain})`);
    console.log(`    Results: ${r.keywordsWithResults}/${r.totalKeywords} keywords matched, ${r.totalProducts} products`);
    console.log(`    Fields:  title=${r.missingTitle} price=${r.missingPrice} thumb=${r.missingThumbnail} srcId=${r.missingSourceId} missing`);
    console.log(`    URLs:    ${r.urlPass} ok, ${r.urlFail} fail, ${r.urlWafBlock} waf-blocked`);
    console.log(`    Grade:   ${grade}`);

    // List zero-result keywords
    var zeros = r.keywordDetails.filter(function(k) { return k.count === 0; }).map(function(k) { return '"' + k.keyword + '"'; });
    if (zeros.length > 0) {
      console.log(`    ${C.yellow}Zero-result keywords:${C.reset} ${zeros.join(', ')}`);
    }
    console.log('');
  }

  if (totalFails === 0) {
    console.log(`${C.bold}${C.green}ALL CHECKS PASSED${C.reset} (excluding WAF blocks on bullseyenorth)\n`);
  } else {
    console.log(`${C.bold}${C.red}TOTAL ISSUES: ${totalFails}${C.reset} (excluding WAF blocks)\n`);
  }
}

main()
  .catch(function(err) { console.error('Fatal:', err); process.exit(1); })
  .finally(function() { return prisma.$disconnect(); });
