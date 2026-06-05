// backend/src/services/__test__/keyword-matcher-out-of-scope-exclusion-2026-06-05.test.ts
//
// searchProductIndex must NEVER return a product whose productType is
// 'out_of_scope', regardless of keyword match. This is the single chokepoint
// shared by the search route, the alert-dispatch worker, and the daily digest,
// so excluding here covers all three (the user's "non-firearm products shall
// not appear in the app" rule).
//
// Mocks prisma (no DB), mirroring the all-sites-fairness test pattern.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

function row(id: string, title: string, productType: string) {
  return {
    id,
    siteId: 'siteA',
    url: `https://siteA.example.com/products/${id}`,
    title,
    price: 50,
    regularPrice: null,
    stockStatus: 'in_stock',
    thumbnail: null,
    category: 'new',
    tags: null,
    productType,
    firstSeenAt: new Date(1000),
    contentChangedAt: new Date(1000),
  };
}

beforeEach(() => {
  findUnique.mockReset();
  monitoredSiteFindMany.mockReset();
  productIndexFindMany.mockReset();
  findUnique.mockResolvedValue(null); // no alias group => raw keyword
});

afterEach(() => vi.restoreAllMocks());

describe('searchProductIndex excludes out_of_scope (2026-06-05)', () => {
  it('site-scoped: drops an out_of_scope row that matches the keyword', async () => {
    // Both rows match "glock"; only the firearm one should survive.
    productIndexFindMany.mockResolvedValue([
      row('a1', 'Glock Logo Hoodie', 'out_of_scope'),
      row('a2', 'Glock 19 Gen5 9mm Pistol', 'firearm'),
    ]);

    const results = await searchProductIndex('glock', ['siteA'], {});
    expect(results.map(r => r.title)).toEqual(['Glock 19 Gen5 9mm Pistol']);
    expect(results.some(r => r.productType === 'out_of_scope')).toBe(false);
  });

  it('all-sites: drops out_of_scope across the per-site merge', async () => {
    monitoredSiteFindMany.mockResolvedValue([{ id: 'siteA' }]);
    productIndexFindMany.mockImplementation(async (args: any) =>
      [
        row('a1', 'Glock Branded T-Shirt', 'out_of_scope'),
        row('a2', 'Glock 17 9mm Pistol', 'firearm'),
      ].slice(0, args.take),
    );

    const results = await searchProductIndex('glock', undefined, {});
    expect(results.map(r => r.title)).toEqual(['Glock 17 9mm Pistol']);
    expect(results.some(r => r.productType === 'out_of_scope')).toBe(false);
  });
});
