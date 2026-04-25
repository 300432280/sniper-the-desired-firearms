// backend/scripts/probe/room2-access-identity/detectors/shopify.ts
import type { PlatformDetector } from '../platform-detect';
import { fetchUrl } from '../../shared/fetch';

export const shopifyDetector: PlatformDetector = {
  id: 'shopify',
  async detect({ url, html, headers }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;
    if (/cdn\.shopify\.com/.test(html) || /Shopify\.theme/.test(html)) {
      signals.cdnAsset = true;
      matched = true;
      confidence = 'medium';
    }
    if (/x-shopid/i.test(Object.keys(headers).join(','))) {
      signals.xShopIdHeader = true;
      matched = true;
      confidence = 'high';
    }
    try {
      const u = new URL(url);
      const r = await fetchUrl(`${u.protocol}//${u.hostname}/products/count.json`, { timeoutMs: 8000 });
      if (r.status === 200 && /^\s*\{\s*"count"/.test(r.body)) {
        signals.productsCountJson = true;
        matched = true;
        confidence = 'high';
      }
    } catch { /* not reachable */ }
    return { matched, confidence, signals };
  },
};
