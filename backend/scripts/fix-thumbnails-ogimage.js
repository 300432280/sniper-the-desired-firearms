/**
 * Fix missing thumbnails for WooCommerce sites using og:image from product pages.
 *
 * Root cause: Many WooCommerce products have featured_media=0 (no featured image
 * set in WordPress), so WP REST API _embed returns nothing. But product pages
 * still have images via og:image meta tag or WooCommerce gallery.
 *
 * Usage: node scripts/fix-thumbnails-ogimage.js <domain>
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

const domain = process.argv[2];
if (!domain) { console.log('Usage: node fix-thumbnails-ogimage.js <domain>'); process.exit(1); }

// Filter out site logos / placeholder images
function isPlaceholder(url) {
  if (!url) return true;
  return /logo|placeholder|woocommerce-placeholder|no-image|default-product/i.test(url);
}

async function main() {
  const site = await p.monitoredSite.findFirst({ where: { domain } });
  if (!site) { console.log('Site not found'); process.exit(1); }

  const noThumb = await p.productIndex.findMany({
    where: { siteId: site.id, thumbnail: null, isActive: true },
    select: { id: true, url: true, title: true },
  });
  console.log(`Products missing thumbnails: ${noThumb.length}`);

  // Phase 1: Try Store API for in-stock items (bulk, fast)
  console.log('\n=== Phase 1: Store API bulk fetch ===');
  const storeImages = new Map(); // url -> imageUrl
  let storePage = 1;
  let storePages = 1;
  while (storePage <= storePages) {
    try {
      const resp = await axios.get(`https://${domain}/wp-json/wc/store/v1/products`, {
        params: { per_page: 100, page: storePage },
        timeout: 20000,
        validateStatus: (s) => s === 200,
      });
      if (storePage === 1) {
        storePages = parseInt(resp.headers['x-wp-totalpages'] || '1', 10);
        console.log(`Store API: ${resp.headers['x-wp-total']} products, ${storePages} pages`);
      }
      for (const prod of resp.data) {
        const img = prod.images?.[0]?.src || prod.images?.[0]?.thumbnail;
        if (img && !isPlaceholder(img)) {
          const url = prod.permalink || '';
          storeImages.set(url, img);
          storeImages.set(url.replace(/\/$/, ''), img);
        }
      }
      process.stdout.write(`  Page ${storePage}/${storePages}\r`);
      storePage++;
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.log(`\nStore API error on page ${storePage}: ${err.message}`);
      break;
    }
  }
  console.log(`\nStore API images collected: ${Math.floor(storeImages.size / 2)}`);

  let updated = 0;
  let storeFixed = 0;
  const needsHtmlFetch = [];

  for (const prod of noThumb) {
    const storeImg = storeImages.get(prod.url) || storeImages.get(prod.url.replace(/\/$/, ''));
    if (storeImg) {
      await p.productIndex.update({ where: { id: prod.id }, data: { thumbnail: storeImg } });
      updated++;
      storeFixed++;
    } else {
      needsHtmlFetch.push(prod);
    }
  }
  console.log(`Phase 1 done: ${storeFixed} fixed via Store API, ${needsHtmlFetch.length} need HTML fetch`);

  // Phase 2: Fetch og:image from product pages for remaining
  console.log('\n=== Phase 2: og:image from product pages ===');
  let ogFixed = 0;
  let noImage = 0;
  let errors = 0;

  for (let i = 0; i < needsHtmlFetch.length; i++) {
    const prod = needsHtmlFetch[i];
    try {
      const resp = await axios.get(prod.url, { timeout: 15000, validateStatus: (s) => s === 200 });
      const html = resp.data;

      // Try og:image first (most reliable)
      let thumb = null;
      const ogMatch = html.match(/property="og:image"\s+content="([^"]+)"/);
      if (ogMatch && !isPlaceholder(ogMatch[1])) {
        thumb = ogMatch[1];
      }

      // Fallback: WooCommerce gallery data-large_image
      if (!thumb) {
        const galleryMatch = html.match(/data-large_image="([^"]+)"/);
        if (galleryMatch && !isPlaceholder(galleryMatch[1])) {
          thumb = galleryMatch[1];
        }
      }

      // Fallback: product image with wp-post-image class, data-src
      if (!thumb) {
        const dataSrcMatch = html.match(/wp-post-image[^>]*data-src="([^"]+)"/);
        if (dataSrcMatch && !isPlaceholder(dataSrcMatch[1])) {
          thumb = dataSrcMatch[1];
        }
      }

      if (thumb) {
        await p.productIndex.update({ where: { id: prod.id }, data: { thumbnail: thumb } });
        updated++;
        ogFixed++;
      } else {
        noImage++;
      }
    } catch {
      errors++;
    }

    if ((i + 1) % 25 === 0 || i === needsHtmlFetch.length - 1) {
      process.stdout.write(`  ${i + 1}/${needsHtmlFetch.length}: ${ogFixed} og:image, ${noImage} no image, ${errors} errors\r`);
    }
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`\n\nDone: ${updated} total fixed (${storeFixed} Store API + ${ogFixed} og:image)`);
  console.log(`No image found: ${noImage} | Errors: ${errors}`);

  const remaining = await p.productIndex.count({ where: { siteId: site.id, thumbnail: null, isActive: true } });
  console.log(`Still missing thumbnails: ${remaining}`);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
