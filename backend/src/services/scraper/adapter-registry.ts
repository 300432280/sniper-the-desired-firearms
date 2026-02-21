import { prisma } from '../../lib/prisma';
import type { SiteAdapter } from './types';
import { normalizeDomain } from './utils/url';

import { ShopifyAdapter } from './adapters/shopify';
import { WooCommerceAdapter } from './adapters/woocommerce';
import { GenericRetailAdapter } from './adapters/generic-retail';
import { GenericAdapter } from './adapters/generic';
import { XenForoAdapter } from './adapters/forum-xenforo';
import { VBulletinAdapter } from './adapters/forum-vbulletin';
import { GunpostAdapter } from './adapters/classifieds-gunpost';
import { ICollectorAdapter } from './adapters/auction-icollector';
import { HiBidAdapter } from './adapters/auction-hibid';
import { GenericAuctionAdapter } from './adapters/auction-generic';

// ── Singleton adapter instances ──────────────────────────────────────────────

const adapters: Record<string, SiteAdapter> = {
  shopify: new ShopifyAdapter(),
  woocommerce: new WooCommerceAdapter(),
  'generic-retail': new GenericRetailAdapter(),
  generic: new GenericAdapter(),
  'forum-xenforo': new XenForoAdapter(),
  'forum-vbulletin': new VBulletinAdapter(),
  'classifieds-gunpost': new GunpostAdapter(),
  'auction-icollector': new ICollectorAdapter(),
  'auction-hibid': new HiBidAdapter(),
  'auction-generic': new GenericAuctionAdapter(),
};

// ── DB-driven site lookup cache ──────────────────────────────────────────────

interface CachedSiteInfo {
  adapterType: string;
  siteType: string;
  searchUrlPattern: string | null;
  requiresSucuri: boolean;
}

let siteCache: Map<string, CachedSiteInfo> = new Map();
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function refreshCache(): Promise<void> {
  if (Date.now() < cacheExpiresAt) return;

  try {
    const sites = await prisma.monitoredSite.findMany({
      where: { isEnabled: true },
      select: {
        domain: true,
        adapterType: true,
        siteType: true,
        searchUrlPattern: true,
        requiresSucuri: true,
      },
    });

    const newCache = new Map<string, CachedSiteInfo>();
    for (const site of sites) {
      newCache.set(site.domain, {
        adapterType: site.adapterType,
        siteType: site.siteType,
        searchUrlPattern: site.searchUrlPattern,
        requiresSucuri: site.requiresSucuri,
      });
    }

    siteCache = newCache;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    console.log(`[AdapterRegistry] Refreshed cache: ${siteCache.size} sites`);
  } catch (err) {
    console.error(`[AdapterRegistry] Cache refresh failed: ${err instanceof Error ? err.message : 'unknown'}`);
    // Keep stale cache rather than failing
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface AdapterLookupResult {
  adapter: SiteAdapter;
  adapterType: string;
  searchUrlPattern: string | null;
  requiresSucuri: boolean;
}

/**
 * Look up the best adapter for a given URL.
 * Checks the MonitoredSite DB (cached 5 min), falls back to 'generic'.
 */
export async function getAdapterForUrl(url: string): Promise<AdapterLookupResult> {
  await refreshCache();

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return {
      adapter: adapters.generic,
      adapterType: 'generic',
      searchUrlPattern: null,
      requiresSucuri: false,
    };
  }

  const domain = normalizeDomain(hostname);

  // Exact domain match
  const siteInfo = siteCache.get(domain);
  if (siteInfo) {
    const adapter = adapters[siteInfo.adapterType] || adapters.generic;
    return {
      adapter,
      adapterType: siteInfo.adapterType,
      searchUrlPattern: siteInfo.searchUrlPattern,
      requiresSucuri: siteInfo.requiresSucuri,
    };
  }

  // Subdomain match (e.g. "millerandmiller.hibid.com" → check "hibid.com")
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parentDomain = parts.slice(i).join('.');
    const parentInfo = siteCache.get(parentDomain);
    if (parentInfo) {
      const adapter = adapters[parentInfo.adapterType] || adapters.generic;
      return {
        adapter,
        adapterType: parentInfo.adapterType,
        searchUrlPattern: parentInfo.searchUrlPattern,
        requiresSucuri: parentInfo.requiresSucuri,
      };
    }
  }

  // Unknown domain → generic
  return {
    adapter: adapters.generic,
    adapterType: 'generic',
    searchUrlPattern: null,
    requiresSucuri: false,
  };
}

/**
 * Get an adapter instance by type name.
 */
export function getAdapterByType(adapterType: string): SiteAdapter {
  return adapters[adapterType] || adapters.generic;
}

/**
 * Register a new adapter type at runtime.
 */
export function registerAdapter(type: string, adapter: SiteAdapter): void {
  adapters[type] = adapter;
}

/**
 * Force-refresh the site cache (e.g. after adding new sites via admin).
 */
export function invalidateAdapterCache(): void {
  cacheExpiresAt = 0;
}
