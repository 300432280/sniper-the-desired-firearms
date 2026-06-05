// backend/src/services/scraper/__test__/adapter-registry-www-domain.test.ts
//
// Regression test for the www-prefix cache-key mismatch.
//
// Root cause: refreshCache() was keying the siteCache Map by the raw DB
// `site.domain` value.  For the two sites whose DB domain has a leading
// `www.` (`www.gobles.ca`, `www.gagnonsports.com`) the cache key was
// `www.gobles.ca`, but every caller (getAdapterForUrl, _getSiteCacheEntry,
// crawl-scheduler, worker, etc.) normalises the hostname via
// normalizeDomain() before the lookup, producing key `gobles.ca` →
// exact-match miss → falls through to generic default adapter.
//
// Fix: refreshCache() now calls normalizeDomain(site.domain) when building
// the cache key, so build and lookup use the same normalised form.
//
// This test is pure-unit (no DB, no network).  It exercises the
// build/lookup contract directly using normalizeDomain from url.ts and a
// local Map that mirrors the fixed refreshCache() logic.

import { describe, it, expect } from 'vitest';
import { normalizeDomain } from '../utils/url';

// ---------------------------------------------------------------------------
// 1. normalizeDomain strips www. and lowercases
// ---------------------------------------------------------------------------
describe('normalizeDomain (url.ts)', () => {
  it('strips www. prefix', () => {
    expect(normalizeDomain('www.gobles.ca')).toBe('gobles.ca');
    expect(normalizeDomain('www.gagnonsports.com')).toBe('gagnonsports.com');
  });

  it('is a no-op for domains without www.', () => {
    expect(normalizeDomain('gobles.ca')).toBe('gobles.ca');
    expect(normalizeDomain('example.com')).toBe('example.com');
  });

  it('lowercases the result', () => {
    // normalizeDomain does toLowerCase() after stripping www. — the regex is
    // case-sensitive so uppercase WWW. is not stripped, but the output is
    // still lowercased.  Real DB domains are always lowercase, so this edge
    // case is not a practical concern, but the function contracts it.
    expect(normalizeDomain('Example.COM')).toBe('example.com');
    expect(normalizeDomain('www.Example.COM')).toBe('example.com');
  });

  it('does not strip non-www subdomains', () => {
    expect(normalizeDomain('store.prophetriver.com')).toBe('store.prophetriver.com');
    expect(normalizeDomain('cdn.shoplightspeed.com')).toBe('cdn.shoplightspeed.com');
  });
});

// ---------------------------------------------------------------------------
// 2. Build/lookup symmetry — mirrors the refreshCache() → getAdapterForUrl()
//    contract.  The Map is built with normalizeDomain(site.domain) keys (the
//    fix); lookups use normalizeDomain(hostname) (unchanged callers).
//    Tests prove that www-prefixed DB domains are reachable after the fix.
// ---------------------------------------------------------------------------
describe('cache build/lookup symmetry', () => {
  /** Simulate the FIXED refreshCache() Map build */
  function buildCache(dbDomains: string[]): Map<string, string> {
    const cache = new Map<string, string>();
    for (const domain of dbDomains) {
      cache.set(normalizeDomain(domain), 'generic-retail'); // adapterType placeholder
    }
    return cache;
  }

  /** Simulate the lookup in getAdapterForUrl() */
  function lookup(cache: Map<string, string>, rawHostname: string): string | undefined {
    return cache.get(normalizeDomain(rawHostname));
  }

  it('(REGRESSION) www.gobles.ca DB entry is found when looking up gobles.ca', () => {
    const cache = buildCache(['www.gobles.ca']);
    expect(lookup(cache, 'gobles.ca')).toBe('generic-retail');
    expect(lookup(cache, 'www.gobles.ca')).toBe('generic-retail'); // also works via incoming www
  });

  it('(REGRESSION) www.gagnonsports.com DB entry is found when looking up gagnonsports.com', () => {
    const cache = buildCache(['www.gagnonsports.com']);
    expect(lookup(cache, 'gagnonsports.com')).toBe('generic-retail');
    expect(lookup(cache, 'www.gagnonsports.com')).toBe('generic-retail');
  });

  it('non-www DB entries are unaffected (no-op normalisation)', () => {
    const cache = buildCache(['example.com', 'store.prophetriver.com']);
    expect(lookup(cache, 'example.com')).toBe('generic-retail');
    expect(lookup(cache, 'store.prophetriver.com')).toBe('generic-retail');
  });

  it('mixed fleet: www-prefixed and bare domains both resolve correctly', () => {
    // Mirrors the real fleet: 2 www-prefixed, many bare
    const dbDomains = [
      'www.gobles.ca',
      'www.gagnonsports.com',
      'ellwoodepps.com',
      'sail.ca',
      'northprosports.com',
    ];
    const cache = buildCache(dbDomains);

    // www-prefixed DB entries reachable via bare lookup
    expect(lookup(cache, 'gobles.ca')).toBe('generic-retail');
    expect(lookup(cache, 'gagnonsports.com')).toBe('generic-retail');

    // Bare DB entries still work
    expect(lookup(cache, 'ellwoodepps.com')).toBe('generic-retail');
    expect(lookup(cache, 'sail.ca')).toBe('generic-retail');
    expect(lookup(cache, 'northprosports.com')).toBe('generic-retail');

    // No key collisions: all 5 sites normalise to distinct keys
    expect(cache.size).toBe(5);
  });

  it('(OLD CODE contract -- demonstrates why raw key was wrong)', () => {
    // Simulate the BROKEN old refreshCache() which stored the raw domain
    const brokenCache = new Map<string, string>();
    brokenCache.set('www.gobles.ca', 'generic-retail'); // raw key, old code

    // Lookup uses normalizeDomain --> 'gobles.ca' --> miss
    const result = brokenCache.get(normalizeDomain('gobles.ca'));
    expect(result).toBeUndefined(); // this is the bug: returns undefined --> generic adapter
  });

  // ---------------------------------------------------------------------------
  // _getSiteCacheEntry hardening: the function now normalizes its argument
  // before the Map lookup, so it is robust to RAW (un-stripped) callers
  // (worker.ts:532, stale-detector.ts:154) as well as the many callers that
  // already strip www.  This mirrors the hardened function:
  //   siteCache.get(normalizeDomain(domain))
  // ---------------------------------------------------------------------------
  it('(_getSiteCacheEntry hardening) www-keyed entry found when caller passes RAW www.domain', () => {
    // Map built with normalizeDomain keys (fixed refreshCache)
    const cache = buildCache(['www.gobles.ca']);

    // Hardened _getSiteCacheEntry normalizes its arg before lookup
    const getEntry = (domain: string) => cache.get(normalizeDomain(domain));

    // RAW caller (worker.ts:532 / stale-detector.ts:154) passes un-stripped domain
    expect(getEntry('www.gobles.ca')).toBe('generic-retail');
    // Bare caller (the 11+ pre-stripping callers) still hits
    expect(getEntry('gobles.ca')).toBe('generic-retail');
  });
});
