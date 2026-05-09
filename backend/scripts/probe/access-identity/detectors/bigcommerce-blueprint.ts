// backend/scripts/probe/access-identity/detectors/bigcommerce-blueprint.ts
import type { PlatformDetector } from '../platform-detect';

// BigCommerce Blueprint (legacy theme framework, pre-Stencil). Distinguishing
// signature vs Stencil: presence of BC asset/data markers WITHOUT the explicit
// `<meta name="platform" content="bigcommerce.stencil">` tag and WITHOUT
// `Stencil.storefrontAPIToken` / `window.stencilBootstrap`. Blueprint historically
// uses `/xmlsitemap.php` as sitemap index, mixed `.html` legacy URL conventions,
// and exposes `var BCData = {}` without the Stencil bootstrap envelope.
//
// IMPORTANT: This detector intentionally returns matched:false when ANY Stencil
// signature is present so the registry's confidence-rank tiebreaker hands the
// match to bigcommerce-stencil. BC asset markers (cdn11, BCData) appear on BOTH
// Blueprint and Stencil — they cannot distinguish on their own.
//
// Reference: frontierfirearms.ca historical audit (memory/34-site-audit-history.md #8).
// As of 2026-04-24 live re-investigation, frontierfirearms.ca has been migrated
// to Stencil (carries the platform meta + window.stencilBootstrap), so this
// detector now fires on no current fleet site. It remains in the registry to
// classify any genuine Blueprint sites added later.
export const bigcommerceBlueprintDetector: PlatformDetector = {
  id: 'bigcommerce-blueprint',
  async detect({ html }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Hard-exclude Stencil — if any Stencil-only marker is present, defer.
    const hasStencilMeta = /<meta\s+name=["']platform["']\s+content=["']bigcommerce\.stencil["']/i.test(html);
    const hasStencilBootstrap = /window\.stencilBootstrap\s*\(/.test(html);
    const hasStencilToken = /Stencil\.storefrontAPIToken/.test(html);
    if (hasStencilMeta || hasStencilBootstrap || hasStencilToken) {
      return { matched: false, confidence: 'low', signals: { stencilSignaturesPresent: true } };
    }

    // Positive BC signals (any BC variant).
    const hasBcCdn = /cdn11\.bigcommerce\.com/i.test(html);
    const hasBcData = /\bvar\s+BCData\s*=/.test(html);
    if (hasBcCdn) signals.bcCdnAsset = true;
    if (hasBcData) signals.bcDataGlobal = true;

    // Blueprint-leaning markers (legacy theme conventions).
    const hasXmlSitemapPhp = /\/xmlsitemap\.php/i.test(html);
    const hasLegacyHtmlNav = /href=["'][^"']+\.html(?:["'?#])/i.test(html);
    if (hasXmlSitemapPhp) signals.xmlsitemapPhp = true;
    if (hasLegacyHtmlNav) signals.legacyHtmlUrls = true;

    if (hasBcCdn || hasBcData) {
      matched = true;
      // BC marker + at least one Blueprint-leaning marker → medium confidence.
      // BC marker alone (no Stencil and no Blueprint hint) → low confidence (still BC, theme unclear).
      confidence = (hasXmlSitemapPhp || hasLegacyHtmlNav) ? 'medium' : 'low';
    }

    return { matched, confidence, signals };
  },
};
