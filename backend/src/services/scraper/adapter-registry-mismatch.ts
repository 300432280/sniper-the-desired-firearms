// backend/src/services/scraper/adapter-registry-mismatch.ts
//
// Calibration helper: detects when a site's `siteProfile.crawlers.catalog.method`
// has drifted away from its `adapterType`. The routing key for adapter
// selection is `adapterType` (adapter-registry.ts:116); `crawlers.catalog.method`
// has zero runtime consumers. When they disagree, an operator probably edited
// one without updating the other — warn once so it gets noticed.
//
// Behavior-neutral: no adapter selection change, no exception, just a single
// warn line per domain per process lifetime.

// Batch-5 R4 C5 (2026-05-22): split per-branch memos so a domain with BOTH
// drifts (platform != adapterType AND catalog.method != adapterType) surfaces
// BOTH warnings. Previously a single shared `warnedDomains` set caused the
// catalog.method branch to consume the domain on first call, after which the
// platform branch's `if (warnedDomains.has(domain)) return` short-circuited
// without warning. Operators silently missed half the drift.
const warnedCatalogMethodDomains = new Set<string>();
const warnedPlatformDomains = new Set<string>();

interface SiteInfoLike {
  adapterType: string;
  siteProfile?: {
    platform?: string;
    crawlers?: { catalog?: { method?: string } };
  } | null;
}

export function warnIfAdapterMismatch(domain: string, siteInfo: SiteInfoLike): void {
  // ── Existing branch: catalog.method drift ────────────────────────────────
  const catalogMethod = siteInfo?.siteProfile?.crawlers?.catalog?.method;
  if (typeof catalogMethod === 'string' && catalogMethod.length > 0 &&
      catalogMethod !== siteInfo.adapterType) {
    if (!warnedCatalogMethodDomains.has(domain)) {
      warnedCatalogMethodDomains.add(domain);
      console.warn(
        `[AdapterRegistry] ${domain}: profile drift — adapterType="${siteInfo.adapterType}" ` +
        `but siteProfile.crawlers.catalog.method="${catalogMethod}". ` +
        `adapterType is the runtime routing key; catalog.method has no consumer.`
      );
    }
    // Fall through — the platform branch has its own memo and may also fire.
  }

  // ── C2 branch: platform != adapterType ──────────────────────────────────
  // siteProfile.platform records WHAT the site IS; adapterType records WHICH
  // adapter the runtime routes to. Usually they agree (WC site → woocommerce
  // adapter). A divergence is sometimes an intentional operator override
  // (g4cgunstore: WC platform routed to generic-retail for extraction reasons)
  // and sometimes a profile drift. Warn once-per-domain so an operator sees
  // it; the WARN itself doesn't change routing.
  const platform = siteInfo?.siteProfile?.platform;
  if (typeof platform === 'string' && platform.length > 0 &&
      platform !== siteInfo.adapterType) {
    if (!warnedPlatformDomains.has(domain)) {
      warnedPlatformDomains.add(domain);
      console.warn(
        `[AdapterRegistry] ${domain}: profile drift — adapterType="${siteInfo.adapterType}" ` +
        `but siteProfile.platform="${platform}". ` +
        `Usually these agree; mark as adapterTypeOverride in auditNotes if intentional.`
      );
    }
  }
}

/** Test-only: reset BOTH per-branch warning memos. */
export function _resetAdapterMismatchWarnings(): void {
  warnedCatalogMethodDomains.clear();
  warnedPlatformDomains.clear();
}
