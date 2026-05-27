'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

// Shape mirrors backend/src/services/maintain-readiness.ts
interface ReadinessReport {
  ready: boolean;
  reasons: string[];
  dbActive: number;
  dbTotal: number;
  liveCount: number | null;
  coverage: number | null;
  hasWatermark: boolean;
  tiersComplete: boolean;
  tierStatus: string[];
  priceCoverage: number;
  stockCoverage: number;
  thumbCoverage: number;
  inStockCount: number;
  recentT1Finds: number;
}

interface DeepLightReport {
  urlOk: boolean;
  titleOk: boolean;
  watermarkOk: boolean;
  productUrl: string | null;
  watermarkUrl: string | null;
  notes: string[];
}

interface DeepVerifyReport {
  verifyOk: boolean;
  method: 'store-api' | 'detail-page';
  sampled: number;
  succeeded: number;
  failures: string[];
}

interface WatermarkWalkReport {
  walkOk: boolean;
  method: 'api-date-since-watermark' | 'navigate-from-watermark' | 'full-catalog-sweep' | 'unknown';
  notes: string[];
  dateAfterUsed?: string;
  itemsReturned?: number;
  page1FirstDate?: string;
  page1LastDate?: string;
  watermarkOnPage1?: boolean;
}

interface VerifyMethodReport {
  declared: string | null;
  endpoint: string | null;
  presenceOk: boolean;
  usable: boolean | null;
  ok: boolean;
  notes: string[];
}

interface BootstrapSiteSummary {
  id: string;
  domain: string;
  name: string;
  url: string;
  isEnabled: boolean;
  isPaused: boolean;
  adapterType: string;
  hasWaf: boolean;
  hasCaptcha: boolean;
  crawlPhase: string;
  addedAt: string;
  lastCrawlAt: string | null;
  consecutiveFailures: number;
  readiness: ReadinessReport;
  deepLight: DeepLightReport | null;
  deepVerify: DeepVerifyReport | null;
  watermarkWalk: WatermarkWalkReport | null;
  verifyMethodCheck: VerifyMethodReport;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function coverageColor(pct: number | null): string {
  if (pct === null) return 'text-foreground-dim';
  if (pct >= 95) return 'text-green-400';
  if (pct >= 75) return 'text-yellow-400';
  if (pct >= 50) return 'text-orange-400';
  return 'text-red-400';
}

/** Tri-state indicator: green when true, red when false, grey "—" when null (not yet checked). */
function DeepIndicator({ label, value, tooltip }: { label: string; value: boolean | null; tooltip?: string }) {
  const color =
    value === true ? 'text-green-400'
    : value === false ? 'text-red-400'
    : 'text-foreground-dim';
  const symbol = value === true ? '✓' : value === false ? '✗' : '—';
  return (
    <span className={`inline-flex items-center gap-1 ${color}`} title={tooltip}>
      <span className="font-mono">{symbol}</span>
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
    </span>
  );
}

export default function BootstrapTransitionPage() {
  const [sites, setSites] = useState<BootstrapSiteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busyIds, setBusyIds] = useState<Record<string, 'refresh' | 'transition' | 'force'>>({});
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadSites = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/bootstrap-sites', { credentials: 'include' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSites(data.sites || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSites();
  }, [loadSites]);

  const handleRefresh = useCallback(async (site: BootstrapSiteSummary) => {
    setBusyIds(prev => ({ ...prev, [site.id]: 'refresh' }));
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/sites/${site.id}/refresh-readiness`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSites(prev => prev?.map(s => (s.id === site.id ? {
        ...s,
        readiness: data.readiness,
        deepLight: data.deepLight ?? s.deepLight,
        deepVerify: data.deepVerify ?? s.deepVerify,
        watermarkWalk: data.watermarkWalk ?? s.watermarkWalk,
        verifyMethodCheck: data.verifyMethodCheck ?? s.verifyMethodCheck,
      } : s)) ?? null);
      setNotice({ kind: 'ok', text: `${site.domain}: readiness + deep checks refreshed.` });
    } catch (e) {
      setNotice({ kind: 'err', text: `${site.domain}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusyIds(prev => {
        const next = { ...prev };
        delete next[site.id];
        return next;
      });
    }
  }, []);

  const handleTransition = useCallback(async (site: BootstrapSiteSummary, force: boolean) => {
    if (!confirm(
      force
        ? `FORCE transition ${site.domain} to maintain phase?\nReadiness check WILL be skipped. The scheduler will start routing to verify-only crawls.`
        : `Transition ${site.domain} to maintain phase?\nThe scheduler will stop bootstrap catalog walks and start verify-only crawls.`,
    )) {
      return;
    }
    setBusyIds(prev => ({ ...prev, [site.id]: force ? 'force' : 'transition' }));
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/sites/${site.id}/transition-to-maintain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ force }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.transitioned) {
        // Remove from list -- site is no longer in bootstrap phase
        setSites(prev => prev?.filter(s => s.id !== site.id) ?? null);
        setNotice({ kind: 'ok', text: `${site.domain}: transitioned to maintain phase.` });
      } else {
        // readiness failed; show the latest readiness on the row
        setSites(prev => prev?.map(s => (s.id === site.id ? { ...s, readiness: data.readiness } : s)) ?? null);
        setNotice({
          kind: 'err',
          text: `${site.domain}: readiness check failed (${data.readiness.reasons.length} issue${data.readiness.reasons.length === 1 ? '' : 's'}). Use Force to override.`,
        });
      }
    } catch (e) {
      setNotice({ kind: 'err', text: `${site.domain}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusyIds(prev => {
        const next = { ...prev };
        delete next[site.id];
        return next;
      });
    }
  }, []);

  // "Truly ready" = mechanical pass AND deep verify pass AND watermark walk
  // pass (matches the green READY badge logic on each row). Sites that
  // haven't been Refreshed yet show up as NEEDS REFRESH and are not counted.
  const readyCount = sites?.filter(s =>
    s.readiness.ready
    && s.deepVerify !== null && s.deepVerify.verifyOk
    && s.watermarkWalk !== null && s.watermarkWalk.walkOk
    && s.verifyMethodCheck.ok
  ).length ?? 0;
  const totalCount = sites?.length ?? 0;

  return (
    <div className="px-4 py-6 max-w-screen-2xl mx-auto">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">Bootstrap &rarr; Maintain Transitions</h1>
          <p className="text-sm text-foreground-dim mt-1">
            Sites in <code>crawlPhase=&quot;bootstrap&quot;</code>. Flip each one to <code>maintain</code> when it&apos;s healthy.
            Ready = DB coverage &ge; 95%, watermark set, T4 cycle complete, price &amp; stock data quality &ge; 95%.
          </p>
        </div>
        <div className="text-sm">
          <Link href="/dashboard/admin/sites" className="text-blue-400 hover:underline">&larr; all sites</Link>
        </div>
      </div>

      <div className="flex items-center gap-4 mb-4 text-sm">
        <span className="text-foreground-dim">
          {loading ? 'Loading…' : `${totalCount} bootstrap site${totalCount === 1 ? '' : 's'}, ${readyCount} ready to transition`}
        </span>
        <button
          onClick={loadSites}
          disabled={loading}
          className="px-3 py-1 text-xs border border-foreground-dim/30 rounded hover:bg-foreground/5 disabled:opacity-50"
        >
          Refresh list
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded text-sm text-red-300">
          Failed to load: {error}
        </div>
      )}

      {notice && (
        <div className={`mb-4 p-3 border rounded text-sm ${
          notice.kind === 'ok'
            ? 'bg-green-900/30 border-green-700 text-green-300'
            : 'bg-orange-900/30 border-orange-700 text-orange-300'
        }`}>
          {notice.text}
        </div>
      )}

      {!loading && sites && sites.length === 0 && (
        <div className="p-8 text-center text-foreground-dim text-sm">
          No sites in bootstrap phase.
        </div>
      )}

      {sites && sites.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-foreground-dim/20 text-foreground-dim text-left">
                <th className="py-2 px-2">Domain</th>
                <th className="py-2 px-2">Adapter</th>
                <th className="py-2 px-2">Enabled</th>
                <th className="py-2 px-2 text-right">DB / Expected</th>
                <th className="py-2 px-2 text-right">Coverage</th>
                <th className="py-2 px-2 text-right">Price%</th>
                <th className="py-2 px-2 text-right">Stock%</th>
                <th className="py-2 px-2">Watermark</th>
                <th className="py-2 px-2">T4 cycle</th>
                <th className="py-2 px-2">Deep checks</th>
                <th className="py-2 px-2">Last crawl</th>
                <th className="py-2 px-2">Ready</th>
                <th className="py-2 px-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sites.map(site => {
                const r = site.readiness;
                const busy = busyIds[site.id];
                return (
                  <tr key={site.id} className="border-b border-foreground-dim/10 hover:bg-foreground/5">
                    <td className="py-2 px-2">
                      <a href={site.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                        {site.domain}
                      </a>
                      {(site.hasWaf || site.hasCaptcha) && (
                        <span className="ml-2 text-[10px] text-foreground-dim">
                          {site.hasWaf && 'WAF '}{site.hasCaptcha && 'CAPTCHA'}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-foreground-dim">{site.adapterType}</td>
                    <td className="py-2 px-2">
                      <span className={site.isEnabled ? 'text-green-400' : 'text-foreground-dim'}>
                        {site.isEnabled ? 'yes' : 'no'}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">
                      {r.dbActive}
                      <span className="text-foreground-dim"> / {r.liveCount ?? '?'}</span>
                    </td>
                    <td className={`py-2 px-2 text-right tabular-nums ${coverageColor(r.coverage)}`}>
                      {r.coverage === null ? '—' : `${r.coverage}%`}
                    </td>
                    <td className={`py-2 px-2 text-right tabular-nums ${coverageColor(r.priceCoverage)}`}>
                      {r.priceCoverage}%
                    </td>
                    <td className={`py-2 px-2 text-right tabular-nums ${coverageColor(r.stockCoverage)}`}>
                      {r.stockCoverage}%
                    </td>
                    <td className="py-2 px-2">
                      <span className={r.hasWatermark ? 'text-green-400' : 'text-red-400'}>
                        {r.hasWatermark ? 'set' : 'missing'}
                      </span>
                    </td>
                    <td className="py-2 px-2">
                      <span className={r.tiersComplete ? 'text-green-400' : 'text-orange-400'}>
                        {r.tiersComplete ? 'complete' : 'pending'}
                      </span>
                      <div
                        className="text-[10px] text-foreground-dim mt-0.5"
                        title="Of the last 20 CrawlEvents, how many found products. 0/20 + T4 complete = swept clean; 0/20 + T4 pending = crawler is starved or broken."
                      >
                        T1 hits {r.recentT1Finds}/20
                      </div>
                    </td>
                    <td className="py-2 px-2">
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                        <DeepIndicator
                          label="URL"
                          value={site.deepLight ? site.deepLight.urlOk : null}
                          tooltip={
                            site.deepLight === null
                              ? 'Pending'
                              : site.deepLight.urlOk
                                ? `OK (${site.deepLight.productUrl ?? ''})`
                                : (site.deepLight.notes.find(n => n.includes('product URL') || n.includes('no active')) ?? 'product URL fetch failed')
                          }
                        />
                        <DeepIndicator
                          label="Title"
                          value={site.deepLight ? site.deepLight.titleOk : null}
                          tooltip={
                            site.deepLight === null
                              ? 'Pending'
                              : site.deepLight.titleOk
                                ? 'DB title appears in fetched HTML'
                                : (site.deepLight.notes.find(n => n.includes('title')) ?? 'title not found in response')
                          }
                        />
                        <DeepIndicator
                          label="WM"
                          value={site.deepLight ? site.deepLight.watermarkOk : null}
                          tooltip={
                            site.deepLight === null
                              ? 'Pending'
                              : site.deepLight.watermarkOk
                                ? `OK (${site.deepLight.watermarkUrl ?? ''})`
                                : (site.deepLight.notes.find(n => n.includes('watermark')) ?? 'no watermark or fetch failed')
                          }
                        />
                        <DeepIndicator
                          label="Verify"
                          value={site.deepVerify ? site.deepVerify.verifyOk : null}
                          tooltip={
                            site.deepVerify === null
                              ? 'Click Refresh on this row to run the maintain-phase verify dry-run'
                              : site.deepVerify.verifyOk
                                ? `${site.deepVerify.method}: ${site.deepVerify.succeeded}/${site.deepVerify.sampled} products verified`
                                : `${site.deepVerify.method}: ${site.deepVerify.succeeded}/${site.deepVerify.sampled} (${site.deepVerify.failures.slice(0, 2).join('; ')})`
                          }
                        />
                        <DeepIndicator
                          label="Walk"
                          value={site.watermarkWalk ? site.watermarkWalk.walkOk : null}
                          tooltip={
                            site.watermarkWalk === null
                              ? 'Click Refresh on this row to run the T1 watermark walk dry-run'
                              : `${site.watermarkWalk.method}: ${site.watermarkWalk.notes.slice(0, 2).join('; ')}`
                          }
                        />
                        {/* Method pill: presence on page-load, usability after Refresh.
                            Stays grey until Refresh probes end-to-end; green = method declared
                            in profile AND probed 3/3 products reachable through the verify
                            code path; red = either missing/invalid in profile, or probe failed. */}
                        <DeepIndicator
                          label="Method"
                          value={
                            site.verifyMethodCheck.ok
                              ? true
                              : !site.verifyMethodCheck.presenceOk
                                ? false
                                : site.verifyMethodCheck.usable === null
                                  ? null
                                  : false
                          }
                          tooltip={
                            site.verifyMethodCheck.declared
                              ? `${site.verifyMethodCheck.declared}${site.verifyMethodCheck.endpoint ? ' (' + site.verifyMethodCheck.endpoint + ')' : ''}: ${site.verifyMethodCheck.notes.slice(0, 2).join('; ')}`
                              : `verifyMethod not declared in siteProfile. ${site.verifyMethodCheck.notes.slice(0, 2).join('; ')}`
                          }
                        />
                      </div>
                    </td>
                    <td className="py-2 px-2 text-foreground-dim">{formatTime(site.lastCrawlAt)}</td>
                    <td className="py-2 px-2">
                      {(() => {
                        // READY gates on layer-1 mechanical AND deep verify AND watermark walk.
                        // - NOT READY (grey) = mechanical issues
                        // - NEEDS REFRESH (yellow) = mechanical ok, deepVerify or walk never run
                        // - VERIFY FAIL (red) = deepVerify.verifyOk === false
                        // - WALK FAIL (red) = watermarkWalk.walkOk === false (T1 won't advance in maintain)
                        // - READY (green) = everything green
                        if (!r.ready) {
                          return <span className="text-foreground-dim" title={r.reasons.join('; ')}>NOT READY</span>;
                        }
                        if (!site.verifyMethodCheck.presenceOk) {
                          return (
                            <span className="text-red-400 font-medium" title={site.verifyMethodCheck.notes.slice(0, 2).join('; ')}>
                              METHOD MISSING
                            </span>
                          );
                        }
                        if (site.deepVerify === null || site.watermarkWalk === null || site.verifyMethodCheck.usable === null) {
                          return <span className="text-yellow-400" title="Click Refresh to run deep verify + watermark walk + method probe">NEEDS REFRESH</span>;
                        }
                        if (!site.deepVerify.verifyOk) {
                          return (
                            <span className="text-red-400 font-medium" title={`Maintain verify will fail: ${site.deepVerify.failures.slice(0, 2).join('; ')}`}>
                              VERIFY FAIL
                            </span>
                          );
                        }
                        if (!site.verifyMethodCheck.ok) {
                          return (
                            <span className="text-red-400 font-medium" title={`Method probe failed: ${site.verifyMethodCheck.notes.slice(0, 2).join('; ')}`}>
                              METHOD FAIL
                            </span>
                          );
                        }
                        if (!site.watermarkWalk.walkOk) {
                          return (
                            <span className="text-red-400 font-medium" title={`T1 walk will fail (${site.watermarkWalk.method}): ${site.watermarkWalk.notes.slice(0, 2).join('; ')}`}>
                              WALK FAIL
                            </span>
                          );
                        }
                        return <span className="text-green-400 font-medium">READY</span>;
                      })()}
                    </td>
                    <td className="py-2 px-2">
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleRefresh(site)}
                          disabled={Boolean(busy)}
                          className="px-2 py-0.5 text-[11px] border border-foreground-dim/30 rounded hover:bg-foreground/5 disabled:opacity-50"
                          title="Re-run the readiness check against the live site"
                        >
                          {busy === 'refresh' ? '…' : 'Refresh'}
                        </button>
                        <button
                          onClick={() => handleTransition(site, false)}
                          disabled={
                            Boolean(busy)
                            || !r.ready
                            || site.deepVerify === null
                            || site.deepVerify.verifyOk !== true
                            || site.watermarkWalk === null
                            || site.watermarkWalk.walkOk !== true
                            || !site.verifyMethodCheck.ok
                          }
                          className="px-2 py-0.5 text-[11px] border border-green-500/40 text-green-400 rounded hover:bg-green-500/10 disabled:opacity-30 disabled:cursor-not-allowed"
                          title={
                            !r.ready
                              ? `Not ready (mechanical): ${r.reasons.join('; ')}`
                              : (site.deepVerify === null || site.watermarkWalk === null)
                                ? 'Click Refresh first to run deep verify + watermark walk'
                                : !site.deepVerify.verifyOk
                                  ? `Maintain verify failed: ${site.deepVerify.failures.slice(0, 2).join('; ')}`
                                  : !site.watermarkWalk.walkOk
                                    ? `T1 walk failed (${site.watermarkWalk.method}): ${site.watermarkWalk.notes.slice(0, 2).join('; ')}`
                                    : 'Transition to maintain phase'
                          }
                        >
                          {busy === 'transition' ? '…' : 'Transition'}
                        </button>
                        <button
                          onClick={() => handleTransition(site, true)}
                          disabled={Boolean(busy)}
                          className="px-2 py-0.5 text-[11px] border border-orange-500/40 text-orange-400 rounded hover:bg-orange-500/10 disabled:opacity-50"
                          title="FORCE transition: skip the readiness check (use only when you're sure)"
                        >
                          {busy === 'force' ? '…' : 'Force'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Reasons section: list failing reasons under NOT-READY sites */}
      {sites && sites.some(s => !s.readiness.ready) && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold mb-2 text-foreground-dim">Why each NOT-READY site is blocked</h2>
          <div className="space-y-2 text-xs">
            {sites.filter(s => !s.readiness.ready).map(site => (
              <div key={site.id} className="flex gap-3">
                <span className="font-mono text-foreground-dim min-w-[200px]">{site.domain}</span>
                <span className="text-foreground-dim">{site.readiness.reasons.join('; ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
