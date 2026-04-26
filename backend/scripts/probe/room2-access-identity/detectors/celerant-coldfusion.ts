// backend/scripts/probe/room2-access-identity/detectors/celerant-coldfusion.ts
// Celerant Stratus Retail platform on a ColdFusion runtime (composite). Celerant
// is a US firearms-retail SaaS whose webfront is built in CFML; the typical
// deployment surfaces TWO independent fingerprints: Celerant-branded asset URLs
// and ColdFusion-runtime cookies. Either alone is insufficient — a non-Celerant
// CFML site exists, and the Celerant CDN can theoretically be referenced from a
// non-CF page. Requiring BOTH sides eliminates both false-positive paths.
//
// Composite rule:
//   high   — Celerant CDN reference (`celerantwebservices.com/...` OR `celerant.com/wc/`)
//            AND ColdFusion runtime evidence (CFID OR CFTOKEN cookie OR `.cfm` URL)
//   medium — only corroborating Celerant signals (`server: Null` alone) AND CF evidence
//   low/no — only one side present → matched:false
//
// Reference markers verified live (2026-04-26):
// - www.bullseyenorth.com (audit history #2). Apex 301-redirects to www; HPE
//   trailing-space header issue handled by shared/fetch.ts native-fetch fallback.
//   Headers:
//   - `set-cookie: CFID=95824555; ...` (ColdFusion session — definitive CF runtime)
//   - `set-cookie: CFTOKEN=85c23a7dd825fb33-...` (ColdFusion session token)
//   - `server: Null` (Celerant emits literal "Null" — corroborating, not definitive)
//   - `access-control-allow-origin: *`, `x-frame-options: SAMEORIGIN`
//   Body:
//   - `https://celerantwebservices.com/jquery/3.7.1/jquery-3.7.1.min.js`
//   - `https://celerantwebservices.com/jquery/3.4.0/jquery-ui.min.js` (and CSS)
//   - `https://celerant.com/wc/wc.cfm`, `celerant.com/wc/error.cfm`,
//     `celerant.com/wc/thankyou.cfm` (Celerant Web Cart .cfm endpoints)
//   - `href="https://www.bullseyenorth.com/login.cfm"` (CFML page)
//
// Mistake 36 (playbook): the `server: Null` literal and `Powered by` blurbs can
// be spoofed by WAFs in body inspection — anchor on the CDN host (which a WAF
// won't fabricate) and the CFID/CFTOKEN cookies (which only a real ColdFusion
// app server emits). Don't rely on `server: Null` alone.
import type { PlatformDetector } from '../platform-detect';

export const celerantColdfusionDetector: PlatformDetector = {
  id: 'celerant-coldfusion',
  async detect({ html, headers }) {
    const signals: Record<string, unknown> = {};

    // ── Celerant side (definitive vs corroborating) ─────────────────────────
    // Definitive: Celerant's own CDN/host references in the body.
    const hasCelerantCdn = /\bcelerantwebservices\.com\b/i.test(html);
    const hasCelerantWcEndpoint = /\bcelerant\.com\/wc\//i.test(html);
    if (hasCelerantCdn) signals.celerantCdn = true;
    if (hasCelerantWcEndpoint) signals.celerantWcEndpoint = true;
    // Corroborating: literal `server: Null` header is a Celerant tell-tale, but
    // mistake-36 warns it can be spoofed/observed elsewhere. Treat as a weak
    // signal that only counts when the definitive CDN isn't present.
    const serverHeader = (headers?.['server'] ?? '').trim();
    const hasCelerantServerNull = /^Null$/i.test(serverHeader);
    if (hasCelerantServerNull) signals.celerantServerNull = true;

    // ── ColdFusion side (definitive vs corroborating) ───────────────────────
    // Definitive: CFID/CFTOKEN session cookies — only an actual CFML app server
    // sets these. They appear as `set-cookie` header(s); Node lower-cases keys
    // and may collapse multi-set-cookie into a single comma-joined string in
    // the headers map (axios behavior).
    const setCookieHeader = headers?.['set-cookie'] ?? '';
    const hasCfId = /\bCFID\s*=/i.test(setCookieHeader);
    const hasCfToken = /\bCFTOKEN\s*=/i.test(setCookieHeader);
    if (hasCfId) signals.cfIdCookie = true;
    if (hasCfToken) signals.cfTokenCookie = true;
    // Corroborating: `.cfm` (or `.cfc`) URLs in the body — these are CFML page
    // extensions only ColdFusion (or Lucee) serves directly.
    const hasCfmUrl = /href=["'][^"']+\.cfm(?:\?[^"']*)?["']|src=["'][^"']+\.cfm(?:\?[^"']*)?["']/i.test(html);
    if (hasCfmUrl) signals.cfmUrl = true;

    const celerantSidePresent = hasCelerantCdn || hasCelerantWcEndpoint || hasCelerantServerNull;
    const coldfusionSidePresent = hasCfId || hasCfToken || hasCfmUrl;

    // Composite rule: BOTH sides required. One side alone → matched:false.
    if (!(celerantSidePresent && coldfusionSidePresent)) {
      return { matched: false, confidence: 'low', signals };
    }

    // High confidence: definitive Celerant CDN/endpoint AND a CF cookie (the
    // strongest pairing — CDN can't be spoofed, cookies can't be faked).
    // Medium otherwise (e.g., only `server: Null` + `.cfm` URL).
    const definitiveCelerant = hasCelerantCdn || hasCelerantWcEndpoint;
    const definitiveColdfusion = hasCfId || hasCfToken;
    const confidence: 'high' | 'medium' | 'low' =
      definitiveCelerant && definitiveColdfusion ? 'high' : 'medium';
    return { matched: true, confidence, signals };
  },
};
