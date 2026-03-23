/**
 * E2E Site Investigation Runner
 *
 * Runs investigate-site.js --db-only against all monitored sites
 * and produces a consolidated summary report.
 *
 * Usage:
 *   node scripts/run-e2e-test.js              # table output
 *   node scripts/run-e2e-test.js --json       # JSON output
 */

require('dotenv').config();
const { execSync } = require('child_process');
const path = require('path');

const SITES = [
  'aagcanada.ca',
  'alflahertys.com',
  'alsimmonsgunshop.com',
  'budgetshootersupply.ca',
  'bullseyenorth.com',
  'canadafirstammo.ca',
  'gunpost.ca',
];

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', white: '\x1b[37m', magenta: '\x1b[35m',
};

function runSite(domain) {
  var scriptPath = path.join(__dirname, 'investigate-site.js');
  try {
    var output = execSync(
      `node "${scriptPath}" ${domain} --db-only --json`,
      { cwd: path.join(__dirname, '..'), timeout: 60000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(output.trim());
  } catch (err) {
    return { domain: domain, error: err.message, summary: { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 }, allIssues: [], probes: {} };
  }
}

function extractSourceIdInfo(report) {
  var probe = report.probes && report.probes['A5-sourceid-coverage'];
  if (!probe) return { coverage: 'N/A', verdict: 'SKIP' };
  // Parse coverage from details text (strip ANSI)
  var detailLine = (probe.details || []).find(function(d) { return d.indexOf('sourceId coverage:') !== -1; });
  if (detailLine) {
    var clean = detailLine.replace(/\x1b\[[0-9;]*m/g, '');
    var match = clean.match(/(\d+)\/(\d+).*\((\d+)%\)/);
    if (match) return { with: parseInt(match[1]), total: parseInt(match[2]), pct: parseInt(match[3]), verdict: probe.verdict };
  }
  return { coverage: 'N/A', verdict: probe.verdict };
}

function extractDuplicateInfo(report) {
  var probe = report.probes && report.probes['C4-duplicate-detection'];
  if (!probe) return { verdict: 'SKIP', count: 0 };
  var dupeIssues = (probe.issues || []).filter(function(i) { return i.code === 'DUPLICATE_SOURCE_IDS'; });
  return { verdict: probe.verdict, count: dupeIssues.length > 0 ? dupeIssues[0].evidence.duplicateCount || dupeIssues.length : 0 };
}

function extractProductInfo(report) {
  var probe = report.probes && report.probes['A3-product-index'];
  if (!probe) return { total: 0, seen7d: 'N/A', newIn7d: 'N/A' };
  var details = (probe.details || []).map(function(d) { return d.replace(/\x1b\[[0-9;]*m/g, ''); });
  var total = 0, seen7d = 'N/A', newIn7d = 'N/A';
  for (var line of details) {
    var mTotal = line.match(/(\d+) products? \(/);
    if (mTotal) total = parseInt(mTotal[1]);
    var mSeen = line.match(/Active seen in 7d: (\d+)\/(\d+) \((\d+)%\)/);
    if (mSeen) seen7d = mSeen[3] + '%';
    var mNew = line.match(/New products in 7d: (\d+)/);
    if (mNew) newIn7d = parseInt(mNew[1]);
  }
  return { total: total, seen7d: seen7d, newIn7d: newIn7d };
}

function getHighIssues(report) {
  return (report.allIssues || []).filter(function(i) { return i.severity === 'high'; });
}

function padRight(str, len) { str = String(str); while (str.length < len) str += ' '; return str; }
function padLeft(str, len) { str = String(str); while (str.length < len) str = ' ' + str; return str; }

function main() {
  var jsonOutput = process.argv.includes('--json');
  var startTime = Date.now();
  var results = [];

  if (!jsonOutput) {
    console.log(`${C.bold}${C.white}`);
    console.log('============================================================');
    console.log('  E2E SITE INVESTIGATION — Consolidated Report');
    console.log('  ' + new Date().toISOString());
    console.log('============================================================');
    console.log(C.reset);
  }

  for (var domain of SITES) {
    if (!jsonOutput) process.stdout.write(`  Investigating ${padRight(domain, 28)} ... `);
    var report = runSite(domain);
    results.push(report);
    if (!jsonOutput) {
      if (report.error) {
        console.log(`${C.red}ERROR${C.reset}`);
      } else {
        var s = report.summary;
        var color = s.FAIL > 0 ? C.red : s.WARN > 0 ? C.yellow : C.green;
        console.log(`${color}P:${s.PASS} W:${s.WARN} F:${s.FAIL}${C.reset}`);
      }
    }
  }

  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (jsonOutput) {
    var jsonReport = {
      timestamp: new Date().toISOString(),
      elapsedSeconds: parseFloat(elapsed),
      sites: results,
      totals: {
        pass: results.reduce(function(a, r) { return a + (r.summary.PASS || 0); }, 0),
        warn: results.reduce(function(a, r) { return a + (r.summary.WARN || 0); }, 0),
        fail: results.reduce(function(a, r) { return a + (r.summary.FAIL || 0); }, 0),
        highIssues: results.reduce(function(a, r) { return a + getHighIssues(r).length; }, 0),
      },
    };
    console.log(JSON.stringify(jsonReport, null, 2));
    return;
  }

  // ── Summary Table ──
  console.log('');
  console.log(`${C.bold}${C.cyan}SUMMARY TABLE${C.reset}  (${elapsed}s)`);
  console.log('');

  var hdr = padRight('Site', 28) + padLeft('Adapter', 18) + padLeft('Prods', 7) + padLeft('Seen7d', 8)
    + padLeft('New7d', 7) + padLeft('SrcID', 7) + padLeft('Dupes', 7)
    + padLeft('P', 4) + padLeft('W', 4) + padLeft('F', 4) + padLeft('HIGH', 6);
  console.log(`${C.bold}${hdr}${C.reset}`);
  console.log('-'.repeat(hdr.length));

  var totalPass = 0, totalWarn = 0, totalFail = 0, totalHigh = 0;

  for (var r of results) {
    var srcId = extractSourceIdInfo(r);
    var dupes = extractDuplicateInfo(r);
    var prods = extractProductInfo(r);
    var high = getHighIssues(r);
    var s = r.summary;

    totalPass += s.PASS || 0;
    totalWarn += s.WARN || 0;
    totalFail += s.FAIL || 0;
    totalHigh += high.length;

    var srcIdStr = srcId.pct !== undefined ? srcId.pct + '%' : srcId.coverage;
    var srcIdColor = srcId.pct >= 90 ? C.green : srcId.pct >= 50 ? C.yellow : srcId.pct !== undefined ? C.red : '';
    var failColor = s.FAIL > 0 ? C.red : '';
    var highColor = high.length > 0 ? C.red : C.green;

    var line = padRight(r.domain || '', 28)
      + padLeft(r.adapter || 'ERR', 18)
      + padLeft(prods.total, 7)
      + padLeft(prods.seen7d, 8)
      + padLeft(prods.newIn7d, 7)
      + srcIdColor + padLeft(srcIdStr, 7) + C.reset
      + padLeft(dupes.count, 7)
      + C.green + padLeft(s.PASS || 0, 4) + C.reset
      + C.yellow + padLeft(s.WARN || 0, 4) + C.reset
      + failColor + padLeft(s.FAIL || 0, 4) + C.reset
      + highColor + padLeft(high.length, 6) + C.reset;

    console.log(line);
  }

  console.log('-'.repeat(hdr.length));
  console.log(
    padRight('TOTALS', 28) + padLeft('', 18) + padLeft('', 7) + padLeft('', 8) + padLeft('', 7) + padLeft('', 7) + padLeft('', 7)
    + C.green + padLeft(totalPass, 4) + C.reset
    + C.yellow + padLeft(totalWarn, 4) + C.reset
    + (totalFail > 0 ? C.red : '') + padLeft(totalFail, 4) + C.reset
    + (totalHigh > 0 ? C.red : C.green) + padLeft(totalHigh, 6) + C.reset
  );

  // ── HIGH severity issues detail ──
  console.log('');
  console.log(`${C.bold}${C.red}HIGH SEVERITY ISSUES${C.reset}`);
  console.log('');

  var anyHigh = false;
  for (var r of results) {
    var high = getHighIssues(r);
    if (high.length === 0) continue;
    anyHigh = true;
    console.log(`  ${C.bold}${r.domain}${C.reset}`);
    for (var issue of high) {
      var fixTag = issue.fixable ? `${C.green}[fixable]${C.reset}` : `${C.red}[manual]${C.reset}`;
      console.log(`    ${C.red}${issue.code}${C.reset} — ${issue.description} ${fixTag}`);
    }
    console.log('');
  }
  if (!anyHigh) {
    console.log(`  ${C.green}None!${C.reset}`);
  }

  // ── sourceId coverage detail ──
  console.log(`${C.bold}${C.cyan}SOURCE ID COVERAGE${C.reset}`);
  console.log('');
  for (var r of results) {
    var srcId = extractSourceIdInfo(r);
    var pctStr = srcId.pct !== undefined ? srcId.pct + '%' : 'N/A';
    var color = srcId.pct >= 90 ? C.green : srcId.pct >= 50 ? C.yellow : srcId.pct !== undefined ? C.red : C.dim;
    var counts = srcId.with !== undefined ? ` (${srcId.with}/${srcId.total})` : '';
    console.log(`  ${padRight(r.domain, 28)} ${color}${pctStr}${C.reset}${counts}  [${r.adapter}]`);
  }
  console.log('');
}

main();
