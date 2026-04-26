// backend/scripts/probe/room2-access-identity/detectors/godaddy-ols.ts
// GoDaddy Online Store (OLS) — SPA storefront on GoDaddy's "Website + Marketing"
// (formerly "GoCentral", "Airo") platform. The product list is hydrated by JS
// against the mysimplestore backend API at `/api/v2/products`. The HOMEPAGE
// alone carries multiple unique markers — we do NOT need to fetch /shop:
//
// Definitive markers (any one → high confidence):
//   1. `<meta name="generator" content="Starfield Technologies; Go Daddy Website Builder ...">`
//      Starfield Technologies is GoDaddy's holding company; this exact generator
//      string is unique to the GoDaddy Website Builder / OLS render.
//   2. `Server: DPS/<version>` response header — GoDaddy's "Digital Publishing
//      Service" edge. No other platform emits a `DPS/...` Server token.
//   3. `Set-Cookie: dps_site_id=...` — DPS site routing cookie, GoDaddy-only.
//   4. `Content-Security-Policy: frame-ancestors ... godaddy.com *.godaddy.com
//      dev-godaddy.com test-godaddy.com` — explicit GoDaddy whitelist for the
//      site editor preview, emitted on every published OLS site.
//
// Corroborating markers:
//   - `wsimg.com` / `img1.wsimg.com` — GoDaddy's "Website Service Image" CDN
//     (referenced from every OLS-hosted asset).
//   - `data-aid="..._RENDERED"` / `data-aid="..._REND"` attributes — GoDaddy's
//     SPA component-id convention (e.g. `CART_ICON_RENDER`, `HEADER_LOGO_IMAGE_RENDERED`).
//   - `data-aid="FOOTER_POWERED_BY_AIRO_RENDERED"` — explicit "powered by Airo"
//     footer slot (Airo is GoDaddy's branding for its AI-assisted builder).
//   - `data-aid="PRODUCT_LIST_RENDERED"` / `data-aid="PRODUCT_SORT_DROPDOWN"` —
//     present only on the SHOP page (NOT the homepage), so they're consumed
//     downstream (Room 4) rather than here.
//
// Reference markers verified live (2026-04-26):
// - liangjian.ca (audit history #16). Homepage (/) returns:
//     Server: DPS/2.0.0+sha-8ba0b43
//     Set-Cookie: dps_site_id=ca-central-1; ...
//     Content-Security-Policy: frame-ancestors 'self' godaddy.com *.godaddy.com ...
//     <meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 8.0.0000"/>
//   plus `wsimg.com` CDN refs and ~30 `data-aid="..._RENDERED"` attributes
//   including FOOTER_POWERED_BY_AIRO_RENDERED. Sort `?sortOption=descend_by_created_at`
//   and the mysimplestore `/api/v2/products` backend are found on /shop and
//   handled by Rooms 3-4 (NOT this detector).
//
// Mistake 19 (playbook): GoDaddy OLS SPA needs production Playwright fallback
// for catalog walk because the product grid is JS-hydrated. That concern is for
// Room 5 / catalog-crawler, NOT for platform identification: the homepage
// markers are static and identify the platform without JS.
import type { PlatformDetector } from '../platform-detect';

export const godaddyOlsDetector: PlatformDetector = {
  id: 'godaddy-ols',
  async detect({ html, headers }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Definitive header: Server: DPS/<version>+sha-<hash>
    const serverHeader = headers?.['server'] ?? '';
    if (/^DPS\//i.test(serverHeader)) {
      signals.serverDps = serverHeader;
      matched = true;
      confidence = 'high';
    }

    // Definitive cookie: dps_site_id=...
    const setCookieHeader = headers?.['set-cookie'] ?? '';
    if (/\bdps_site_id=/i.test(setCookieHeader)) {
      signals.dpsSiteIdCookie = true;
      matched = true;
      confidence = 'high';
    }

    // Definitive CSP listing godaddy.com / dev-godaddy.com / test-godaddy.com.
    const cspHeader = headers?.['content-security-policy'] ?? '';
    if (/\bgodaddy\.com\b/i.test(cspHeader) && /\bframe-ancestors\b/i.test(cspHeader)) {
      signals.cspGoDaddyFrameAncestors = true;
      matched = true;
      confidence = 'high';
    }

    // Definitive meta: Starfield Technologies / Go Daddy Website Builder.
    if (/<meta\s+name=["']generator["']\s+content=["'][^"']*(?:Starfield Technologies|Go\s*Daddy\s+Website\s+Builder)[^"']*["']/i.test(html)) {
      signals.metaGeneratorGoDaddy = true;
      matched = true;
      confidence = 'high';
    }

    // Corroborating: wsimg.com CDN references.
    // NOTE: wsimg.com is GoDaddy-WIDE (parked domains, GoDaddy WordPress, email pages),
    // not OLS-specific. Do NOT set matched=true on this marker alone — only promote
    // confidence when a definitive marker has already fired. Prevents false-positives
    // on non-OLS GoDaddy properties.
    if (/(?:img\d*\.)?wsimg\.com/i.test(html)) {
      signals.wsimgCdn = true;
      if (matched && confidence === 'medium') confidence = 'high';
    }

    // Corroborating: data-aid="..._RENDERED" / "..._REND" attributes.
    if (/\bdata-aid=["'][A-Z0-9_]+(?:_RENDERED|_REND)\b["']/.test(html)) {
      signals.dataAidRenderedAttrs = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    // Corroborating: powered-by-Airo footer slot.
    if (/data-aid=["']FOOTER_POWERED_BY_AIRO_RENDERED["']/i.test(html)) {
      signals.poweredByAiroSlot = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    return { matched, confidence, signals };
  },
};
