// backend/src/services/__test__/worker-store-api.test.ts
//
// Fix 3 (silent loss-of-signal under store-api):
//   In tryStoreApiVerify(), when the Store API response did NOT include a
//   product the caller asked about, the product was previously pushed to
//   `handledProductIds` UNCONDITIONALLY (worker.ts:549). The outer caller
//   (worker.ts:711) then short-circuits via `handled === products.length`
//   and never reaches the Playwright fallback, so OOS-transition products
//   are never updated. Restock/OOS detection silently dies.
//
// Option A: only push to handledProductIds when an apiProduct was matched.
// Tested via the extracted pure helper `splitChunkByApiMatch`.
import { describe, it, expect } from 'vitest';
import { splitChunkByApiMatch } from '../worker-store-api-helpers';

interface FakeProduct { id: string; sourceId: string | null; }

describe('splitChunkByApiMatch (Fix 3)', () => {
  it('returns all products as matched when API returned them all', () => {
    const chunk: FakeProduct[] = [
      { id: 'pi-1', sourceId: '101' },
      { id: 'pi-2', sourceId: '102' },
    ];
    const apiMap = new Map<string, any>([
      ['101', { id: 101 }],
      ['102', { id: 102 }],
    ]);
    const { matched, unmatched } = splitChunkByApiMatch(chunk, apiMap);
    expect(matched.map(p => p.id)).toEqual(['pi-1', 'pi-2']);
    expect(unmatched).toEqual([]);
  });

  it('returns the missing product as UNMATCHED when API omits it (the OOS-transition bug)', () => {
    // Store API has dropped product 102 (could be OOS, visibility filter,
    // pagination edge case, etc.). The product is NOT handled — caller
    // MUST fall through to Playwright to verify.
    const chunk: FakeProduct[] = [
      { id: 'pi-1', sourceId: '101' },
      { id: 'pi-2', sourceId: '102' },
    ];
    const apiMap = new Map<string, any>([['101', { id: 101 }]]);
    const { matched, unmatched } = splitChunkByApiMatch(chunk, apiMap);
    expect(matched.map(p => p.id)).toEqual(['pi-1']);
    expect(unmatched.map(p => p.id)).toEqual(['pi-2']);
  });

  it('treats a null sourceId as unmatched (cannot query Store API by null)', () => {
    const chunk: FakeProduct[] = [
      { id: 'pi-1', sourceId: null },
      { id: 'pi-2', sourceId: '102' },
    ];
    const apiMap = new Map<string, any>([['102', { id: 102 }]]);
    const { matched, unmatched } = splitChunkByApiMatch(chunk, apiMap);
    expect(matched.map(p => p.id)).toEqual(['pi-2']);
    expect(unmatched.map(p => p.id)).toEqual(['pi-1']);
  });

  it('returns the whole chunk as unmatched when API returned nothing (caller MUST hit Playwright)', () => {
    const chunk: FakeProduct[] = [
      { id: 'pi-1', sourceId: '101' },
      { id: 'pi-2', sourceId: '102' },
    ];
    const apiMap = new Map<string, any>();
    const { matched, unmatched } = splitChunkByApiMatch(chunk, apiMap);
    expect(matched).toEqual([]);
    expect(unmatched.map(p => p.id)).toEqual(['pi-1', 'pi-2']);
  });
});
