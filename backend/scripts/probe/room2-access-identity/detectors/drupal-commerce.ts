// backend/scripts/probe/room2-access-identity/detectors/drupal-commerce.ts
// Drupal CMS with a Commerce or classifieds storefront layer (composite). Plain
// Drupal (a content site) is out of scope — this detector only fires when the
// Drupal core is paired with evidence of a transactional/listing layer (Drupal
// Commerce module OR a classifieds/listing app like SimpleAds + a node--type-
// classified content type).
//
// Composite rule:
//   high   — Drupal core evidence (`x-generator: Drupal N` HEADER OR meta generator)
//            AND commerce/classifieds evidence (`x-commerce-core` HEADER OR
//            `Drupal.org); Commerce N` in meta-generator OR classifieds-specific
//            view/teaser markers in body)
//   medium — only corroborating Drupal markers (cache-tags header / theme paths)
//            AND commerce/classifieds evidence
//   low/no — only one side present → matched:false (plain Drupal CMS without
//            storefront should remain unclassified by this detector)
//
// Reference markers verified live (2026-04-26):
// - www.gunpost.ca (Drupal-classifieds reference site, Mistake 37). Cloudflare
//   in front but rule-selective — current axios fetch returned 200 cleanly.
//   Headers (case-insensitive, lower-cased by shared/fetch.ts):
//   - `x-generator: Drupal 10 (https://www.drupal.org)` (definitive Drupal core)
//   - `x-drupal-cache-tags: ...` (Drupal cache layer — corroborating)
//   - `x-drupal-dynamic-cache: UNCACHEABLE (poor cacheability)` (corroborating)
//   - `x-drupal-cache-max-age: 0 (Uncacheable)` (corroborating)
//   - `x-commerce-core: 2` (Drupal Commerce module — definitive commerce side)
//   Body:
//   - `<meta name="Generator" content="Drupal 10 (https://www.drupal.org); Commerce 2">`
//   - `/sites/default/files/`, `/themes/custom/gunpost/`, `/core/misc/`,
//     `/modules/contrib/`, `/modules/custom/`
//   - Cache-tags include `views.view.classifieds`, `views.view.simpleads_*`,
//     `field.storage.node.field_classified_*`, `simpleads:*`
//   - SimpleAds is gunpost's classifieds-listings module (Mistake 37 calls out
//     facet-trap on `gunpost-teaser` / classified facets)
//
// Mistake 37 (playbook): Drupal-classifieds discovery hits a facet-trap on
// `/category/<term>?f[0]=...&f[1]=...&...` where each click adds another `f[N]`.
// This detector only identifies the platform; the facet trap is a Room-4
// pagination concern handled by Drupal-aware URL filtering.
import type { PlatformDetector } from '../platform-detect';

export const drupalCommerceDetector: PlatformDetector = {
  id: 'drupal-commerce',
  async detect({ html, headers }) {
    const signals: Record<string, unknown> = {};

    // ── Drupal side (definitive vs corroborating) ───────────────────────────
    // Definitive: `x-generator: Drupal N` HEADER (Drupal emits this by default;
    // version captured for diagnostics). NOTE: this is a HEADER, not body.
    const xGeneratorHeader = headers?.['x-generator'] ?? '';
    const drupalHeaderMatch = xGeneratorHeader.match(/^Drupal\s+(\d+)/i);
    if (drupalHeaderMatch) {
      signals.drupalHeaderGenerator = true;
      signals.drupalVersion = drupalHeaderMatch[1];
    }
    // Definitive: `<meta name="Generator" content="Drupal N ...">` body marker
    // (Drupal emits both; either is sufficient).
    const drupalBodyMetaMatch = html.match(
      /<meta\s+name=["']Generator["']\s+content=["']Drupal\s+(\d+)\b[^"']*["']/i,
    );
    if (drupalBodyMetaMatch) {
      signals.drupalBodyMetaGenerator = true;
      if (!signals.drupalVersion) signals.drupalVersion = drupalBodyMetaMatch[1];
    }
    // Corroborating: Drupal HTTP cache headers (only Drupal emits these) and
    // Drupal-specific path conventions in the body.
    const hasDrupalCacheHeaders =
      'x-drupal-cache-tags' in (headers ?? {}) ||
      'x-drupal-dynamic-cache' in (headers ?? {}) ||
      'x-drupal-cache-max-age' in (headers ?? {});
    if (hasDrupalCacheHeaders) signals.drupalCacheHeaders = true;
    const hasDrupalPaths =
      /\/sites\/default\/files\//i.test(html) ||
      /\/core\/misc\/[a-z0-9._-]+\.js/i.test(html) ||
      /\bDrupal\.behaviors\b/.test(html);
    if (hasDrupalPaths) signals.drupalPaths = true;

    // ── Commerce / classifieds side (definitive vs corroborating) ───────────
    // Definitive: Drupal Commerce core header (only the Commerce module emits this).
    const hasCommerceCoreHeader = !!headers?.['x-commerce-core'];
    if (hasCommerceCoreHeader) {
      signals.commerceCoreHeader = true;
      signals.commerceCoreVersion = headers['x-commerce-core'];
    }
    // Definitive: meta-generator inline-mention of Commerce N (Drupal renders
    // both Drupal version and Commerce version in the same meta tag).
    const hasCommerceInGenerator =
      /\bCommerce\s+\d+\b/i.test(xGeneratorHeader) ||
      /<meta\s+name=["']Generator["']\s+content=["'][^"']*Commerce\s+\d+\b[^"']*["']/i.test(html);
    if (hasCommerceInGenerator) signals.commerceInGenerator = true;
    // Corroborating: classifieds/storefront markers in body — these distinguish
    // a transactional Drupal site from a plain Drupal CMS. Includes both the
    // Drupal Commerce conventions (`commerce-product`, `commerce-cart`) and the
    // classifieds-style content types referenced in Mistake 37.
    const hasClassifiedsOrCommerceBody =
      /\bnode--type-(?:classified|product|simpleads|ad)\b/i.test(html) ||
      /\bcommerce[_-](?:product|cart|checkout|order)\b/i.test(html) ||
      /\bview-(?:classifieds|simpleads|commerce-[a-z-]+)\b/i.test(html) ||
      /\b(?:gunpost|classified)-teaser\b/i.test(html) ||
      /\bsimpleads_(?:list|view|homepage)\b/i.test(html);
    if (hasClassifiedsOrCommerceBody) signals.classifiedsOrCommerceBody = true;

    const drupalSidePresent =
      drupalHeaderMatch || drupalBodyMetaMatch || hasDrupalCacheHeaders || hasDrupalPaths;
    const commerceSidePresent =
      hasCommerceCoreHeader || hasCommerceInGenerator || hasClassifiedsOrCommerceBody;

    // Composite rule: BOTH sides required. Plain Drupal CMS (no commerce/listing
    // layer) → matched:false, leaving it unclassified by this detector.
    if (!(drupalSidePresent && commerceSidePresent)) {
      return { matched: false, confidence: 'low', signals };
    }

    // High confidence: definitive Drupal marker (header or meta generator) AND
    // definitive commerce marker (x-commerce-core header or Commerce in generator).
    const definitiveDrupal = !!drupalHeaderMatch || !!drupalBodyMetaMatch;
    const definitiveCommerce = hasCommerceCoreHeader || hasCommerceInGenerator;
    const confidence: 'high' | 'medium' | 'low' =
      definitiveDrupal && definitiveCommerce ? 'high' : 'medium';
    return { matched: true, confidence, signals };
  },
};
