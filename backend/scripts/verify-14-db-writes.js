// Verify the 14 DB writes from the 2026-04-23 session are still in place.
// Reads MonitoredSite.hasWaf (column) + siteProfile.wafType + siteProfile.platform (JSON fields).
// No writes. Exits 0 if all expected values match, 1 if any mismatch.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const expected = [
  // --- 9 WAF corrections ---
  { domain: 'alflahertys.com',                     hasWaf: null,  wafType: 'cloudflare-passive', platform: null,                 tag: 'WAF' },
  { domain: 'doctordeals.ca',                      hasWaf: null,  wafType: 'sgcaptcha',          platform: null,                 tag: 'WAF' },
  { domain: 'sail.ca',                             hasWaf: false, wafType: null,                 platform: null,                 tag: 'WAF' },
  { domain: 'ellwoodepps.com',                     hasWaf: true,  wafType: null,                 platform: null,                 tag: 'WAF' },
  { domain: 'fulcrum-outdoors.shoplightspeed.com', hasWaf: true,  wafType: null,                 platform: null,                 tag: 'WAF' },
  { domain: 'solelyoutdoors.com',                  hasWaf: true,  wafType: null,                 platform: null,                 tag: 'WAF' },
  { domain: 'firearmsoutletcanada.com',            hasWaf: true,  wafType: 'cloudflare-passive', platform: null,                 tag: 'WAF' },
  { domain: 'canada.hibid.com',                    hasWaf: null,  wafType: 'cloudflare-passive', platform: null,                 tag: 'WAF' },
  { domain: 'marstar.ca',                          hasWaf: true,  wafType: 'cloudflare-passive', platform: null,                 tag: 'WAF' },

  // --- 5 platform corrections (some overlap with WAF rows, but we also want platform-only rows) ---
  { domain: 'alflahertys.com',                     hasWaf: null,  wafType: null,                 platform: 'bigcommerce-stencil', tag: 'PLATFORM' },
  { domain: 'firearmsoutletcanada.com',            hasWaf: null,  wafType: null,                 platform: 'bigcommerce-stencil', tag: 'PLATFORM' },
  { domain: 'sail.ca',                             hasWaf: null,  wafType: null,                 platform: 'magento-2.x',         tag: 'PLATFORM' },
  { domain: 'solelyoutdoors.com',                  hasWaf: null,  wafType: null,                 platform: 'lightspeed-ecom',     tag: 'PLATFORM' },
  { domain: 'gagnonsports.com',                    hasWaf: null,  wafType: null,                 platform: 'lightspeed-ecom',     tag: 'PLATFORM' },
];

// Unique domains (10)
const domains = Array.from(new Set(expected.map((e) => e.domain)));

async function main() {
  const sites = await prisma.monitoredSite.findMany({
    where: { domain: { in: domains } },
    select: { id: true, domain: true, hasWaf: true, siteProfile: true },
  });

  const byDomain = new Map(sites.map((s) => [s.domain, s]));

  let pass = 0;
  let fail = 0;
  const rows = [];

  for (const e of expected) {
    const s = byDomain.get(e.domain);
    if (!s) {
      rows.push({ tag: e.tag, domain: e.domain, check: 'SITE-MISSING', expected: 'row exists', actual: 'NOT FOUND', ok: false });
      fail++;
      continue;
    }
    const profile = (s.siteProfile && typeof s.siteProfile === 'object') ? s.siteProfile : {};

    if (e.tag === 'WAF') {
      // Check hasWaf (if expected !== null) and wafType (if expected !== null)
      if (e.hasWaf !== null) {
        const ok = s.hasWaf === e.hasWaf;
        rows.push({ tag: e.tag, domain: e.domain, check: 'hasWaf', expected: e.hasWaf, actual: s.hasWaf, ok });
        ok ? pass++ : fail++;
      }
      if (e.wafType !== null) {
        const ok = profile.wafType === e.wafType;
        rows.push({ tag: e.tag, domain: e.domain, check: 'wafType', expected: e.wafType, actual: profile.wafType ?? '(unset)', ok });
        ok ? pass++ : fail++;
      }
    } else if (e.tag === 'PLATFORM') {
      const ok = profile.platform === e.platform;
      rows.push({ tag: e.tag, domain: e.domain, check: 'platform', expected: e.platform, actual: profile.platform ?? '(unset)', ok });
      ok ? pass++ : fail++;
    }
  }

  const colWidths = { tag: 9, domain: 38, check: 10, expected: 22, actual: 22, ok: 4 };
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad('TAG', colWidths.tag) +
    pad('DOMAIN', colWidths.domain) +
    pad('CHECK', colWidths.check) +
    pad('EXPECTED', colWidths.expected) +
    pad('ACTUAL', colWidths.actual) +
    'OK'
  );
  console.log('-'.repeat(Object.values(colWidths).reduce((a, b) => a + b, 0) + 2));
  for (const r of rows) {
    console.log(
      pad(r.tag, colWidths.tag) +
      pad(r.domain, colWidths.domain) +
      pad(r.check, colWidths.check) +
      pad(r.expected, colWidths.expected) +
      pad(r.actual, colWidths.actual) +
      (r.ok ? 'Y' : 'N')
    );
  }
  console.log('-'.repeat(Object.values(colWidths).reduce((a, b) => a + b, 0) + 2));
  console.log(`\nTotal checks: ${rows.length}  PASS: ${pass}  FAIL: ${fail}`);

  // Also show raw hasWaf / wafType / platform for each unique domain, for transparency.
  console.log('\nRaw state per domain:');
  for (const d of domains) {
    const s = byDomain.get(d);
    if (!s) { console.log(`  ${d}: NOT FOUND`); continue; }
    const profile = (s.siteProfile && typeof s.siteProfile === 'object') ? s.siteProfile : {};
    console.log(`  ${d.padEnd(38)} hasWaf=${String(s.hasWaf).padEnd(5)} wafType=${String(profile.wafType ?? 'null').padEnd(25)} platform=${profile.platform ?? 'null'}`);
  }

  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  await prisma.$disconnect();
  process.exit(2);
});
