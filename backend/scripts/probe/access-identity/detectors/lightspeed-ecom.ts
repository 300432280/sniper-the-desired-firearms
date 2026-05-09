// backend/scripts/probe/access-identity/detectors/lightspeed-ecom.ts
// LightSpeed eCom (hosted Shoplightspeed). The modern hosted platform — distinct
// from LightSpeed Classic (legacy SEOshop / Lightspeed Retail). All hosted eCom
// shops serve assets from `cdn.shoplightspeed.com/shops/<shopId>/themes/<themeId>/`
// regardless of theme (Nova, Dream Theme, custom). The Lightspeed Netherlands B.V.
// copyright comment is emitted by the eCom template engine on every page.
//
// Reference markers verified live (2026-04-25):
// - solelyoutdoors.com           (shop 613284, Theme Nova v1.5.1)
// - fulcrum-outdoors.shoplightspeed.com (shop 665196, theme 17627)
// - jobrookoutdoors.com          (shop 606469, theme 3750)
// - gagnonsports.com             (shop 626968, InStijl Dream Theme — was mis-tagged
//                                 as "Classic" in earlier audits but is in fact eCom)
import type { PlatformDetector } from '../platform-detect';

export const lightspeedEcomDetector: PlatformDetector = {
  id: 'lightspeed-ecom',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Highest-specificity marker: per-shop CDN path. Every eCom theme references this.
    const shopCdnMatch = html.match(/cdn\.shoplightspeed\.com\/shops\/(\d+)\/themes\/(\d+)/);
    if (shopCdnMatch) {
      signals.cdnShopAsset = true;
      signals.shopId = shopCdnMatch[1];
      signals.themeId = shopCdnMatch[2];
      matched = true;
      confidence = 'high';
    } else if (/cdn\.shoplightspeed\.com/.test(html)) {
      // Fallback: shared-asset CDN reference (e.g. html5shiv) — present even when
      // shop-scoped theme assets are inlined or proxied.
      signals.cdnSharedAsset = true;
      matched = true;
      confidence = 'medium';
    }

    // Template-emitted copyright comment — Lightspeed Netherlands B.V. is the eCom
    // entity (vs. Lightspeed POS / Retail which has different branding).
    if (/Lightspeed Netherlands B\.V\./i.test(html)) {
      signals.lightspeedCopyright = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    return { matched, confidence, signals };
  },
};
