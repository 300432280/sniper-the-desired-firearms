/**
 * Site Profile — per-site configuration that replaces hardcoded domain checks.
 *
 * Each site has a SiteProfile JSON stored in MonitoredSite.siteProfile.
 * Generic adapters read from the profile instead of `origin.includes('sitename')`.
 * Profiles are independently maintained per site — change one without affecting others.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export interface SiteProfile {
  domain: string;
  name: string;
  platform: string; // shopify, woocommerce, bigcommerce, magento, lightspeed, coldfusion, drupal, xenforo, custom

  // Site-specific URLs
  searchUrl?: string;          // e.g. "/search.php?search_query={keyword}"
  catalogUrls?: string[];      // e.g. ["/firearms/", "/ammunition/"]
  newArrivalsUrl?: string;     // T1 sort-by-newest URL
  sortParam?: string;          // e.g. "?sort=newest"

  // WAF / Access
  wafType?: string | null;     // sucuri, cloudflare, incapsula
  timeout?: number;            // API timeout override (default 15s, WAF 30s)
  needsPlaywright?: boolean;

  // Data flow: how this site provides data
  dataFlow?: {
    steps: { api: string; provides: string[]; notes?: string }[];
  };

  // Crawler config
  crawlers?: {
    bootstrap?: {
      method?: string;
      apiEndpoints?: { productDiscovery?: string; priceEnrichment?: string };
      htmlFallback?: boolean;
    };
    maintain?: {
      method?: string;
      cooldowns?: { t2: number; t3: number; t4: number };
      tierShares?: { t2: number; t3: number; t4: number };
      verifyMethod?: string;
    };
  };

  // Product classification
  classifiedRules?: {
    wantedDetection?: string[];
    soldDetection?: string[];
  };

  // Platform-specific
  apiConfig?: {
    klevuApiKey?: string;
    klevuEndpoint?: string;
    klevuCategoryPaths?: { slug: string; path: string }[];
    forumSections?: string[];
    customSelectors?: Record<string, string>;
  };

  // Notes
  notes?: string;
  lastVerified?: string;
}

// In-memory cache (refreshed with adapter registry)
let profileCache: Map<string, SiteProfile> | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get a site's profile by domain or origin URL.
 * Returns null if no profile exists (site uses default adapter behavior).
 */
export async function getSiteProfile(originOrDomain: string): Promise<SiteProfile | null> {
  let domain: string;
  try {
    domain = new URL(originOrDomain).hostname.replace(/^www\./, '');
  } catch {
    domain = originOrDomain.replace(/^www\./, '');
  }

  // Check cache
  if (profileCache && Date.now() - cacheTime < CACHE_TTL) {
    return profileCache.get(domain) ?? null;
  }

  // Refresh cache
  try {
    const sites = await prisma.monitoredSite.findMany({
      where: { NOT: { siteProfile: { equals: Prisma.DbNull } } },
      select: { domain: true, siteProfile: true },
    });

    profileCache = new Map();
    for (const site of sites) {
      if (site.siteProfile && typeof site.siteProfile === 'object') {
        profileCache.set(site.domain.replace(/^www\./, ''), site.siteProfile as unknown as SiteProfile);
      }
    }
    cacheTime = Date.now();
  } catch {
    // DB error — return null, don't crash
    return null;
  }

  return profileCache.get(domain) ?? null;
}

/**
 * Get catalog URLs from profile, or empty array if no profile.
 */
export async function getProfileCatalogUrls(origin: string): Promise<string[]> {
  const profile = await getSiteProfile(origin);
  if (!profile?.catalogUrls?.length) return [];
  return profile.catalogUrls.map(u => u.startsWith('http') ? u : `${origin}${u}`);
}

/**
 * Get search URL from profile, or null if no profile.
 */
export async function getProfileSearchUrl(origin: string, keyword: string): Promise<string | null> {
  const profile = await getSiteProfile(origin);
  if (!profile?.searchUrl) return null;
  return `${origin}${profile.searchUrl.replace('{keyword}', encodeURIComponent(keyword))}`;
}

/**
 * Get sort parameter from profile for T1 new arrivals.
 */
export async function getProfileSortParam(origin: string): Promise<string | null> {
  const profile = await getSiteProfile(origin);
  return profile?.sortParam ?? null;
}

/** Clear the profile cache (call after DB updates) */
export function clearProfileCache(): void {
  profileCache = null;
  cacheTime = 0;
}
