// backend/scripts/probe/access-identity/detectors/magento-1x.ts
import type { PlatformDetector } from '../platform-detect';

// Magento 1.x (and OpenMage LTS — the M1 community fork). Distinguished from M2 by:
//   - `/skin/frontend/<package>/<theme>/` asset paths (M1 theme structure; M2 uses `/static/version.../frontend/...`)
//   - `/js/mage/` script paths (M1 framework JS; M2 uses requirejs/`/mage/requirejs/...`)
//   - `/catalog/product/view/id/<NN>/` product detail URLs (M1 routing; M2 uses URL keys)
//   - `var Mage = ` / `Mage.Cookies` global JS (M1 framework; absent in M2)
//   - "OpenMage" / "Magento Inc." footer text (informational hint)
//
// References: ellwoodepps.com audit (memory/34-site-audit-history.md #6, Mistake 11
// — the M1 URL filter bug where `/category/NN/` breadcrumb URLs were rejected).
export const magento1xDetector: PlatformDetector = {
  id: 'magento-1.x',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Strong M1-specific markers (NOT present in M2).
    const hasSkinFrontend = /\/skin\/frontend\/[a-z0-9_-]+\//i.test(html);
    const hasJsMage = /\/js\/mage\//i.test(html);
    const hasM1ProductUrl = /\/catalog\/product\/view\/id\/\d+/i.test(html);
    const hasMageGlobal = /\bvar\s+Mage\s*=/.test(html) || /\bMage\.Cookies\b/.test(html);
    const hasOpenMage = /OpenMage|magento-lts/i.test(html);

    if (hasSkinFrontend) signals.skinFrontendAssets = true;
    if (hasJsMage) signals.jsMagePath = true;
    if (hasM1ProductUrl) signals.m1ProductUrlPattern = true;
    if (hasMageGlobal) signals.mageGlobalJs = true;
    if (hasOpenMage) signals.openMageFooter = true;

    // Two or more M1-specific markers → high confidence.
    // One marker → medium confidence (could be theme leftover).
    const m1MarkerCount = [hasSkinFrontend, hasJsMage, hasM1ProductUrl, hasMageGlobal, hasOpenMage]
      .filter(Boolean).length;

    if (m1MarkerCount >= 2) {
      matched = true;
      confidence = 'high';
    } else if (m1MarkerCount === 1) {
      matched = true;
      confidence = 'medium';
    }

    return { matched, confidence, signals };
  },
};
