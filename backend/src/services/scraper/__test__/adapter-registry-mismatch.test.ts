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

  // ── C2: also warn on platform != adapterType drift ────────────────────────
  // siteProfile.platform records WHAT the site IS (woocommerce, shopify, ...).
  // adapterType records WHICH adapter the runtime routes to. They usually agree
  // (WC site → woocommerce adapter). When they don't (g4cgunstore: platform=woocommerce
  // but adapterType=generic-retail), it is sometimes an intentional operator override
  // and sometimes a profile drift. Warn once-per-domain so an operator sees it,
  // identical pattern to the existing catalog.method drift warning.
  it('warns when platform differs from adapterType', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const siteInfo = {
      adapterType: 'generic-retail',
      siteProfile: { platform: 'woocommerce' },
    };
    warnIfAdapterMismatch('g4cgunstore.com', siteInfo as any);
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toMatch(/g4cgunstore\.com/);
    expect(msg).toMatch(/woocommerce/);
    expect(msg).toMatch(/generic-retail/);
    spy.mockRestore();
  });

  it('does NOT warn when platform matches adapterType', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const siteInfo = {
      adapterType: 'woocommerce',
      siteProfile: { platform: 'woocommerce' },
    };
    warnIfAdapterMismatch('match.example.com', siteInfo as any);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does NOT warn when platform is unset', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const siteInfo = {
      adapterType: 'generic-retail',
      siteProfile: {},
    };
    warnIfAdapterMismatch('noplatform.example.com', siteInfo as any);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does NOT warn on repeated calls when only ONE branch drifts (catalog.method)', () => {
    // Construct so ONLY catalog.method drifts; platform agrees with adapterType.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const siteInfo = {
      adapterType: 'generic-retail',
      siteProfile: {
        platform: 'generic-retail', // matches adapterType, no platform-branch warn
        crawlers: { catalog: { method: 'woocommerce' } },
      },
    };
    warnIfAdapterMismatch('catalogonly.example.com', siteInfo as any);
    warnIfAdapterMismatch('catalogonly.example.com', siteInfo as any);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  // ── Batch-5 R4 C5: split `warnedDomains` so a site with BOTH drifts logs both.
  //
  // Before the fix the single `warnedDomains` set was checked AND set by the
  // catalog.method branch first. When platform != adapterType ALSO held, the
  // second branch's `if (warnedDomains.has(domain)) return` early-exited
  // without warning. Operators only saw the catalog.method drift and missed
  // the platform drift on the same domain (or vice versa, depending on order).
  //
  // After the fix: per-branch memos (warnedCatalogMethodDomains and
  // warnedPlatformDomains) — both branches warn on first call when both
  // drifts are present.
  it('warns on BOTH branches for a domain with BOTH drifts (C5, batch-5 R4)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const siteInfo = {
      adapterType: 'generic-retail',
      siteProfile: {
        platform: 'woocommerce',
        crawlers: { catalog: { method: 'shopify' } },
      },
    };
    warnIfAdapterMismatch('bothdrift.example.com', siteInfo as any);
    // Both branches should have fired exactly once each on the FIRST call.
    expect(spy).toHaveBeenCalledTimes(2);
    const messages = spy.mock.calls.map(call => String(call[0])).join('\n');
    expect(messages).toMatch(/catalog\.method/);
    expect(messages).toMatch(/platform=/);
    spy.mockRestore();
  });

  it('still warns once-per-branch-per-domain on repeated calls (C5, batch-5 R4)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const siteInfo = {
      adapterType: 'generic-retail',
      siteProfile: {
        platform: 'woocommerce',
        crawlers: { catalog: { method: 'shopify' } },
      },
    };
    warnIfAdapterMismatch('repeat.example.com', siteInfo as any);
    warnIfAdapterMismatch('repeat.example.com', siteInfo as any);
    warnIfAdapterMismatch('repeat.example.com', siteInfo as any);
    // 2 warnings total — one per branch — across 3 calls.
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
