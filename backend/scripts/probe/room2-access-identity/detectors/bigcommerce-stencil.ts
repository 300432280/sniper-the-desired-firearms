// backend/scripts/probe/room2-access-identity/detectors/bigcommerce-stencil.ts
import type { PlatformDetector } from '../platform-detect';

export const bigcommerceStencilDetector: PlatformDetector = {
  id: 'bigcommerce-stencil',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;
    // Stencil emits the meta tag with EITHER single or double quotes depending on
    // theme/version (e.g. theammosource.com uses single quotes).
    if (/<meta\s+name=["']platform["']\s+content=["']bigcommerce\.stencil["']/i.test(html)) {
      signals.platformMeta = 'bigcommerce.stencil';
      matched = true;
      confidence = 'high';
    } else if (/cdn11\.bigcommerce\.com.*stencil/i.test(html)) {
      signals.cdnStencilAsset = true;
      matched = true;
      confidence = 'medium';
    }
    if (/Stencil\.storefrontAPIToken/.test(html)) {
      signals.storefrontApiToken = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }
    return { matched, confidence, signals };
  },
};
