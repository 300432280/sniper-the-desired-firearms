// backend/scripts/probe/room2-access-identity/detectors/ecwid-on-wordpress.ts
// Ecwid Storefront embedded on a WordPress host (composite). Ecwid is a hosted
// e-commerce widget that drops into any HTML page; on WordPress it's typically
// installed via the `ecwid-shopping-cart` plugin. Either side alone is NOT
// enough: Ecwid can run on Wix/Squarespace/static HTML, and WordPress is
// obviously generic CMS — only the COMBINATION pins the platform.
//
// Composite rule:
//   high   — Ecwid script tag (`app.ecwid.com/script.js?<storeId>`) AND
//            WordPress evidence (meta generator OR `wp-content/plugins|themes/`)
//   medium — corroborating Ecwid markers (`window.ec`, `Ecwid.init`,
//            `ecwid-shopping-cart` plugin path, `ecwidParams`) AND WordPress evidence
//   low/no — only one side present → matched:false (Ecwid alone classifies elsewhere;
//            WordPress alone is CMS-only without storefront)
//
// Reference markers verified live (2026-04-26):
// - www.triggersandbows.com (audit history #32). LiteSpeed origin (NOT CF/Sucuri),
//   no WAF challenge. Homepage emits:
//   - `<script charset="utf-8" data-cfasync="false" type="text/javascript"
//      src="https://app.ecwid.com/script.js?92697308" defer></script>` (storeId 92697308)
//   - `var ecwidParams = {"useJsApiToOpenStoreCategoriesPages":"","storeId":"92697308",...}`
//   - `Ecwid.init(...)`, `window.ec = window.ec || ...`
//   - `<meta name="generator" content="WordPress 6.9.4" />`
//   - `wp-content/plugins/ecwid-shopping-cart/...` (the official Ecwid WP plugin)
//   - `wp-content/themes/atm-triggers-bows/...`, `wp-includes/`, `wp-block-*` classes
//
// Mistake 31 (playbook): Ecwid storefront discovery requires the storeId and
// goes through Ecwid's public Storefront API (`app.ecwid.com/api/v3/<storeId>/...`)
// — capturing storeId here lets Room 4 pagination skip the WP HTML entirely.
import type { PlatformDetector } from '../platform-detect';

export const ecwidOnWordpressDetector: PlatformDetector = {
  id: 'ecwid-on-wordpress',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};

    // ── Ecwid side (definitive vs corroborating) ────────────────────────────
    // Definitive: official Ecwid script-loader URL with storeId in query.
    // Capturing the storeId here lets downstream rooms hit the Storefront API.
    const ecwidScriptMatch = html.match(/app\.ecwid\.com\/script\.js\?(\d+)/i);
    const hasEcwidScript = !!ecwidScriptMatch;
    if (hasEcwidScript && ecwidScriptMatch) {
      signals.ecwidScript = true;
      signals.ecwidStoreId = ecwidScriptMatch[1];
    }
    // Backup storeId source — sometimes the script is lazy-loaded, but ecwidParams
    // is rendered server-side by the WP plugin.
    const ecwidParamsMatch = html.match(/ecwidParams\s*=\s*\{[^}]*"storeId"\s*:\s*"?(\d+)"?/i);
    if (ecwidParamsMatch) {
      signals.ecwidParams = true;
      if (!signals.ecwidStoreId) signals.ecwidStoreId = ecwidParamsMatch[1];
    }
    // Corroborating: JS namespace and init calls.
    const hasEcwidJs =
      /\bEcwid\.(?:init|OnPageLoaded|OnAPILoaded|destroy)\b/.test(html) ||
      /\bwindow\.ec\b\s*=/.test(html) ||
      /\becwid-shopping-cart\b/i.test(html);
    if (hasEcwidJs) signals.ecwidJs = true;

    // ── WordPress side (definitive vs corroborating) ────────────────────────
    // Definitive: WP generator meta (emitted by core unless explicitly stripped).
    const hasWpGenerator =
      /<meta\s+name=["']generator["']\s+content=["']WordPress\b[^"']*["']/i.test(html);
    if (hasWpGenerator) signals.wpGenerator = true;
    // Corroborating: WP path conventions (themes/plugins/includes are WP-only).
    const hasWpPaths =
      /\/wp-content\/(?:plugins|themes|uploads)\//i.test(html) ||
      /\/wp-includes\//i.test(html);
    if (hasWpPaths) signals.wpPaths = true;
    // Corroborating: Gutenberg block classes / emoji shim — WP-specific output.
    const hasWpBlockOrEmoji =
      /\bwp-block-[a-z0-9-]+/i.test(html) || /\bwp-emoji\b/i.test(html);
    if (hasWpBlockOrEmoji) signals.wpBlockOrEmoji = true;

    const ecwidSidePresent = hasEcwidScript || hasEcwidJs || ecwidParamsMatch;
    const wpSidePresent = hasWpGenerator || hasWpPaths || hasWpBlockOrEmoji;

    // Composite rule: BOTH sides required. One side alone → matched:false.
    if (!(ecwidSidePresent && wpSidePresent)) {
      return { matched: false, confidence: 'low', signals };
    }

    // High confidence: definitive Ecwid script-loader + WordPress evidence.
    // Medium confidence: only corroborating Ecwid markers present.
    const confidence: 'high' | 'medium' | 'low' = hasEcwidScript ? 'high' : 'medium';
    return { matched: true, confidence, signals };
  },
};
