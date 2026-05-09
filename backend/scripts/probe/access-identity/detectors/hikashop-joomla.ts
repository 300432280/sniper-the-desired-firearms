// backend/scripts/probe/access-identity/detectors/hikashop-joomla.ts
// HikaShop on Joomla (composite). HikaShop is a Joomla! eCommerce extension
// (com_hikashop) — neither marker alone is sufficient: a Joomla site without
// HikaShop is a CMS-only deploy, and HikaShop assets technically can be
// referenced from a non-Joomla wrapper (rare). This detector requires BOTH
// HikaShop AND Joomla evidence to claim a HikaShop-on-Joomla match. When only
// one side is present the detector returns matched:false so the registry can
// remain silent (no over-confident generic-Joomla classification).
//
// Composite rule:
//   high   — HikaShop component path (`/media/com_hikashop/` OR `/components/com_hikashop/`)
//            AND Joomla evidence (meta generator OR `/templates/<theme>/` path)
//   medium — `hikashop_*` CSS class/id/JS variable AND Joomla evidence
//   low/no — only one side present → matched:false
//
// Reference markers verified live (2026-04-26):
// - www.lockharttactical.com (audit history #17). Subdomain-selective Cloudflare
//   (apex challenged, www clean — handled by Task 3.1 canonical-host). www
//   homepage emits:
//   - `<meta name="generator" content="Joomla! - Open Source Content Management - Version 4.4.2">`
//   - `<link href="/media/com_hikashop/css/hikashop.css?v=504" rel="stylesheet" />`
//   - `<link href="/media/com_hikashop/css/frontend_default.css?...">`
//   - `<script src="/media/com_hikashop/js/hikashop.js?v=504">`
//   - `/templates/r_gear/...` Joomla theme path
//   - `/media/system/css/joomla-fontawesome.min.css` Joomla core asset
//   - inline blocks like `#hikashop_category_information_module_489`,
//     `.hikashop_product_page`, `window.cartNotifyParams = ...`
//
// NOTE: pagination convention `offset-query template='limitstart' perPage=40` is
// HikaShop's standard contract — consumed by the navigation stage, not relevant here.
import type { PlatformDetector } from '../platform-detect';

export const hikashopJoomlaDetector: PlatformDetector = {
  id: 'hikashop-joomla',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};

    // ── HikaShop side (definitive vs corroborating) ─────────────────────────
    // Definitive: component asset path (cannot be renamed without forking the
    // extension's resource loader).
    const hasHikashopComponentPath =
      /\/(?:media|components|administrator\/components)\/com_hikashop\b/i.test(html);
    // Corroborating: `hikashop_*` CSS class/id/JS — themeable but ubiquitous.
    const hasHikashopClassOrJs =
      /\bhikashop_(?:product|category|cart|checkout|container|subcontainer)\b/i.test(html) ||
      /\bvar\s+hikashop\s*=\s*\{/.test(html);

    if (hasHikashopComponentPath) signals.hikashopComponentPath = true;
    if (hasHikashopClassOrJs) signals.hikashopClassOrJs = true;

    // ── Joomla side (definitive vs corroborating) ───────────────────────────
    // Definitive: meta generator (Joomla emits it on every page unless stripped).
    const hasJoomlaMeta = /<meta\s+name=["']generator["']\s+content=["']Joomla!?\b[^"']*["']/i.test(html);
    // Corroborating: `/templates/<theme>/` (Joomla template path) and `/media/system/`
    // or `/media/jui/` (Joomla core media bundles).
    const hasJoomlaTemplatePath = /\/templates\/[A-Za-z0-9_-]+\/(?:css|js|images|custom)\b/i.test(html);
    const hasJoomlaCoreMedia = /\/media\/(?:system|jui)\//i.test(html);

    if (hasJoomlaMeta) signals.joomlaMetaGenerator = true;
    if (hasJoomlaTemplatePath) signals.joomlaTemplatePath = true;
    if (hasJoomlaCoreMedia) signals.joomlaCoreMedia = true;

    const hikashopSidePresent = hasHikashopComponentPath || hasHikashopClassOrJs;
    const joomlaSidePresent = hasJoomlaMeta || hasJoomlaTemplatePath || hasJoomlaCoreMedia;

    // Composite rule: BOTH sides required. One side alone → matched:false.
    if (!(hikashopSidePresent && joomlaSidePresent)) {
      return { matched: false, confidence: 'low', signals };
    }

    // High confidence: definitive HikaShop marker (component path) + Joomla evidence.
    // Medium confidence: only the corroborating HikaShop marker present.
    const confidence: 'high' | 'medium' | 'low' = hasHikashopComponentPath ? 'high' : 'medium';
    return { matched: true, confidence, signals };
  },
};
