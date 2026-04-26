// backend/scripts/probe/room2-access-identity/detectors/wix-thunderbolt.ts
// Wix Stores running on Thunderbolt SSR — Wix's modern server-side-rendered
// frontend (replaced the legacy "Bolt" / Santa client-rendered stack). Most
// Wix Stores sites in 2024+ are on Thunderbolt; the SSR HTML carries enough
// markers that no JS execution is needed for platform identification.
//
// Definitive markers (any one → high confidence):
//   1. `Server: Pepyaka` response header — Wix's edge load balancer. Unique to
//      Wix; never seen on any other platform.
//   2. `x-wix-request-id: <id>` response header — Wix-internal request tracing.
//   3. `<meta name="generator" content="Wix.com Website Builder"/>` — Wix emits
//      this on every published site (sometimes "Wix Studio" for Studio sites,
//      but the prefix `Wix.com` / `Wix.` is consistent).
//   4. `wixBiSession` JS global — Wix's BI (business intelligence) session
//      bootstrap, present in Thunderbolt's inline `<script>` envelope.
//   5. `viewerModel.requestUrl` / `wix-viewer-model` / `wix-warmup-data` script
//      blocks — Thunderbolt's hydration payload, always present in SSR HTML.
//
// Corroborating markers:
//   - `static.parastorage.com`, `static.wixstatic.com`, `siteassets.parastorage.com`
//     — Wix's CDN domains (parastorage = "Parallel Storage"), present in
//     `<link rel="preconnect">` and asset URLs.
//   - `thunderbolt` substring in JS asset paths and inline bootstrap.
//
// Reference markers verified live (2026-04-26):
// - www.surplusherbys.com (audit history #29 — FIRST WIX STORES SITE IN FLEET).
//   Headers:
//     server: Pepyaka
//     x-wix-request-id: 1777167002.8234184932072311005
//     link: <https://static.parastorage.com/>; rel=preconnect; ...,<https://static.wixstatic.com/>; ...
//   Body (~600KB SSR HTML):
//     <meta name="generator" content="Wix.com Website Builder"/>
//     wixBiSession / WixBiSession variants in inline script
//     thunderbolt / Thunderbolt references
//     wix-viewer-model, wix-warmup-data script ids
//     parastorage.com / wixstatic.com asset URLs
//
// Mistake 27 (playbook): Wix sub-cat pagination leak — pagination on a Wix
// Stores category page can leak across into other categories if not pinned
// per category. That concern is for Room 4 / catalog walk, NOT for platform
// identification.
import type { PlatformDetector } from '../platform-detect';

export const wixThunderboltDetector: PlatformDetector = {
  id: 'wix-thunderbolt',
  async detect({ html, headers }) {
    const signals: Record<string, unknown> = {};
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let matched = false;

    // Definitive header: Server: Pepyaka (Wix's edge — never seen on anything else).
    const serverHeader = headers?.['server'] ?? '';
    if (/\bPepyaka\b/i.test(serverHeader)) {
      signals.serverPepyaka = serverHeader;
      matched = true;
      confidence = 'high';
    }

    // Definitive header: x-wix-request-id.
    if (headers?.['x-wix-request-id']) {
      signals.xWixRequestId = true;
      matched = true;
      confidence = 'high';
    }

    // Definitive meta: Wix.com Website Builder (covers "Wix.com Website Builder"
    // and "Wix Studio" variants — the `Wix` token is the discriminator).
    if (/<meta\s+name=["']generator["']\s+content=["']Wix(?:\.com|\s+Studio)[^"']*["']/i.test(html)) {
      signals.metaGeneratorWix = true;
      matched = true;
      confidence = 'high';
    }

    // Definitive: wixBiSession inline JS global.
    if (/\bwixBiSession\b/i.test(html)) {
      signals.wixBiSession = true;
      matched = true;
      confidence = 'high';
    }

    // Definitive: Thunderbolt SSR hydration script ids.
    if (/\bwix-(?:viewer-model|warmup-data)\b/i.test(html)) {
      signals.thunderboltHydrationScripts = true;
      matched = true;
      confidence = 'high';
    }

    // Corroborating: Wix CDN domains (parastorage, wixstatic).
    if (/\b(?:static\.)?(?:parastorage|wixstatic)\.com\b/i.test(html)) {
      signals.wixCdn = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    // Corroborating: thunderbolt substring (asset paths or inline bootstrap).
    if (/\bthunderbolt\b/i.test(html)) {
      signals.thunderboltRef = true;
      matched = true;
      if (confidence === 'low') confidence = 'medium';
    }

    return { matched, confidence, signals };
  },
};
