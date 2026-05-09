// backend/scripts/probe/access-identity/detectors/nopcommerce.ts
// nopCommerce — open-source ASP.NET storefront (Microsoft IIS origin, often
// Cloudflare-fronted in deployments). Three definitive signatures (any one
// suffices for high confidence):
//   1. `<meta name="generator" content="nopCommerce" />` (single OR double
//      quotes, with or without trailing slash — sites vary by template version).
//   2. `set-cookie: Nop.customer=...` response cookie — nopCommerce's anonymous
//      customer-tracking cookie, always emitted on first visit to any page.
//   3. `<!--Powered by nopCommerce - http://www.nopCommerce.com-->` HTML comment
//      hard-coded in the default Razor layout (most merchants leave it in).
// Corroborating markers:
//   - Footer link: `Powered by <a href="http://www.nopcommerce.com/">nopCommerce</a>`
//   - Plugin asset paths: `SevenSpikes.Nop.Plugins.*` (popular plugin family).
//   - Category-page-only (NOT used here): `<select id="products-orderby">`,
//     `<select id="products-pagesize">` — homepage doesn't have these.
//
// Reference markers verified live (2026-04-26):
// - www.reliablegun.com (audit history #24 — nopCommerce + CF-active). Apex
//   returns 301 → www (canonical-host already handles); www returns full HTML
//   with all 3 definitive markers + SevenSpikes plugin css/js + Nop.customer
//   cookie in set-cookie. Cloudflare fronts the IIS origin.
//
// Note on CF-active sites: if the access-identity stage's static fetch hits a CF challenge body,
// the meta generator and cookie won't be visible. Detection then falls through
// to NULL, and the orchestrator escalates the UA ladder per spec §4.2.
import type { PlatformDetector } from '../platform-detect';

export const nopcommerceDetector: PlatformDetector = {
  id: 'nopcommerce',
  async detect({ html, headers, cookies }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Definitive meta marker — both quote styles, optional self-close.
    if (/<meta\s+name=["']generator["']\s+content=["']nopCommerce["']\s*\/?\s*>/i.test(html)) {
      signals.metaGenerator = 'nopCommerce';
      matched = true;
      confidence = 'high';
    }

    // Definitive cookie marker — `Nop.customer` is the anon customer cookie.
    const setCookieHeader = headers?.['set-cookie'] ?? '';
    if (/\bNop\.customer=/i.test(setCookieHeader) || cookies.some(c => /^Nop\.customer\b/i.test(c))) {
      signals.nopCustomerCookie = true;
      matched = true;
      confidence = 'high';
    }

    // Definitive HTML comment — emitted by the default _Root.cshtml layout.
    if (/<!--\s*Powered by nopCommerce[^-]*-->/i.test(html)) {
      signals.poweredByComment = true;
      matched = true;
      confidence = 'high';
    }

    // Corroborating: footer powered-by link.
    if (/<a[^>]+href=["']https?:\/\/(?:www\.)?nopcommerce\.com\/?["'][^>]*>\s*nopCommerce\s*<\/a>/i.test(html)) {
      signals.poweredByLink = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    // Corroborating: SevenSpikes plugin asset paths (Nop ecosystem-specific).
    if (/SevenSpikes\.Nop\.Plugins\./i.test(html)) {
      signals.sevenSpikesPlugins = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    return { matched, confidence, signals };
  },
};
