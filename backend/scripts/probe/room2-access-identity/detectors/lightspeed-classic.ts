// backend/scripts/probe/room2-access-identity/detectors/lightspeed-classic.ts
// LightSpeed Classic — the legacy SEOshop / Lightspeed Retail eCommerce platform
// (acquired by Lightspeed in 2015, distinct from the modern hosted eCom). Classic
// shops serve theme assets from `cdn.webshopapp.com/shops/<shopId>/...` as the
// PRIMARY origin and do NOT reference `cdn.shoplightspeed.com/shops/.../themes/`.
//
// IMPORTANT — distinguishing from eCom:
// - eCom shops sometimes embed a 3rd-party `cdn.webshopapp.com/shops/<otherId>/files/`
//   script (e.g. fulcrum-outdoors uses shop 665196 on shoplightspeed CDN but loads
//   a custom theme script from webshopapp shop 328021). That pattern uses `/files/`,
//   not `/themes/`. We require BOTH a webshopapp themes/ asset AND the absence of a
//   shop-scoped shoplightspeed CDN reference to fire — eCom always wins when both
//   are present (eCom emits the shop-scoped path, Classic does not).
// - The "InStijl Dream Theme" or `.productborder` selectors are theme-level markers,
//   NOT platform markers — gagnonsports uses Dream Theme on eCom platform, so theme
//   age cannot be used to distinguish Classic vs eCom.
//
// Fleet note (2026-04-25): no confirmed LightSpeed Classic site in the 5-site
// validation set. gagnonsports.com — previously tagged "Classic" in audit history
// — is actually eCom (cdn.shoplightspeed.com/shops/626968/themes/9544). This
// detector is implemented for future fleet expansion, not for current validation.
import type { PlatformDetector } from '../platform-detect';

export const lightspeedClassicDetector: PlatformDetector = {
  id: 'lightspeed-classic',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Disqualifier: if the page emits a shop-scoped shoplightspeed CDN path, it is
    // eCom (the modern platform). Classic never emits this.
    const isEcom = /cdn\.shoplightspeed\.com\/shops\/\d+\/themes\/\d+/.test(html);
    if (isEcom) {
      return { matched: false, confidence: 'low', signals: { ecomDisqualifier: true } };
    }

    // Primary marker: shop-scoped webshopapp THEMES asset. Classic platform always
    // serves theme files from `/shops/<id>/themes/<id>/...` on webshopapp.
    const themeMatch = html.match(/cdn\.webshopapp\.com\/shops\/(\d+)\/themes\//);
    if (themeMatch) {
      signals.webshopappThemeAsset = true;
      signals.shopId = themeMatch[1];
      matched = true;
      confidence = 'high';
    } else if (/cdn\.webshopapp\.com\/shops\/\d+/.test(html)) {
      // Lower-confidence: any shop-scoped webshopapp reference (e.g. /files/).
      // On its own this is weak — eCom shops can load custom JS from webshopapp
      // — so only fire low. The eCom disqualifier above already filtered the
      // common false-positive case.
      signals.webshopappShopAsset = true;
      matched = true;
      confidence = 'low';
    }

    // Corroborating marker: same Lightspeed Netherlands B.V. copyright string is
    // emitted by the Classic template engine too. Only bumps confidence if a
    // webshopapp asset was already matched.
    if (matched && /Lightspeed Netherlands B\.V\./i.test(html)) {
      signals.lightspeedCopyright = true;
      if (confidence === 'low') confidence = 'medium';
    }

    return { matched, confidence, signals };
  },
};
