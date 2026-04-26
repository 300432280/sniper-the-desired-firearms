// backend/scripts/probe/room3-geography-count/walk-verify.ts
import { fetchUrl } from '../shared/fetch';
import { extractProducts } from '../shared/extract';
import type { AccessIdentityState } from '../shared/types';

export type WalkResult = {
  walkCounts: Array<{ url: string; uniqueProducts: number; pages: number }>;
  uniqueProductUrls: Set<string>;
};

export async function walkAndDedupe(
  state: AccessIdentityState,
  catalogUrls: string[],
): Promise<WalkResult> {
  const ctx = { hasWaf: state.hasWaf, wafType: state.wafType, ua: state.userAgentOverride ?? undefined };
  const seen = new Set<string>();
  const counts: WalkResult['walkCounts'] = [];

  for (const url of catalogUrls) {
    let pages = 0;
    let countForUrl = 0;
    let nextUrl: string | null = url;
    while (nextUrl && pages < 200) {
      try {
        const r = await fetchUrl(nextUrl, { ...ctx, timeoutMs: 15000 });
        if (r.status >= 400) break;
        // Pass platform so extract.ts dispatches to the right adapter
        // (drupal-commerce → GunpostAdapter for classifieds markup).
        const products = extractProducts(r.body, nextUrl, state.platform);
        if (products.length === 0) break;
        let added = 0;
        for (const p of products) {
          if (!seen.has(p.url)) { seen.add(p.url); added++; }
        }
        countForUrl += added;
        pages++;
        // If no new unique products were found, pagination is not advancing
        // (e.g. WooCommerce /page/N/, Celerant /page/N, LightSpeed pageN.html
        // all ignore ?page=N and return page-1 content repeatedly)
        if (added === 0) break;
        // Probe-level pagination: try ?page=N+1 and confirm new products
        const u = new URL(nextUrl);
        const curPage = parseInt(u.searchParams.get('page') ?? '1', 10);
        u.searchParams.set('page', String(curPage + 1));
        nextUrl = u.toString();
      } catch { break; }
    }
    counts.push({ url, uniqueProducts: countForUrl, pages });
  }

  return { walkCounts: counts, uniqueProductUrls: seen };
}
