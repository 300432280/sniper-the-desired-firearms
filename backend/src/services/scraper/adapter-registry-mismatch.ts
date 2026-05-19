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

const warnedDomains = new Set<string>();

interface SiteInfoLike {
  adapterType: string;
  siteProfile?: { crawlers?: { catalog?: { method?: string } } } | null;
}

export function warnIfAdapterMismatch(domain: string, siteInfo: SiteInfoLike): void {
  const catalogMethod = siteInfo?.siteProfile?.crawlers?.catalog?.method;
  if (typeof catalogMethod !== 'string' || catalogMethod.length === 0) return;
  if (catalogMethod === siteInfo.adapterType) return;
  if (warnedDomains.has(domain)) return;
  warnedDomains.add(domain);
  console.warn(
    `[AdapterRegistry] ${domain}: profile drift — adapterType="${siteInfo.adapterType}" ` +
    `but siteProfile.crawlers.catalog.method="${catalogMethod}". ` +
    `adapterType is the runtime routing key; catalog.method has no consumer.`
  );
}

/** Test-only: reset the per-domain warning memo. */
export function _resetAdapterMismatchWarnings(): void {
  warnedDomains.clear();
}
