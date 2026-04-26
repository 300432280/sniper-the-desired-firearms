// backend/scripts/probe/room2-access-identity/detectors/odoo.ts
// Odoo (Website + eCommerce module). Open-source Python ERP/CMS where the public
// storefront is rendered by the `website_sale` module. Three definitive signatures
// (any one suffices for high confidence):
//   1. `<meta name="generator" content="Odoo"/>` (single OR double quotes, optional
//      trailing slash — varies by Odoo version 14/15/16/17).
//   2. `var odoo = {` global JS bootstrap — every Odoo page emits `odoo.__session_info__`,
//      `odoo.__assetsURL__`, `odoo.dr_theme_config` etc inside a top-level
//      `<script id="web.layout.odooscript">` block.
//   3. `oe_website_sale` CSS class — emitted by the website_sale module on shop
//      and product pages. Homepages of stores typically also reference it via
//      pre-loaded CSS (see goldnloan.com Theme Pixel which inlines selectors).
// Corroborating markers:
//   - `/web/assets/<bundle-id>/<hash>/<bundle-name>.min.{js,css}` — Odoo's
//      versioned asset endpoint (every page).
//   - `oe_structure`, `oe_currency_value` — additional `website_sale` classes.
//   - `tp-*` Theme Pixel prefix (popular Odoo theme family — present on
//      goldnloan.com but theme-specific so corroborating only).
//
// Mistake 22 (playbook): Odoo was historically MISLABELED as LightSpeed because
// both have a category page sort dropdown and similar URL conventions. The
// `<meta generator="Odoo">` and `var odoo = {` JS bootstrap are unique to Odoo
// and never appear on LightSpeed eCom or Classic.
//
// Reference markers verified live (2026-04-26):
// - outfitters.goldnloan.com (audit history #21 — Odoo, NOT LightSpeed). All
//   3 definitive markers present + `oe_structure`, `oe_website_sale`, `tp-*`
//   Theme Pixel selectors, `/web/assets/` bundle paths.
import type { PlatformDetector } from '../platform-detect';

export const odooDetector: PlatformDetector = {
  id: 'odoo',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Definitive meta marker — both quote styles, optional self-close.
    if (/<meta\s+name=["']generator["']\s+content=["']Odoo["']\s*\/?\s*>/i.test(html)) {
      signals.metaGenerator = 'Odoo';
      matched = true;
      confidence = 'high';
    }

    // Definitive JS bootstrap — `var odoo = {` followed by Odoo session keys.
    if (/var\s+odoo\s*=\s*\{/.test(html) && /odoo\.(?:__session_info__|__assetsURL__|define)\b/.test(html)) {
      signals.odooJsBootstrap = true;
      matched = true;
      confidence = 'high';
    }

    // Definitive `website_sale` module class — eCommerce-shop-specific.
    if (/\boe_website_sale\b/.test(html)) {
      signals.oeWebsiteSale = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
      else if (confidence === 'medium') confidence = 'high';
    }

    // Corroborating: Odoo `/web/assets/<bundle>/<hash>/...` versioned asset URL.
    // Pattern is `/web/assets/<digit>/<hex>/web.assets_*.min.{js,css}` — distinctive
    // to Odoo's asset bundler.
    if (/\/web\/assets\/\d+\/[a-f0-9]+\/web\.assets_/i.test(html)) {
      signals.odooAssetsBundle = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    // Corroborating: additional `website_sale` module classes.
    if (/\boe_(?:structure|currency_value|website|cart)\b/.test(html)) {
      signals.oeWebsiteClasses = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    return { matched, confidence, signals };
  },
};
