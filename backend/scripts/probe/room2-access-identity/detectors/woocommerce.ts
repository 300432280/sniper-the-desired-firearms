// backend/scripts/probe/room2-access-identity/detectors/woocommerce.ts
import type { PlatformDetector } from '../platform-detect';
import { fetchUrl } from '../../shared/fetch';

export const woocommerceDetector: PlatformDetector = {
  id: 'woocommerce',
  async detect({ url, html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;
    if (/<meta\s+name="generator"\s+content="WooCommerce/i.test(html)) {
      signals.metaGenerator = true;
      matched = true;
      confidence = 'high';
    }
    if (/wp-content\/plugins\/woocommerce/.test(html)) {
      signals.pluginAsset = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }
    // WP REST probe (low cost, definitive)
    try {
      const u = new URL(url);
      const r = await fetchUrl(`${u.protocol}//${u.hostname}/wp-json/wp/v2/product?per_page=1`, { timeoutMs: 8000 });
      if (r.status === 200 && r.headers['x-wp-total']) {
        signals.wpRestReachable = true;
        signals.xWpTotal = r.headers['x-wp-total'];
        matched = true;
        confidence = 'high';
      }
    } catch { /* not reachable */ }
    return { matched, confidence, signals };
  },
};
