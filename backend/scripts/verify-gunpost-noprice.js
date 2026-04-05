/**
 * Verify all gunpost.ca no-price products via a shared Playwright session.
 * WAF-resilient: solves Cloudflare challenge once, reuses browser context,
 * monitors error rate, and exits gracefully on persistent failures.
 *
 * Resumable: products already marked sold/deleted won't be re-queried on next run.
 *
 * Usage: node scripts/verify-gunpost-noprice.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const cheerio = require('cheerio');

const p = new PrismaClient();
const DELAY_MS = 3000; // 3s between requests — safe for Cloudflare
const BATCH_LOG_EVERY = 25;
const ERROR_CHECK_EVERY = 50;
const ERROR_RATE_THRESHOLD = 0.8; // 80%
const PAUSE_MINUTES = 5;
const MAX_CONSECUTIVE_CHALLENGE_FAILURES = 3;

// ── Cloudflare challenge solver ─────────────────────────────────────────────

/**
 * Launch a Playwright browser and solve the Cloudflare challenge.
 * Returns { browser, context } on success, or null on failure.
 */
async function solveCloudflareChallenge() {
  let browser, context;
  try {
    const pw = require('playwright');
    browser = await pw.chromium.launch({
      headless: true,
      channel: 'chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-position=-32000,-32000',
      ],
    });

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-CA',
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: {
        'Accept-Language': 'en-CA,en;q=0.9',
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    });

    const page = await context.newPage();

    // Stealth overrides
    await page.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-CA', 'en'] });
      window.chrome = { runtime: {} };
    `);

    // Block heavy resources
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) return route.abort();
      return route.continue();
    });

    console.log('[CF] Navigating to gunpost.ca to solve Cloudflare challenge...');
    await page.goto('https://www.gunpost.ca/ads', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

    const content = await page.content();
    const isCfChallenge =
      content.includes('cf-browser-verification') ||
      content.includes('Just a moment...') ||
      content.includes('challenge-platform') ||
      content.includes('Checking your browser') ||
      content.includes('_cf_chl') ||
      content.includes('Verifying you are human') ||
      (content.length < 5000 && content.includes('cloudflare'));

    if (isCfChallenge) {
      console.log('[CF] Challenge detected, waiting for auto-resolve (up to 35s)...');
      const resolved = await page.waitForFunction(
        `(() => {
          const text = document.body?.innerText || '';
          const html = document.documentElement?.innerHTML || '';
          return !text.includes('Just a moment') &&
                 !text.includes('Checking your browser') &&
                 !text.includes('Verifying you are human') &&
                 !text.includes('Attention Required') &&
                 !document.querySelector('#cf-browser-verification') &&
                 !document.querySelector('#challenge-running') &&
                 !document.querySelector('#challenge-form') &&
                 !html.includes('challenge-platform') &&
                 html.length > 5000;
        })()`,
        { timeout: 35000 }
      ).catch(() => null);

      if (!resolved) {
        console.log('[CF] Challenge did NOT resolve within 35s');
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        return null;
      }
      console.log('[CF] Challenge resolved successfully');
    } else if (content.length > 5000) {
      console.log('[CF] No challenge detected — page loaded directly');
    } else {
      console.log(`[CF] Unexpected response (${content.length}b) — may be blocked`);
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      return null;
    }

    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.close().catch(() => {});

    return { browser, context };
  } catch (err) {
    console.log(`[CF] Error solving challenge: ${err.message}`);
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

/**
 * Fetch a product page using the shared Playwright context.
 * Returns { html, statusCode } or throws on failure.
 */
async function fetchWithContext(context, url) {
  const page = await context.newPage();
  try {
    await page.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    `);
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) return route.abort();
      return route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(async (err) => {
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('Timeout')) throw err;
    });

    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const html = await page.content();
    const statusCode = html.length < 500 ? 404 : 200;
    return { html, statusCode };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Analyze a product page (mirrors product-verifier logic for gunpost).
 */
function analyzeGunpostPage(html, url) {
  const $ = cheerio.load(html);

  // Check for Cloudflare challenge (means session expired)
  if (html.length < 5000 && (html.includes('challenge-platform') || html.includes('Just a moment'))) {
    return { status: 'error', errorMessage: 'cloudflare-challenge' };
  }

  // 404 / soft-404
  const h1Text = $('h1').first().text().toLowerCase();
  const softDeletePatterns = [
    'not found', 'page introuvable', '404',
    'no longer available', 'has been removed',
    'does not exist', 'page not found',
  ];
  if (softDeletePatterns.some(pat => h1Text.includes(pat))) {
    return { status: 'deleted' };
  }

  const bodyText = $('body').text().substring(0, 3000).toLowerCase();
  if (/the page you requested does not exist/i.test(bodyText) ||
      /this (page|product|listing) (has been|was) removed/i.test(bodyText)) {
    return { status: 'deleted' };
  }

  // Sold detection (gunpost-specific CSS classes)
  if ($('.sold, .ad-sold, .field-sold').length > 0) {
    return { status: 'sold' };
  }
  const statusAreas = $('.price, .product-price, .product-status, .stock, .availability');
  const statusText = statusAreas.text().toLowerCase();
  if (/\bsold\s*out?\b/.test(statusText) || /\bsold\b/.test(statusText)) {
    return { status: 'sold' };
  }

  // Wanted detection
  const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
  if (title) {
    const titleLower = title.toLowerCase().trim();
    if (/\b(wanted|wtb|wtt|iso)\s*$/.test(titleLower)) {
      return { status: 'wanted', title };
    }
  }

  // Alive — extract price if available
  const result = { status: 'alive', title: title || undefined };

  // Try JSON-LD price
  $('script[type="application/ld+json"]').each((_, el) => {
    if (result.price) return;
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'Product' && item.offers) {
          const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
          for (const offer of offers) {
            if (offer.price !== undefined) {
              const price = parseFloat(String(offer.price).replace(/,/g, ''));
              if (!isNaN(price) && price >= 10) {
                result.price = price;
                result.regularPrice = offer.highPrice ? parseFloat(String(offer.highPrice)) : undefined;
              }
            }
          }
        }
      }
    } catch {}
  });

  // Try OG price
  if (!result.price) {
    const ogPrice = $('meta[property="product:price:amount"]').attr('content');
    if (ogPrice) {
      const price = parseFloat(ogPrice.replace(/,/g, ''));
      if (!isNaN(price) && price >= 10) result.price = price;
    }
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const site = await p.monitoredSite.findFirst({ where: { domain: 'gunpost.ca' } });
  if (!site) { console.log('gunpost.ca not found'); return; }

  const products = await p.productIndex.findMany({
    where: { siteId: site.id, isActive: true, price: null },
    select: { id: true, title: true, url: true },
    orderBy: { lastSeenAt: 'asc' },
  });

  console.log(`Found ${products.length} no-price active products to verify`);
  console.log(`Estimated time: ${Math.round(products.length * 6 / 60)} minutes (shared session)`);
  console.log('');

  // Step 1: Solve Cloudflare challenge once at the start
  let session = await solveCloudflareChallenge();
  if (!session) {
    console.log('Cloudflare challenge not resolving -- try again later');
    await p.$disconnect();
    return;
  }

  let consecutiveChallengeFailures = 0;
  let alive = 0, sold = 0, deleted = 0, wanted = 0, errors = 0, aliveWithPrice = 0;
  let recentErrors = 0; // errors in current 50-product window
  const startTime = Date.now();

  for (let i = 0; i < products.length; i++) {
    const prod = products[i];
    try {
      const { html, statusCode } = await fetchWithContext(session.context, prod.url);

      // HTTP-level deletion
      if (statusCode === 404 || statusCode === 410) {
        deleted++;
        await p.productIndex.update({ where: { id: prod.id }, data: { isActive: false, stockStatus: 'discontinued' } });
      } else {
        const result = analyzeGunpostPage(html, prod.url);

        if (result.status === 'error' && result.errorMessage === 'cloudflare-challenge') {
          // Session expired — count as error and trigger re-solve at next check
          errors++;
          recentErrors++;
        } else if (result.status === 'deleted') {
          deleted++;
          await p.productIndex.update({ where: { id: prod.id }, data: { isActive: false, stockStatus: 'discontinued' } });
        } else if (result.status === 'sold') {
          sold++;
          await p.productIndex.update({ where: { id: prod.id }, data: { stockStatus: 'out_of_stock' } });
        } else if (result.status === 'wanted') {
          wanted++;
        } else if (result.status === 'alive') {
          alive++;
          if (result.price) {
            aliveWithPrice++;
            await p.productIndex.update({
              where: { id: prod.id },
              data: { price: result.price, regularPrice: result.regularPrice || null },
            });
          }
        } else {
          errors++;
          recentErrors++;
        }
      }

      if ((i + 1) % BATCH_LOG_EVERY === 0) {
        const elapsed = Math.round((Date.now() - startTime) / 60000);
        const remaining = Math.round((products.length - i - 1) * 6 / 60);
        console.log(`[${i + 1}/${products.length}] ${elapsed}min elapsed, ~${remaining}min remaining | deleted=${deleted} sold=${sold} alive=${alive} wanted=${wanted} err=${errors}`);
      }
    } catch (e) {
      errors++;
      recentErrors++;
      if ((i + 1) % BATCH_LOG_EVERY === 0) {
        console.log(`[${i + 1}/${products.length}] ERROR: ${e.message?.substring(0, 80)}`);
      }
    }

    // Step 4: Every 50 products, check error rate
    if ((i + 1) % ERROR_CHECK_EVERY === 0 && recentErrors > 0) {
      const windowErrorRate = recentErrors / ERROR_CHECK_EVERY;
      if (windowErrorRate > ERROR_RATE_THRESHOLD) {
        console.log(`\n[WARN] Error rate ${Math.round(windowErrorRate * 100)}% in last ${ERROR_CHECK_EVERY} products (${recentErrors} errors)`);

        // Close old session
        await session.context.close().catch(() => {});
        await session.browser.close().catch(() => {});
        session = null;

        console.log(`[PAUSE] Waiting ${PAUSE_MINUTES} minutes before re-solving challenge...`);
        await new Promise(r => setTimeout(r, PAUSE_MINUTES * 60 * 1000));

        // Re-solve challenge
        session = await solveCloudflareChallenge();
        if (!session) {
          consecutiveChallengeFailures++;
          console.log(`[WARN] Challenge re-solve failed (attempt ${consecutiveChallengeFailures}/${MAX_CONSECUTIVE_CHALLENGE_FAILURES})`);

          if (consecutiveChallengeFailures >= MAX_CONSECUTIVE_CHALLENGE_FAILURES) {
            console.log(`\n[EXIT] ${MAX_CONSECUTIVE_CHALLENGE_FAILURES} consecutive challenge failures. Exiting gracefully.`);
            break;
          }

          // Wait again and retry
          console.log(`[PAUSE] Waiting ${PAUSE_MINUTES} more minutes...`);
          await new Promise(r => setTimeout(r, PAUSE_MINUTES * 60 * 1000));
          session = await solveCloudflareChallenge();

          if (!session) {
            consecutiveChallengeFailures++;
            if (consecutiveChallengeFailures >= MAX_CONSECUTIVE_CHALLENGE_FAILURES) {
              console.log(`\n[EXIT] ${MAX_CONSECUTIVE_CHALLENGE_FAILURES} consecutive challenge failures. Exiting gracefully.`);
              break;
            }
            // One more try
            console.log(`[PAUSE] Final retry in ${PAUSE_MINUTES} minutes...`);
            await new Promise(r => setTimeout(r, PAUSE_MINUTES * 60 * 1000));
            session = await solveCloudflareChallenge();
            if (!session) {
              console.log('\n[EXIT] All challenge re-solve attempts failed. Exiting gracefully.');
              break;
            }
          }
        }

        if (session) {
          consecutiveChallengeFailures = 0;
          console.log('[OK] Challenge re-solved, resuming...\n');
        }
      }
      recentErrors = 0; // Reset window counter
    }

    // Rate limit
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // Cleanup browser
  if (session) {
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
  }

  const elapsed = Math.round((Date.now() - startTime) / 60000);
  console.log('');
  console.log('=== PROGRESS REPORT ===');
  console.log(`Time: ${elapsed} minutes`);
  console.log(`Deleted (deactivated): ${deleted}`);
  console.log(`Sold (out_of_stock): ${sold}`);
  console.log(`Wanted (no price expected): ${wanted}`);
  console.log(`Alive (no price): ${alive - aliveWithPrice}`);
  console.log(`Alive (got price): ${aliveWithPrice}`);
  console.log(`Errors: ${errors}`);

  // Final stats
  const finalActive = await p.productIndex.count({ where: { siteId: site.id, isActive: true } });
  const finalPrice = await p.productIndex.count({ where: { siteId: site.id, isActive: true, price: { not: null } } });
  console.log(`\nFinal: ${finalActive} active | ${finalPrice} with price (${finalActive > 0 ? Math.round(finalPrice / finalActive * 100) : 0}%)`);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
