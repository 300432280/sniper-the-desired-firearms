const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const ORIGIN = 'https://alsimmonsgunshop.com';

(async () => {
  // Check WP REST API total
  const wpResp = await axios.get(`${ORIGIN}/wp-json/wp/v2/product`, {
    params: { per_page: 1, page: 1 },
    timeout: 15000,
  });
  console.log('WP REST API total products:', wpResp.headers['x-wp-total']);
  console.log('WP REST API total pages:', wpResp.headers['x-wp-totalpages']);

  // Check Store API total (in-stock only)
  const storeResp = await axios.get(`${ORIGIN}/wp-json/wc/store/v1/products`, {
    params: { per_page: 1, page: 1 },
    timeout: 15000,
  });
  console.log('\nStore API total (in-stock):', storeResp.headers['x-wp-total']);

  // Check our DB
  const site = await p.monitoredSite.findFirst({ where: { domain: 'alsimmonsgunshop.com' } });
  const total = await p.productIndex.count({ where: { siteId: site.id } });
  const active = await p.productIndex.count({ where: { siteId: site.id, isActive: true } });
  console.log('\nOur DB total:', total);
  console.log('Our DB active:', active);

  // Check if there are products with numeric-only URLs (like /product/33693/)
  const numericUrls = await p.productIndex.count({
    where: { siteId: site.id, url: { contains: '/product/' } },
  });
  console.log('Products with /product/ in URL:', numericUrls);

  // Check the specific URL user mentioned
  try {
    const resp = await axios.get(`${ORIGIN}/product/33693/`, {
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    console.log('\n/product/33693/ status:', resp.status);
    const title = resp.data.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    console.log('/product/33693/ title:', title?.trim());
  } catch (err) {
    console.log('/product/33693/ error:', err.message);
  }

  await p.$disconnect();
})();
