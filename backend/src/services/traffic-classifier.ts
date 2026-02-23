/**
 * Dynamic traffic classifier — estimates target site's traffic level
 * from measured signals. Re-evaluated on every crawl (zero extra requests).
 *
 * Traffic classes determine the HARD FLOOR for crawl intervals:
 *   tiny   → 12 hr min (< 100 visitors/day estimate)
 *   small  → 4 hr min  (100-1,000 visitors/day)
 *   medium → 1 hr min  (1,000-10,000 visitors/day)
 *   large  → 30 min min (10,000+ visitors/day)
 */

export type TrafficClass = 'tiny' | 'small' | 'medium' | 'large';

export interface TrafficSignals {
  avgResponseTimeMs: number | null;
  recentErrorRate: number;         // 0.0-1.0 from last 10 crawls
  hasCdn: boolean;                 // CDN headers detected (cf-ray, x-cdn, via: cloudfront)
  hasWaf: boolean;                 // WAF detected (Sucuri, Cloudflare, etc.)
  requiresSucuri: boolean;
  serverType: string | null;       // From Server header
  consecutiveFailures: number;
}

/**
 * Classify a site's traffic level from measured infrastructure signals.
 *
 * Logic:
 * - CDN/WAF presence suggests investment in infrastructure → at least medium
 * - Fast, consistent responses suggest capable hosting → medium or large
 * - Slow responses on shared hosting → small or tiny
 * - Frequent errors/timeouts → treat as tiny (be extra cautious)
 */
export function classifyTraffic(signals: TrafficSignals): TrafficClass {
  const { avgResponseTimeMs, recentErrorRate, hasCdn, hasWaf, serverType, consecutiveFailures } = signals;

  // If site is struggling (high error rate or many failures), treat as tiny
  if (recentErrorRate > 0.3 || consecutiveFailures >= 3) {
    return 'tiny';
  }

  // CDN detected → at least medium, likely large
  if (hasCdn) {
    if (avgResponseTimeMs && avgResponseTimeMs < 500) return 'large';
    return 'medium';
  }

  // WAF (Sucuri, Cloudflare) without full CDN → at least medium
  if (hasWaf) {
    return 'medium';
  }

  // Response time based classification
  if (avgResponseTimeMs) {
    if (avgResponseTimeMs < 300) return 'large';       // Very fast → well-funded
    if (avgResponseTimeMs < 1000) return 'medium';     // Normal → decent hosting
    if (avgResponseTimeMs < 3000) return 'small';      // Slow-ish → shared hosting
    return 'tiny';                                      // Very slow → basic hosting
  }

  // No data yet → default to medium (conservative)
  return 'medium';
}

/**
 * Detect infrastructure signals from HTTP response headers.
 * Called after each fetch — zero extra requests.
 */
export function detectInfraSignals(headers: Record<string, any>): {
  hasCdn: boolean;
  hasWaf: boolean;
  serverType: string | null;
} {
  const headerStr = JSON.stringify(headers).toLowerCase();

  const hasCdn = !!(
    headers['cf-ray'] ||                         // Cloudflare
    headers['x-cdn'] ||                          // Generic CDN header
    headers['x-cache'] ||                        // CloudFront / Fastly
    headers['x-served-by'] ||                    // Fastly
    headers['x-amz-cf-id'] ||                    // CloudFront
    (headers['via'] && /cloudfront|varnish|fastly/i.test(headers['via'])) ||
    (headers['server'] && /cloudflare|akamai/i.test(headers['server']))
  );

  const hasWaf = !!(
    headers['x-sucuri-id'] ||
    headers['x-sucuri-cache'] ||
    headers['cf-ray'] ||                         // Cloudflare acts as WAF too
    headerStr.includes('sucuri') ||
    headerStr.includes('incapsula') ||
    headerStr.includes('imperva')
  );

  const serverType = headers['server'] || null;

  return { hasCdn, hasWaf, serverType };
}

/**
 * Compute recent error rate from the last N crawl events.
 */
export function computeErrorRate(crawlStatuses: string[]): number {
  if (crawlStatuses.length === 0) return 0;
  const failures = crawlStatuses.filter(s => s !== 'success').length;
  return failures / crawlStatuses.length;
}
