// backend/scripts/probe/room2-access-identity/detectors/volusion.ts
// Volusion — hosted ASP-classic SaaS storefront. Two definitive signatures:
//   1. `x-powered-by: Volusion` response header (Volusion's edge always emits it,
//      even on 301 redirects from apex; never set by other platforms).
//   2. `set-cookie: volses=...` session cookie (Volusion-specific name).
// Body markers (any present is corroborating):
//   - `/v/vspfiles/` asset path — Volusion's distinctive template/photo directory
//     served on every category, product, and homepage. Merchant cannot rename it.
//   - `/a/j/volusion.js` global cart/observer client emitted on every page.
//   - `volusion.ready(...)` / `volusion.cart.*` JS API calls (cart count widget).
//   - `cdn4.volusion.store` (or other `*.volusion.store` CDN) — used by some shops.
//   - `Default.asp`, `ProductDetails.asp`, `category_s/<id>.htm` URL conventions.
//
// Reference markers verified live (2026-04-26):
// - precisionoptics.net (audit history #22 — Volusion + cf-passive-with-owasp).
//   Apex 301-redirects to www; both responses carry `x-powered-by: Volusion` and
//   `set-cookie: volses=...`. Body uses `/v/vspfiles/templates/precisionopt/...`,
//   `/a/j/volusion.js`, `volusion.ready(...)` global, and `category_s/<id>.htm`
//   nav links. Cookie set-cookie is observable in axios response headers.
//
// NOTE: cookies parameter receives parsed cookie names from upstream (when a prior
// fetch captured Set-Cookie) but axios response `headers` already contains the raw
// `set-cookie` string. We check both to handle both code paths.
import type { PlatformDetector } from '../platform-detect';

export const volusionDetector: PlatformDetector = {
  id: 'volusion',
  async detect({ html, headers, cookies }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Definitive header marker — Volusion's edge sets this on every response.
    // Headers are lowercased by shared/fetch.ts.
    const xPoweredBy = headers?.['x-powered-by'] ?? '';
    if (/volusion/i.test(xPoweredBy)) {
      signals.xPoweredByVolusion = xPoweredBy;
      matched = true;
      confidence = 'high';
    }

    // Definitive cookie marker — `volses` is Volusion's session cookie name.
    // Check raw set-cookie header (axios) and parsed cookies array (alt path).
    const setCookieHeader = headers?.['set-cookie'] ?? '';
    if (/\bvolses=/i.test(setCookieHeader) || cookies.some(c => /^volses\b/i.test(c))) {
      signals.volsesCookie = true;
      matched = true;
      confidence = 'high';
    }

    // Body marker: `/v/vspfiles/` template/asset directory. Volusion-specific.
    if (/\/v\/vspfiles\//i.test(html)) {
      signals.vspfilesPath = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
      else if (confidence === 'medium') confidence = 'high';
    }

    // Body marker: `/a/j/volusion.js` cart-observer script — emitted on every page.
    if (/\/a\/j\/volusion\.js/i.test(html)) {
      signals.volusionJs = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    // Body marker: `volusion.ready(` / `volusion.cart.` JS calls.
    if (/\bvolusion\.(?:ready|cart|product)\b/.test(html)) {
      signals.volusionGlobalApi = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    // Body marker: Volusion CDN host (some shops serve assets from there).
    if (/cdn\d*\.volusion\.store/i.test(html)) {
      signals.volusionCdn = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    return { matched, confidence, signals };
  },
};
