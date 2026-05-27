import { prisma } from '../../lib/prisma';
import type { SiteAdapter } from './types';
import { normalizeDomain } from './utils/url';

import { warnIfAdapterMismatch } from './adapter-registry-mismatch';
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
  siteProfile: any | null; // SiteProfile JSON from DB
}

let siteCache: Map<string, CachedSiteInfo> = new Map();
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function refreshCache(): Promise<void> {
  if (Date.now() < cacheExpiresAt) return;

  try {
    // Include enabled sites AND sites currently in bootstrap phase (isEnabled:false but
    // crawlPhase:'bootstrap'). Without bootstrap sites in the cache, the worker's
    // `_getSiteCacheEntry(domain)` returns undefined during bootstrap, so the crawler
    // falls back to default perPage / paginationPattern instead of the profile values
    // — breaks LightSpeed perPage=100, suffix-replace pagination, etc.
    const sites = await prisma.monitoredSite.findMany({
      where: {
        OR: [
          { isEnabled: true },
          { isEnabled: false, crawlPhase: 'bootstrap' },
        ],
      },
      select: {
        domain: true,
        adapterType: true,
        siteType: true,
        searchUrlPattern: true,
        requiresSucuri: true,
        siteProfile: true,
      },
    });

    const newCache = new Map<string, CachedSiteInfo>();
    for (const site of sites) {
      newCache.set(site.domain, {
        adapterType: site.adapterType,
        siteType: site.siteType,
        searchUrlPattern: site.searchUrlPattern,
        requiresSucuri: site.requiresSucuri,
        siteProfile: site.siteProfile ?? null,
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
  siteProfile: any | null; // SiteProfile JSON — per-site config
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
      siteProfile: null,
    };
  }

  const domain = normalizeDomain(hostname);

  // Exact domain match
  const siteInfo = siteCache.get(domain);
  if (siteInfo) {
    warnIfAdapterMismatch(domain, siteInfo);
    const adapter = adapters[siteInfo.adapterType] || adapters.generic;
    return {
      adapter,
      adapterType: siteInfo.adapterType,
      searchUrlPattern: siteInfo.searchUrlPattern,
      requiresSucuri: siteInfo.requiresSucuri,
      siteProfile: siteInfo.siteProfile,
    };
  }

  // Subdomain match (e.g. "millerandmiller.hibid.com" → check "hibid.com")
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parentDomain = parts.slice(i).join('.');
    const parentInfo = siteCache.get(parentDomain);
    if (parentInfo) {
      warnIfAdapterMismatch(parentDomain, parentInfo);
      const adapter = adapters[parentInfo.adapterType] || adapters.generic;
      return {
        adapter,
        adapterType: parentInfo.adapterType,
        searchUrlPattern: parentInfo.searchUrlPattern,
        requiresSucuri: parentInfo.requiresSucuri,
        siteProfile: parentInfo.siteProfile,
      };
    }
  }

  // Unknown domain → generic
  return {

    adapter: adapters.generic,
    adapterType: 'generic',
    searchUrlPattern: null,
    requiresSucuri: false,
    siteProfile: null,
  };
}

/**
 * Synchronous access to a cached site entry (used by adapters for profile lookup).
 * Returns the CachedSiteInfo or undefined if not found.
 */
export function _getSiteCacheEntry(domain: string): CachedSiteInfo | undefined {
  return siteCache.get(domain);
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
