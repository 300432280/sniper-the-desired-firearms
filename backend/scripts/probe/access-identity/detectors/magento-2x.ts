// backend/scripts/probe/access-identity/detectors/magento-2x.ts
import type { PlatformDetector } from '../platform-detect';

// Magento 2.x. Distinctive markers (none of which exist in M1):
//   - `/static/version<digits>/frontend/<package>/<theme>/<locale>/` versioned static asset paths
//   - `requirejs-config[.min].js` and `mage/requirejs/mixins[.min].js` (M2's RequireJS module loader)
//   - `data-mage-init='{...}'` JSON component initialization attribute
//   - `Magento_Catalog`, `Magento_Theme`, `Magento_Captcha`, `Magento_PageBuilder` module class names
//   - `var require = { 'baseUrl': '...static/version.../frontend/...' }` (M2 RequireJS config)
//
// References: rdsc.ca, sail.ca, londerosports.com audits (memory/34-site-audit-history.md #18, #23, #25)
// + Mistake 20 (M2 sort values customizable). rdsc.ca was historically misclassified
// as 'bigcommerce' on the platform tag — this detector ensures unambiguous M2 detection.
export const magento2xDetector: PlatformDetector = {
  id: 'magento-2.x',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Strong M2-distinctive markers.
    const hasStaticVersion = /\/static\/version\d+\/frontend\//i.test(html);
    const hasRequireJsConfig = /requirejs-config(?:\.min)?\.js/i.test(html);
    const hasMageRequireJsMixins = /\/mage\/requirejs\/mixins/i.test(html);
    const hasDataMageInit = /\bdata-mage-init\b/i.test(html);
    const hasMagentoModule = /Magento_(?:Catalog|Theme|Captcha|PageBuilder|Ui)\b/.test(html);
    const hasM2RequireBaseUrl = /var\s+require\s*=\s*\{\s*['"]baseUrl['"]\s*:\s*['"][^'"]*static\\?\/version/i.test(html);

    if (hasStaticVersion) signals.staticVersionPath = true;
    if (hasRequireJsConfig) signals.requirejsConfig = true;
    if (hasMageRequireJsMixins) signals.mageRequirejsMixins = true;
    if (hasDataMageInit) signals.dataMageInit = true;
    if (hasMagentoModule) signals.magentoModuleClass = true;
    if (hasM2RequireBaseUrl) signals.m2RequireBaseUrl = true;

    const m2MarkerCount = [
      hasStaticVersion,
      hasRequireJsConfig,
      hasMageRequireJsMixins,
      hasDataMageInit,
      hasMagentoModule,
      hasM2RequireBaseUrl,
    ].filter(Boolean).length;

    // 2+ M2-distinctive markers → high confidence (no other platform has these together).
    // 1 marker → medium confidence.
    if (m2MarkerCount >= 2) {
      matched = true;
      confidence = 'high';
    } else if (m2MarkerCount === 1) {
      matched = true;
      confidence = 'medium';
    }

    return { matched, confidence, signals };
  },
};
