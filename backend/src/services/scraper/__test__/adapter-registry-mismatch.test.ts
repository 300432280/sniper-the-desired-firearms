// backend/src/services/scraper/__test__/adapter-registry-mismatch.test.ts
//
// Fix 5: calibration warning when siteProfile.crawlers.catalog.method differs
//        from siteInfo.adapterType. The routing key is `adapterType` (line 116
//        in adapter-registry.ts); `crawlers.catalog.method` has zero runtime
//        consumers. A divergence between the two means a profile drift —
//        warn once per domain so operators notice.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { warnIfAdapterMismatch, _resetAdapterMismatchWarnings } from '../adapter-registry-mismatch';

beforeEach(() => {
  _resetAdapterMismatchWarnings();
});

describe('warnIfAdapterMismatch (Fix 5)', () => {
  it('warns when adapterType differs from siteProfile.crawlers.catalog.method', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const siteInfo = {
      adapterType: 'generic-retail',
      siteProfile: { crawlers: { catalog: { method: 'woocommerce' } } },
    };
    warnIfAdapterMismatch('example.com', siteInfo as any);
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toMatch(/example\.com/);
    expect(msg).toMatch(/generic-retail/);
    expect(msg).toMatch(/woocommerce/);
    spy.mockRestore();
  });

  it('does NOT warn when adapterType matches catalog.method', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const siteInfo = {
      adapterType: 'woocommerce',
      siteProfile: { crawlers: { catalog: { method: 'woocommerce' } } },
    };
    warnIfAdapterMismatch('example.com', siteInfo as any);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does NOT warn when catalog.method is unset', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const siteInfo = {
      adapterType: 'generic-retail',
      siteProfile: { crawlers: { catalog: {} } },
    };
    warnIfAdapterMismatch('example.com', siteInfo as any);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('warns ONCE per domain even if called repeatedly', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const siteInfo = {
      adapterType: 'generic-retail',
      siteProfile: { crawlers: { catalog: { method: 'woocommerce' } } },
    };
    warnIfAdapterMismatch('example.com', siteInfo as any);
    warnIfAdapterMismatch('example.com', siteInfo as any);
    warnIfAdapterMismatch('example.com', siteInfo as any);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
