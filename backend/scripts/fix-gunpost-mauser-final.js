require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const p = new PrismaClient();

async function main() {
  const site = await p.monitoredSite.findUnique({ where: { domain: 'gunpost.ca' }, select: { id: true } });

  // Fix 1: browning 270 mauser thumbnail
  const browning = await p.productIndex.findFirst({
    where: { siteId: site.id, url: { contains: 'browning-270-mauser-action' } },
  });
  if (browning && !browning.thumbnail) {
    // Fetch og:image from the listing page
    try {
      const resp = await axios.get(browning.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 10000, maxRedirects: 5, validateStatus: () => true,
      });
      if (resp.status === 200 && typeof resp.data === 'string') {
        const ogMatch = resp.data.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
          || resp.data.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);
        if (ogMatch) {
          await p.productIndex.update({ where: { id: browning.id }, data: { thumbnail: ogMatch[1] } });
          console.log(`[FIX] browning thumbnail: ${ogMatch[1]}`);
        }
      }
    } catch (e) {
      console.log(`[ERR] browning fetch: ${e.message}`);
    }
  }

  // Fix 2: Update stale match price ($799 -> $769 for "priced to sell")
  const staleMatch = await p.match.findFirst({
    where: {
      url: { contains: 'rare-mauser-obendorf-model-2000-270-win-priced-sell' },
      price: 799,
    },
  });
  if (staleMatch) {
    // Check what ProductIndex says
    const pi = await p.productIndex.findFirst({
      where: { url: { contains: 'rare-mauser-obendorf-model-2000-270-win-priced-sell' } },
      select: { id: true, price: true },
    });
    if (pi && pi.price !== 799) {
      // Link the match to PI if not already linked
      await p.match.update({
        where: { id: staleMatch.id },
        data: { productIndexId: pi.id },
      });
      console.log(`[FIX] Linked stale match to PI (price will now show ${pi.price} via enrichment)`);
    }
  }

  await p.$disconnect();
  console.log('Done');
}
main().catch(e => { console.error(e); process.exit(1); });
