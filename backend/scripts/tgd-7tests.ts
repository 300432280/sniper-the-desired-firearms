import 'dotenv/config';
import axios from 'axios';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function clearRedis(domain: string) {
  const { redisConnection } = await import('../src/services/queue');
  await redisConnection.del(`waf-cookie:${domain}`).catch(() => {});
}

async function solveWithUa(domain: string, url: string, ua: string) {
  // Directly call Playwright + replicate waf-cookie-manager solve path but with forced UA
  const { getBrowser } = await import('../src/services/scraper/playwright-fetcher');
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: ua });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    // NEW WAIT STRATEGY: wait for URL to leave challenge paths
    const challengePaths = ['/.well-known/sgcaptcha/', '/cdn-cgi/challenge-platform/', '/_Incapsula_Resource'];
    const startWait = Date.now();
    while (Date.now() - startWait < 20000) {
      const curUrl = page.url();
      if (!challengePaths.some(p => curUrl.includes(p))) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2000);
    const origin = new URL(url).origin;
    const cookies = await context.cookies(origin);
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const finalUrl = page.url();
    return { cookieStr, cookieCount: cookies.length, finalUrl };
  } finally {
    await context.close();
  }
}

async function testWpJson(cookieStr: string, ua: string, query: Record<string, any> = { per_page: 1 }) {
  const resp = await axios.get('https://thegundealer.ca/wp-json/wc/store/v1/products', {
    params: query,
    headers: { 'User-Agent': ua, Cookie: cookieStr },
    timeout: 15000,
    validateStatus: () => true,
  });
  return { status: resp.status, xWpTotal: resp.headers['x-wp-total'], dataLen: Array.isArray(resp.data) ? resp.data.length : -1 };
}

async function testShopHtml(cookieStr: string, ua: string, page: number) {
  const url = page === 1 ? 'https://thegundealer.ca/shop/' : `https://thegundealer.ca/shop/page/${page}/`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': ua, Cookie: cookieStr, Accept: 'text/html' },
    timeout: 20000,
    validateStatus: () => true,
    maxRedirects: 5,
  });
  const body = typeof resp.data === 'string' ? resp.data : '';
  const isChallenge = body.includes('sg-captcha') || body.includes('Robot Challenge') || body.includes('/.well-known/sgcaptcha/');
  const is404 = body.includes('Page not found') || body.includes('404');
  const hasProducts = body.includes('woocommerce-loop-product') || body.includes('product_cat') || body.includes('li class="product');
  return { status: resp.status, bodyLen: body.length, isChallenge, is404, hasProducts };
}

async function main() {
  console.log('\n===========================================');
  console.log('7-TEST MATRIX for SiteGround sgcaptcha fix');
  console.log('===========================================\n');

  // TEST 1 — Desktop UA + NEW wait strategy → does it bypass sgcaptcha?
  console.log('--- TEST 1: Desktop UA + NEW wait → solve thegundealer.ca ---');
  await clearRedis('thegundealer.ca');
  try {
    const r = await solveWithUa('thegundealer.ca', 'https://thegundealer.ca/', DESKTOP_UA);
    console.log(`  cookies: ${r.cookieCount}, finalUrl: ${r.finalUrl}`);
    console.log(`  cookie preview: ${r.cookieStr.slice(0, 120)}`);
    if (r.cookieStr) {
      const wp = await testWpJson(r.cookieStr, DESKTOP_UA);
      console.log(`  /wp-json/ with desktop cookies: status=${wp.status}, xWpTotal=${wp.xWpTotal}`);
    }
  } catch (e) { console.log('  ERROR:', (e as Error).message); }

  // TEST 2 — iPhone UA + NEW wait → re-verify
  console.log('\n--- TEST 2: iPhone UA + NEW wait → solve thegundealer.ca ---');
  await clearRedis('thegundealer.ca');
  let iphoneCookies = '';
  try {
    const r = await solveWithUa('thegundealer.ca', 'https://thegundealer.ca/', IPHONE_UA);
    console.log(`  cookies: ${r.cookieCount}, finalUrl: ${r.finalUrl}`);
    console.log(`  cookie preview: ${r.cookieStr.slice(0, 120)}`);
    iphoneCookies = r.cookieStr;
    if (r.cookieStr) {
      const wp = await testWpJson(r.cookieStr, IPHONE_UA);
      console.log(`  /wp-json/ with iPhone cookies: status=${wp.status}, xWpTotal=${wp.xWpTotal}`);
    }
  } catch (e) { console.log('  ERROR:', (e as Error).message); }

  // TEST 3 — /wp-json/ deep pagination via cached iPhone cookies (page 1, 50, 110)
  console.log('\n--- TEST 3: /wp-json/ deep pagination (iPhone cookies, plain axios) ---');
  if (iphoneCookies) {
    for (const p of [1, 50, 110]) {
      const r = await testWpJson(iphoneCookies, IPHONE_UA, { per_page: 100, page: p });
      console.log(`  page=${p} per_page=100: status=${r.status}, returned ${r.dataLen} products`);
    }
  } else { console.log('  SKIPPED — no iPhone cookies from test 2'); }

  // TEST 4 — date filter via cached iPhone cookies
  console.log('\n--- TEST 4: /wp-json/ date filter (api-date-since-watermark) ---');
  if (iphoneCookies) {
    const r1 = await testWpJson(iphoneCookies, IPHONE_UA, { per_page: 1 });
    const r14 = await testWpJson(iphoneCookies, IPHONE_UA, { per_page: 1, orderby: 'date', order: 'desc', after: '2026-03-26T00:00:00' });
    const r1d = await testWpJson(iphoneCookies, IPHONE_UA, { per_page: 1, orderby: 'date', order: 'desc', after: '2026-04-08T00:00:00' });
    console.log(`  no filter: xWpTotal=${r1.xWpTotal}`);
    console.log(`  14d ago: xWpTotal=${r14.xWpTotal}`);
    console.log(`  1d ago: xWpTotal=${r1d.xWpTotal}`);
    console.log(`  monotonic: ${Number(r1d.xWpTotal) <= Number(r14.xWpTotal) && Number(r14.xWpTotal) <= Number(r1.xWpTotal) ? '✅ PASS' : '❌ FAIL'}`);
  } else { console.log('  SKIPPED'); }

  // TEST 5 — HTML /shop/page/50/ via axios with cached cookies
  console.log('\n--- TEST 5: HTML /shop/ + /shop/page/50/ via axios (iPhone cookies) ---');
  if (iphoneCookies) {
    for (const p of [1, 50, 100]) {
      const r = await testShopHtml(iphoneCookies, IPHONE_UA, p);
      console.log(`  page=${p}: status=${r.status}, bodyLen=${r.bodyLen}, isChallenge=${r.isChallenge}, is404=${r.is404}, hasProducts=${r.hasProducts}`);
    }
  } else { console.log('  SKIPPED'); }

  // TEST 6 — Regression: Sucuri site (doctordeals.ca) with NEW wait strategy
  console.log('\n--- TEST 6: REGRESSION — doctordeals.ca (Sucuri) with NEW wait strategy ---');
  await clearRedis('doctordeals.ca');
  try {
    const r = await solveWithUa('doctordeals.ca', 'https://doctordeals.ca/', IPHONE_UA);
    console.log(`  cookies: ${r.cookieCount}, finalUrl: ${r.finalUrl}`);
    if (r.cookieStr) {
      const resp = await axios.get('https://doctordeals.ca/wp-json/wc/store/v1/products', {
        params: { per_page: 1 },
        headers: { 'User-Agent': IPHONE_UA, Cookie: r.cookieStr },
        timeout: 15000,
        validateStatus: () => true,
      });
      console.log(`  /wp-json/ status=${resp.status}, xWpTotal=${resp.headers['x-wp-total']}`);
    }
  } catch (e) { console.log('  ERROR:', (e as Error).message); }

  // TEST 7 — Regression: a known Cloudflare site with NEW wait strategy
  console.log('\n--- TEST 7: REGRESSION — a Cloudflare site (pick one known to use CF) ---');
  // theammosource.com has cloudflare-passive, should still work
  await clearRedis('theammosource.com');
  try {
    const r = await solveWithUa('theammosource.com', 'https://theammosource.com/', DESKTOP_UA);
    console.log(`  cookies: ${r.cookieCount}, finalUrl: ${r.finalUrl}`);
    console.log(`  cookie preview: ${r.cookieStr.slice(0, 120)}`);
  } catch (e) { console.log('  ERROR:', (e as Error).message); }

  console.log('\n===========================================');
  console.log('7 TESTS COMPLETE');
  console.log('===========================================');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
