import 'dotenv/config';

async function main() {
  const pw = await import('playwright');
  const browser = await pw.chromium.launch({ headless: true, channel: 'chromium' });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-CA',
    viewport: { width: 1366, height: 900 },
  });
  const page = await ctx.newPage();

  const captures: any[] = [];
  page.on('request', req => {
    if (req.url().includes('storefront-api.ecwid.com') && req.method() === 'POST') {
      captures.push({ url: req.url(), body: req.postData(), label: '(pending)' });
    }
  });
  page.on('response', async resp => {
    if (resp.url().includes('storefront-api.ecwid.com') && resp.request().method() === 'POST') {
      try {
        const b = await resp.text();
        const m = captures.find(c => c.url === resp.url() && !c.respBody);
        if (m) { m.respBody = b; }
      } catch {}
    }
  });

  let step = 0;
  const mark = (l: string) => { step++; console.log(`\n==== STEP ${step}: ${l} ====`); for (const c of captures) if (c.label === '(pending)') c.label = `s${step-1}`; };

  // === STEP 1: Replicate the first-run flow that worked ===
  mark('Load /store/Firearms, wait 8s, then click Rifles via hrefContains');
  await page.goto('https://www.triggersandbows.com/store/Firearms-c156824300', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
  await page.waitForTimeout(8000);

  const riflesClicked = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
    const rifles = links.find(a => /Rifles/i.test(a.textContent || '') && a.href.includes('-c') && !a.href.includes('Air') && !a.href.includes('Muzzle'));
    if (rifles) { rifles.click(); return rifles.href; }
    return null;
  });
  console.log('clicked Rifles:', riflesClicked);
  await page.waitForTimeout(8000);

  // Now the sort select should exist
  let sortState = await page.evaluate(() => {
    const sel = document.querySelector('#ec-products-sort') as HTMLSelectElement | null;
    return { exists: !!sel, value: sel?.value, optionCount: sel?.options?.length || 0 };
  });
  console.log('Post-Rifles sort select state:', sortState);

  if (!sortState.exists) {
    console.log('Still no sort select. Aborting.');
    await page.close(); await ctx.close(); await browser.close();
    process.exit(1);
  }

  // Count initial products
  const initialProds = await page.evaluate(() => {
    const links = [...new Set(Array.from(document.querySelectorAll('a[href*="/store/"][href*="-p"]')).map(a => (a as HTMLAnchorElement).href))];
    return { count: links.length, first3: links.slice(0, 3) };
  });
  console.log('Initial products on Rifles:', initialProds);

  // === STEP 2: Change sort to addedTimeDesc ===
  mark('sort change → addedTimeDesc');
  await page.evaluate(() => {
    const sel = document.querySelector('#ec-products-sort') as HTMLSelectElement;
    sel.value = 'addedTimeDesc';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(6000);
  const afterDesc = await page.evaluate(() => {
    const links = [...new Set(Array.from(document.querySelectorAll('a[href*="/store/"][href*="-p"]')).map(a => (a as HTMLAnchorElement).href))];
    return { count: links.length, first3: links.slice(0, 3) };
  });
  console.log('After addedTimeDesc:', afterDesc);

  // === STEP 3: Change sort to nameAsc ===
  mark('sort change → nameAsc');
  await page.evaluate(() => {
    const sel = document.querySelector('#ec-products-sort') as HTMLSelectElement;
    sel.value = 'nameAsc';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(6000);
  const afterName = await page.evaluate(() => {
    const links = [...new Set(Array.from(document.querySelectorAll('a[href*="/store/"][href*="-p"]')).map(a => (a as HTMLAnchorElement).href))];
    return { count: links.length, first3: links.slice(0, 3) };
  });
  console.log('After nameAsc:', afterName);

  // === STEP 4: Reset to default then click next page ===
  mark('reset default + find pagination');
  await page.evaluate(() => {
    const sel = document.querySelector('#ec-products-sort') as HTMLSelectElement;
    sel.value = '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(5000);

  // Scroll to pager
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  // Show pager HTML
  const pagerInfo = await page.evaluate(() => {
    const pagers = Array.from(document.querySelectorAll('[class*="pager"], [class*="pagination"], nav[role="navigation"]'));
    return pagers.map(p => p.outerHTML.slice(0, 600));
  });
  console.log('Pager candidates:', pagerInfo);

  // === STEP 5: Click next page ===
  mark('click pager-next');
  const pagClicked = await page.evaluate(() => {
    // Ecwid next-gen uses .ec-pager__btn--next or .pager__button--next or similar
    const selectors = [
      'a.pager__button--next',
      'button.pager__button--next',
      '.pager__button--next',
      '.ec-pager__btn--next',
      'a[aria-label="Next page"]',
      '[class*="pager"][class*="next"]',
      'a.pager__button',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s) as HTMLElement;
      if (el && el.offsetWidth > 0) {
        el.click();
        return { selector: s, html: el.outerHTML.slice(0, 300) };
      }
    }
    // fallback: any anchor in a .pager with text 2
    const pagerLinks = Array.from(document.querySelectorAll('.pager a, .pager button')) as HTMLElement[];
    for (const el of pagerLinks) {
      const txt = (el.textContent || '').trim();
      if (txt === '2' || /^Next/i.test(txt)) {
        el.click();
        return { selector: 'pager fallback', text: txt, html: el.outerHTML.slice(0, 300) };
      }
    }
    return null;
  });
  console.log('pager click result:', pagClicked);
  await page.waitForTimeout(6000);

  const afterPage = await page.evaluate(() => {
    const links = [...new Set(Array.from(document.querySelectorAll('a[href*="/store/"][href*="-p"]')).map(a => (a as HTMLAnchorElement).href))];
    return { count: links.length, first3: links.slice(0, 3) };
  });
  console.log('After page click:', afterPage);

  mark('END');

  // === DUMP CAPTURES ===
  console.log(`\n\n=== ${captures.length} STOREFRONT-API POSTS ===`);
  for (let i = 0; i < captures.length; i++) {
    const c = captures[i];
    const ep = c.url.replace('https://us-vir2-storefront-api.ecwid.com/storefront/api/v1/92697308', '');
    console.log(`\n[${i}] ${c.label}  POST ${ep}`);
    console.log(`    body: ${(c.body || '').slice(0, 1500)}`);
    if (c.respBody) {
      try {
        const j = JSON.parse(c.respBody);
        if (j.expandedCategories?.[0]) {
          const ec = j.expandedCategories[0];
          console.log(`    expandedCategories[0]: name=${ec.categoryInfo?.name} products.len=${ec.products?.length} totalProductsCount=${ec.totalProductsCount} hasMoreProducts=${ec.hasMoreProducts}`);
          if (ec.products?.[0]) {
            console.log(`    first: ${ec.products[0].name?.slice(0,60)}`);
            console.log(`    first.url: ${ec.products[0].seo?.canonicalUrl?.slice(-70)}`);
          }
        } else if (j.products) {
          console.log(`    products: ${j.products.length}, totalProductsCount=${j.totalProductsCount}`);
        } else {
          console.log(`    keys: ${Object.keys(j).slice(0,10)}`);
        }
      } catch {
        console.log(`    raw: ${(c.respBody || '').slice(0, 200)}`);
      }
    }
  }

  require('fs').writeFileSync('scripts/tb-captures4.json', JSON.stringify(captures, null, 2));
  await page.close(); await ctx.close(); await browser.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
