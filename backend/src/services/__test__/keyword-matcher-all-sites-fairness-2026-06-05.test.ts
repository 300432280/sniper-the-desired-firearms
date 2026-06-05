// backend/src/services/__test__/keyword-matcher-all-sites-fairness-2026-06-05.test.ts
//
// All-sites path fairness (2026-06-05). searchProductIndex(keyword, undefined)
// used to fetch ONE global `take: 1000` ordered by firstSeenAt, then refine.
// Because the newest 1000 matches cluster on a few high-volume sites, other
// maintain-sites were starved to ~0 (live: "glock" surfaced 26/47 sites).
//
// Fix: fetch the newest PER_SITE_CAP BROAD matches PER maintain-site, then merge
// + refine. This test mocks prisma (no DB) and proves:
//   (a) every maintain-site with a refined match is represented in the output;
//   (b) a site whose BROAD match pool exceeds PER_SITE_CAP is bounded to the cap
//       AND the cap-hit observability (console.warn) fires;
//   (c) one site's query rejection drops only that site (allSettled) instead of
//       failing the whole search, and is reported via the same warning.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── prisma mock ──────────────────────────────────────────────────────────────
// expandKeyword() calls keywordAlias.findUnique; returning null makes
// expandKeyword("glock") => ["glock"] (raw keyword, no alias group).
const findUnique = vi.fn();
const monitoredSiteFindMany = vi.fn();
const productIndexFindMany = vi.fn();

vi.mock('../../lib/prisma', () => ({
  prisma: {
    keywordAlias: { findUnique: (...a: any[]) => findUnique(...a) },
    monitoredSite: { findMany: (...a: any[]) => monitoredSiteFindMany(...a) },
    productIndex: { findMany: (...a: any[]) => productIndexFindMany(...a) },
  },
}));

import { searchProductIndex } from '../keyword-matcher';

// PER_SITE_CAP is module-private; mirror its value here. If the source constant
// changes, this must change too (kept deliberately explicit so the test states
// the contract it verifies).
const PER_SITE_CAP = 3000;

function row(siteId: string, n: number, firstSeenMs: number) {
  return {
    id: `${siteId}-${n}`,
    siteId,
    url: `https://${siteId}.example.com/products/glock-${n}`,
    title: `Glock ${n} 9mm Pistol`, // word-boundary matches "glock"
    price: 999,
    regularPrice: null,
    stockStatus: 'in_stock',
    thumbnail: null,
    category: 'new',
    tags: 'firearms',
    productType: 'firearm',
    firstSeenAt: new Date(firstSeenMs),
    contentChangedAt: new Date(firstSeenMs),
  };
}

beforeEach(() => {
  findUnique.mockReset();
  monitoredSiteFindMany.mockReset();
  productIndexFindMany.mockReset();
  findUnique.mockResolvedValue(null); // no alias group => raw keyword
});

afterEach(() => vi.restoreAllMocks());

describe('searchProductIndex all-sites fairness (2026-06-05)', () => {
  it('(a) represents EVERY maintain-site with a refined match', async () => {
    monitoredSiteFindMany.mockResolvedValue([{ id: 'siteA' }, { id: 'siteB' }, { id: 'siteC' }]);
    // Per-site queries are filtered by siteId; honor that in the mock.
    productIndexFindMany.mockImplementation(async (args: any) => {
      const siteId = args.where.siteId;
      const pools: Record<string, any[]> = {
        siteA: [row('siteA', 1, 300), row('siteA', 2, 290)],
        siteB: [row('siteB', 1, 250)],
        siteC: [row('siteC', 1, 200), row('siteC', 2, 100)],
      };
      return (pools[siteId] ?? []).slice(0, args.take);
    });

    const results = await searchProductIndex('glock', undefined, {});
    const sites = new Set(results.map(r => r.siteId));
    expect(sites).toEqual(new Set(['siteA', 'siteB', 'siteC']));
    expect(results.length).toBe(5);
    // Global re-sort by firstSeenAt desc preserved.
    const ms = results.map(r => r.firstSeenAt.getTime());
    expect(ms).toEqual([...ms].sort((a, b) => b - a));
  });

  it('(b) bounds a site whose BROAD pool exceeds PER_SITE_CAP and fires cap observability', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    monitoredSiteFindMany.mockResolvedValue([{ id: 'siteA' }, { id: 'big' }]);
    // 'big' has more broad matches than the cap; the mock honors `take`, so it
    // returns exactly PER_SITE_CAP rows — the source's cap-hit detection.
    const bigPool = Array.from({ length: PER_SITE_CAP + 500 }, (_, i) => row('big', i, 1_000_000 - i));
    productIndexFindMany.mockImplementation(async (args: any) => {
      if (args.where.siteId === 'big') return bigPool.slice(0, args.take);
      return [row('siteA', 1, 5)].slice(0, args.take);
    });

    const results = await searchProductIndex('glock', undefined, {});
    const bigCount = results.filter(r => r.siteId === 'big').length;
    expect(bigCount).toBe(PER_SITE_CAP); // bounded, not 3500
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`hit PER_SITE_CAP=${PER_SITE_CAP}`);
    expect(warn.mock.calls[0][0]).toContain('1 site(s)');
  });

  it('(c) a single site query failure is dropped, not propagated, and is reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    monitoredSiteFindMany.mockResolvedValue([{ id: 'ok' }, { id: 'broken' }]);
    productIndexFindMany.mockImplementation(async (args: any) => {
      if (args.where.siteId === 'broken') throw new Error('Neon connection reset');
      return [row('ok', 1, 10), row('ok', 2, 9)].slice(0, args.take);
    });

    const results = await searchProductIndex('glock', undefined, {});
    // Search did NOT throw; the healthy site's results survive.
    expect(new Set(results.map(r => r.siteId))).toEqual(new Set(['ok']));
    expect(results.length).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('query FAILED and were dropped (broken)');
  });
});
