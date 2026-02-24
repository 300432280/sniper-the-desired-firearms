'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

interface SiteDashboard {
  id: string;
  domain: string;
  name: string;
  url: string;
  isEnabled: boolean;
  adapterType: string;
  siteType: string;
  trafficClass: string;
  difficultyScore: number;
  crawlIntervalMin: number;
  nextCrawlAt: string | null;
  lastCrawlAt: string | null;
  crawlLock: string | null;
  consecutiveFailures: number;
  avgResponseTimeMs: number | null;
  hasWaf: boolean;
  hasRateLimit: boolean;
  hasCaptcha: boolean;
  requiresSucuri: boolean;
  overrideTrafficClass: string | null;
  overrideDifficulty: number | null;
  overrideInterval: number | null;
  activeSearches: number;
  totalCrawlEvents: number;
  lastCrawl: {
    status: string;
    responseTimeMs: number | null;
    statusCode: number | null;
    matchesFound: number;
    crawledAt: string;
  } | null;
}

const TRAFFIC_COLORS: Record<string, string> = {
  tiny: 'text-gray-400 border-gray-400/30 bg-gray-400/5',
  small: 'text-blue-400 border-blue-400/30 bg-blue-400/5',
  medium: 'text-green-400 border-green-400/30 bg-green-400/5',
  large: 'text-purple-400 border-purple-400/30 bg-purple-400/5',
};

const STATUS_COLORS: Record<string, string> = {
  success: 'text-green-400',
  fail: 'text-red-400',
  timeout: 'text-yellow-400',
  blocked: 'text-orange-400',
  captcha: 'text-red-500',
};

function difficultyColor(score: number): string {
  if (score <= 30) return 'text-green-400';
  if (score <= 60) return 'text-yellow-400';
  return 'text-red-400';
}

function healthDot(failures: number): string {
  if (failures === 0) return 'bg-green-500';
  if (failures <= 2) return 'bg-yellow-500';
  return 'bg-red-500';
}

function formatCountdown(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return 'Due now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d`;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type SortField = 'domain' | 'difficulty' | 'interval' | 'nextCrawl' | 'failures' | 'traffic' | 'searches';
type ExpandedCell = { siteId: string; column: 'difficulty' | 'interval' } | null;

/** Compute a difficulty breakdown matching priority-engine.ts logic.
 *  The frontend knows detection-based signals but not outcome-based ones
 *  (zero-match streak, Playwright bump) — those are computed server-side.
 *  Any gap between signal sum and actual score = outcome-based penalties. */
function getDifficultyBreakdown(site: SiteDashboard) {
  const factors: { label: string; value: number }[] = [];

  // Detection-based signals (known client-side)
  if (site.requiresSucuri || site.hasWaf) factors.push({ label: 'WAF / Sucuri', value: 15 });
  if (site.hasRateLimit) factors.push({ label: 'Rate Limit detected', value: 20 });
  if (site.hasCaptcha) factors.push({ label: 'CAPTCHA detected', value: 25 });
  if (site.avgResponseTimeMs) {
    if (site.avgResponseTimeMs > 8000) factors.push({ label: `Slow response (${Math.round(site.avgResponseTimeMs)}ms > 8s)`, value: 15 });
    else if (site.avgResponseTimeMs > 5000) factors.push({ label: `Slow response (${Math.round(site.avgResponseTimeMs)}ms > 5s)`, value: 10 });
    else if (site.avgResponseTimeMs > 3000) factors.push({ label: `Slow response (${Math.round(site.avgResponseTimeMs)}ms > 3s)`, value: 5 });
  }
  if (site.consecutiveFailures >= 5) factors.push({ label: `${site.consecutiveFailures} consecutive failures (≥5)`, value: 20 });
  else if (site.consecutiveFailures >= 3) factors.push({ label: `${site.consecutiveFailures} consecutive failures (≥3)`, value: 10 });

  const signalSum = Math.min(factors.reduce((s, f) => s + f.value, 0), 100);
  const actual = site.difficultyScore;

  // Outcome-based penalties are computed server-side (zero-match streak, Playwright bump).
  // Show the delta as a single line if the stored score exceeds the signal sum.
  const outcomePenalty = actual - signalSum;
  if (outcomePenalty > 0) {
    factors.push({ label: 'Crawl outcome penalties (0-match streak / Playwright)', value: outcomePenalty });
  }

  return { factors, actual };
}

/** Compute an interval breakdown matching priority-engine.ts logic */
function getIntervalBreakdown(site: SiteDashboard) {
  const BASE = 120;
  const difficulty = site.overrideDifficulty ?? site.difficultyScore;
  const trafficClass = site.overrideTrafficClass ?? site.trafficClass;

  const diffMult = 1.0 + difficulty / 50;
  const trafficMultMap: Record<string, number> = { tiny: 4.0, small: 2.5, medium: 1.5, large: 1.0 };
  const tMult = trafficMultMap[trafficClass] ?? 1.5;
  const failMult = Math.min(Math.pow(1.5, site.consecutiveFailures), 8.0);
  const wafMult = site.hasWaf ? 1.3 : 1.0;
  const rlMult = site.hasRateLimit ? 2.0 : 1.0;
  const capMult = site.hasCaptcha ? 3.0 : 1.0;

  const trafficFloors: Record<string, number> = { tiny: 720, small: 240, medium: 60, large: 30 };
  const floor = trafficFloors[trafficClass] ?? 60;

  const raw = BASE * diffMult * tMult * failMult * wafMult * rlMult * capMult;
  const clamped = Math.max(30, Math.min(1440, Math.round(raw)));
  const final = Math.max(clamped, floor);

  const multipliers: { label: string; value: string }[] = [
    { label: 'Base interval', value: `${BASE}m` },
    { label: `Difficulty (${difficulty}/100)`, value: `×${diffMult.toFixed(2)}` },
    { label: `Traffic class (${trafficClass})`, value: `×${tMult.toFixed(1)}` },
  ];
  if (failMult > 1) multipliers.push({ label: `Failure backoff (${site.consecutiveFailures} fails)`, value: `×${failMult.toFixed(2)}` });
  if (wafMult > 1) multipliers.push({ label: 'WAF penalty', value: '×1.3' });
  if (rlMult > 1) multipliers.push({ label: 'Rate limit penalty', value: '×2.0' });
  if (capMult > 1) multipliers.push({ label: 'CAPTCHA penalty', value: '×3.0' });
  if (final !== clamped) multipliers.push({ label: `Traffic floor (${trafficClass})`, value: `≥${floor}m` });

  return { multipliers, raw: Math.round(raw), final };
}

export default function SiteMonitorPage() {
  const [sites, setSites] = useState<SiteDashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortField, setSortField] = useState<SortField>('domain');
  const [sortAsc, setSortAsc] = useState(true);
  const [filterAdapter, setFilterAdapter] = useState('');
  const [filterTraffic, setFilterTraffic] = useState('');
  const [filterEnabled, setFilterEnabled] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [expanded, setExpanded] = useState<ExpandedCell>(null);
  const [headerInfo, setHeaderInfo] = useState<'difficulty' | 'interval' | null>(null);

  const fetchSites = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/sites/dashboard', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSites(data.sites);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSites(); }, [fetchSites]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(fetchSites, 60000);
    return () => clearInterval(interval);
  }, [fetchSites]);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortAsc(!sortAsc);
    else { setSortField(field); setSortAsc(true); }
  };

  // Get unique adapter types for filter
  const adapterTypes = [...new Set(sites.map(s => s.adapterType))].sort();
  const trafficClasses = ['tiny', 'small', 'medium', 'large'];

  // Filter and sort
  const filteredSites = sites
    .filter(s => !filterAdapter || s.adapterType === filterAdapter)
    .filter(s => !filterTraffic || s.trafficClass === filterTraffic)
    .filter(s => filterEnabled === 'all' || (filterEnabled === 'enabled' ? s.isEnabled : !s.isEnabled))
    .sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      switch (sortField) {
        case 'domain': return dir * a.domain.localeCompare(b.domain);
        case 'difficulty': return dir * (a.difficultyScore - b.difficultyScore);
        case 'interval': return dir * (a.crawlIntervalMin - b.crawlIntervalMin);
        case 'nextCrawl': return dir * ((a.nextCrawlAt || '').localeCompare(b.nextCrawlAt || ''));
        case 'failures': return dir * (a.consecutiveFailures - b.consecutiveFailures);
        case 'traffic': return dir * a.trafficClass.localeCompare(b.trafficClass);
        case 'searches': return dir * (a.activeSearches - b.activeSearches);
        default: return 0;
      }
    });

  // Summary stats
  const enabledCount = sites.filter(s => s.isEnabled).length;
  const failingCount = sites.filter(s => s.consecutiveFailures >= 3).length;
  const lockedCount = sites.filter(s => s.crawlLock).length;

  const handleToggle = async (id: string, currentEnabled: boolean) => {
    try {
      await fetch(`/api/admin/sites/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: !currentEnabled }),
      });
      fetchSites();
    } catch {}
  };

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <Link href="/dashboard" className="text-[10px] font-heading tracking-widest uppercase text-foreground-dim hover:text-foreground transition-colors mb-2 block">
            &larr; Dashboard
          </Link>
          <p className="text-[10px] font-heading tracking-[0.25em] text-orange-400 uppercase mb-1.5">
            Admin
          </p>
          <h1 className="font-heading text-3xl tracking-wider">
            Site Monitor
          </h1>
        </div>
        <button
          onClick={() => { setLoading(true); fetchSites(); }}
          className="text-[11px] font-heading uppercase tracking-wider px-4 py-2 border border-border text-foreground-muted hover:border-accent/30 hover:text-accent transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-px border border-border bg-border mb-6">
        {[
          { label: 'Total Sites', value: sites.length },
          { label: 'Enabled', value: enabledCount },
          { label: 'Failing (3+)', value: failingCount, danger: failingCount > 0 },
          { label: 'Crawling Now', value: lockedCount },
        ].map((stat) => (
          <div key={stat.label} className="bg-surface px-4 py-3">
            <div className={`font-heading text-xl font-bold ${stat.danger ? 'text-red-400' : 'text-foreground'}`}>
              {loading ? '\u2014' : stat.value}
            </div>
            <div className="text-[9px] font-heading tracking-widest uppercase text-foreground-muted mt-0.5">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted">Filters:</span>
        <select
          value={filterAdapter}
          onChange={e => setFilterAdapter(e.target.value)}
          className="bg-surface border border-border text-xs text-foreground-muted px-2 py-1"
        >
          <option value="">All adapters</option>
          {adapterTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={filterTraffic}
          onChange={e => setFilterTraffic(e.target.value)}
          className="bg-surface border border-border text-xs text-foreground-muted px-2 py-1"
        >
          <option value="">All traffic</option>
          {trafficClasses.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={filterEnabled}
          onChange={e => setFilterEnabled(e.target.value as any)}
          className="bg-surface border border-border text-xs text-foreground-muted px-2 py-1"
        >
          <option value="all">All status</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
        <span className="text-[10px] text-foreground-dim ml-auto">
          {filteredSites.length} of {sites.length} sites
        </span>
      </div>

      {error && (
        <div className="border border-danger/30 bg-danger-subtle text-secondary px-5 py-3 text-sm mb-6">
          {error}
        </div>
      )}

      {/* Header info panels */}
      {headerInfo === 'difficulty' && (
        <div className="border border-border bg-surface-elevated px-5 py-4 mb-2">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">How Difficulty Score is Calculated</p>
              <p className="text-xs text-foreground-dim mb-3">Score ranges 0-100. Higher = harder to scrape safely. Each signal adds points:</p>
              <table className="text-[10px]">
                <tbody>
                  {[
                    ['WAF / Sucuri detected', '+15'],
                    ['Rate limit detected', '+20'],
                    ['CAPTCHA detected', '+25'],
                    ['Requires authentication', '+5'],
                    ['Response time > 3s / > 5s / > 8s', '+5 / +10 / +15'],
                    ['Consecutive failures >= 3 / >= 5', '+10 / +20'],
                    ['Playwright fallback needed', '+10 (at crawl time)'],
                  ].map(([label, value]) => (
                    <tr key={label} className="border-b border-border/30">
                      <td className="py-1 pr-6 text-foreground-muted">{label}</td>
                      <td className="py-1 text-right font-heading text-yellow-400">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[9px] text-foreground-dim mt-2">Click any site's difficulty score to see its specific breakdown.</p>
            </div>
            <button onClick={() => setHeaderInfo(null)} className="text-foreground-dim hover:text-foreground text-xs ml-4">&#x2715;</button>
          </div>
        </div>
      )}
      {headerInfo === 'interval' && (
        <div className="border border-border bg-surface-elevated px-5 py-4 mb-2">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">How Crawl Interval is Calculated</p>
              <p className="text-xs text-foreground-dim mb-3">Base interval (120m) is multiplied by these factors:</p>
              <table className="text-[10px]">
                <tbody>
                  {[
                    ['Difficulty multiplier', '1 + (score / 50) — e.g. score 0 = x1, score 50 = x2'],
                    ['Traffic class', 'tiny x4, small x2.5, medium x1.5, large x1'],
                    ['Failure backoff', '1.5^failures — exponential, capped at x8'],
                    ['WAF detected', 'x1.3'],
                    ['Rate limit detected', 'x2.0'],
                    ['CAPTCHA detected', 'x3.0'],
                    ['Peak hours (12-5pm EST)', 'x1.3'],
                    ['Seasonal (Black Friday, Boxing Day)', 'x1.5'],
                    ['High demand (> 5 active searches)', 'x0.8 (faster)'],
                    ['High yield (> 5 avg matches)', 'x0.85 (faster)'],
                  ].map(([label, value]) => (
                    <tr key={label} className="border-b border-border/30">
                      <td className="py-1 pr-6 text-foreground-muted">{label}</td>
                      <td className="py-1 text-foreground-dim">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[9px] text-foreground-dim mt-2">
                {'Traffic floor enforced: tiny >= 720m, small >= 240m, medium >= 60m, large >= 30m. Absolute bounds: 30m - 1440m (24h). '}
                Click any site&apos;s interval to see its specific breakdown.
              </p>
            </div>
            <button onClick={() => setHeaderInfo(null)} className="text-foreground-dim hover:text-foreground text-xs ml-4">&#x2715;</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="border border-border overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface-elevated border-b border-border">
              {[
                { field: 'domain' as SortField, label: 'Site', info: null as 'difficulty' | 'interval' | null },
                { field: null, label: 'Adapter', info: null },
                { field: 'traffic' as SortField, label: 'Traffic', info: null },
                { field: 'difficulty' as SortField, label: 'Difficulty', info: 'difficulty' as const },
                { field: 'interval' as SortField, label: 'Interval', info: 'interval' as const },
                { field: 'nextCrawl' as SortField, label: 'Next Crawl', info: null },
                { field: null, label: 'Last Crawl', info: null },
                { field: 'failures' as SortField, label: 'Failures', info: null },
                { field: 'searches' as SortField, label: 'Searches', info: null },
                { field: null, label: 'Signals', info: null },
                { field: null, label: 'Actions', info: null },
              ].map((col) => (
                <th
                  key={col.label}
                  className={`px-3 py-2 text-left text-[9px] font-heading tracking-widest uppercase text-foreground-muted whitespace-nowrap ${
                    col.field ? 'cursor-pointer hover:text-foreground' : ''
                  } ${sortField === col.field ? 'text-accent' : ''}`}
                >
                  <span className="inline-flex items-center gap-1">
                    <span onClick={() => col.field && handleSort(col.field)}>
                      {col.label}
                      {sortField === col.field && (sortAsc ? ' \u2191' : ' \u2193')}
                    </span>
                    {col.info && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setHeaderInfo(prev => prev === col.info ? null : col.info); }}
                        className={`w-3.5 h-3.5 rounded-full border text-[8px] leading-none flex items-center justify-center ${
                          headerInfo === col.info ? 'border-accent text-accent' : 'border-foreground-dim/40 text-foreground-dim hover:text-foreground hover:border-foreground'
                        }`}
                        title={`How is ${col.label.toLowerCase()} calculated?`}
                      >
                        ?
                      </button>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={11} className="px-3 py-8 text-center text-foreground-dim animate-pulse">Loading sites...</td></tr>
            )}
            {!loading && filteredSites.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-8 text-center text-foreground-dim">No sites match filters</td></tr>
            )}
            {filteredSites.map((site) => (
              <React.Fragment key={site.id}>
              <tr
                className={`border-b border-border/50 hover:bg-surface-elevated/30 transition-colors ${
                  !site.isEnabled ? 'opacity-50' : ''
                }`}
              >
                {/* Site name + domain */}
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${healthDot(site.consecutiveFailures)}`} />
                    <div className="min-w-0">
                      <p className="text-foreground font-heading tracking-wide truncate">{site.name}</p>
                      <p className="text-[10px] text-foreground-dim truncate">{site.domain}</p>
                    </div>
                  </div>
                </td>

                {/* Adapter */}
                <td className="px-3 py-2.5">
                  <span className="text-[9px] font-heading tracking-wider uppercase border border-border/50 px-1.5 py-0.5 text-foreground-muted">
                    {site.adapterType}
                  </span>
                </td>

                {/* Traffic class */}
                <td className="px-3 py-2.5">
                  <span className={`text-[9px] font-heading tracking-wider uppercase border px-1.5 py-0.5 ${TRAFFIC_COLORS[site.trafficClass] || ''}`}>
                    {site.overrideTrafficClass ? `${site.trafficClass}*` : site.trafficClass}
                  </span>
                </td>

                {/* Difficulty (clickable) */}
                <td className="px-3 py-2.5">
                  <button
                    onClick={() => setExpanded(prev => prev?.siteId === site.id && prev.column === 'difficulty' ? null : { siteId: site.id, column: 'difficulty' })}
                    className={`font-heading font-bold ${difficultyColor(site.difficultyScore)} hover:underline cursor-pointer`}
                    title="Click to see breakdown"
                  >
                    {site.overrideDifficulty != null ? `${site.difficultyScore}*` : site.difficultyScore}
                  </button>
                </td>

                {/* Interval (clickable) */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <button
                    onClick={() => setExpanded(prev => prev?.siteId === site.id && prev.column === 'interval' ? null : { siteId: site.id, column: 'interval' })}
                    className="text-foreground-muted hover:underline cursor-pointer"
                    title="Click to see breakdown"
                  >
                    {site.overrideInterval != null ? (
                      <span className="text-orange-400">{site.overrideInterval}m*</span>
                    ) : (
                      `${site.crawlIntervalMin}m`
                    )}
                  </button>
                </td>

                {/* Next crawl */}
                <td className="px-3 py-2.5 text-foreground-muted whitespace-nowrap">
                  {site.crawlLock ? (
                    <span className="text-blue-400 animate-pulse">Crawling...</span>
                  ) : (
                    formatCountdown(site.nextCrawlAt)
                  )}
                </td>

                {/* Last crawl */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {site.lastCrawl ? (
                    <div>
                      <span className={`${STATUS_COLORS[site.lastCrawl.status] || 'text-foreground-muted'}`}>
                        {site.lastCrawl.status}
                      </span>
                      {site.lastCrawl.responseTimeMs && (
                        <span className="text-foreground-dim ml-1">
                          {site.lastCrawl.responseTimeMs}ms
                        </span>
                      )}
                      <p className="text-[10px] text-foreground-dim">{formatTime(site.lastCrawl.crawledAt)}</p>
                    </div>
                  ) : (
                    <span className="text-foreground-dim">\u2014</span>
                  )}
                </td>

                {/* Failures */}
                <td className="px-3 py-2.5">
                  <span className={site.consecutiveFailures > 0 ? 'text-red-400 font-bold' : 'text-foreground-dim'}>
                    {site.consecutiveFailures}
                  </span>
                </td>

                {/* Active searches */}
                <td className="px-3 py-2.5 text-foreground-muted">
                  {site.activeSearches}
                </td>

                {/* Signals */}
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1">
                    {site.hasWaf && <span className="text-[8px] border border-yellow-400/30 text-yellow-400 px-1 rounded" title="WAF detected">WAF</span>}
                    {site.hasRateLimit && <span className="text-[8px] border border-orange-400/30 text-orange-400 px-1 rounded" title="Rate limit detected">RL</span>}
                    {site.hasCaptcha && <span className="text-[8px] border border-red-400/30 text-red-400 px-1 rounded" title="CAPTCHA detected">CAP</span>}
                    {site.requiresSucuri && <span className="text-[8px] border border-purple-400/30 text-purple-400 px-1 rounded" title="Requires Sucuri bypass">SUC</span>}
                  </div>
                </td>

                {/* Actions */}
                <td className="px-3 py-2.5">
                  <button
                    onClick={() => handleToggle(site.id, site.isEnabled)}
                    className={`text-[9px] font-heading uppercase tracking-wider px-2 py-0.5 border transition-colors ${
                      site.isEnabled
                        ? 'border-green-400/30 text-green-400 hover:bg-green-400/10'
                        : 'border-red-400/30 text-red-400 hover:bg-red-400/10'
                    }`}
                  >
                    {site.isEnabled ? 'On' : 'Off'}
                  </button>
                </td>
              </tr>

              {/* Expandable explanation row */}
              {expanded?.siteId === site.id && (
                <tr className="bg-surface-elevated/50">
                  <td colSpan={11} className="px-4 py-3">
                    {expanded.column === 'difficulty' && (() => {
                      const { factors, actual } = getDifficultyBreakdown(site);
                      return (
                        <div className="max-w-md">
                          <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">
                            Difficulty Breakdown — {site.domain}
                          </p>
                          {site.overrideDifficulty != null && (
                            <p className="text-[10px] text-orange-400 mb-2">Manual override: {site.overrideDifficulty}</p>
                          )}
                          {factors.length === 0 ? (
                            <p className="text-[10px] text-foreground-dim">No difficulty signals detected — base score is 0.</p>
                          ) : (
                            <table className="text-[10px] w-full">
                              <tbody>
                                {factors.map((f, i) => (
                                  <tr key={i} className="border-b border-border/30">
                                    <td className="py-1 text-foreground-muted">{f.label}</td>
                                    <td className="py-1 text-right font-heading text-yellow-400">+{f.value}</td>
                                  </tr>
                                ))}
                                <tr className="font-bold">
                                  <td className="py-1 pt-2 text-foreground">Total</td>
                                  <td className={`py-1 pt-2 text-right font-heading ${difficultyColor(actual)}`}>{actual}</td>
                                </tr>
                              </tbody>
                            </table>
                          )}
                          <p className="text-[9px] text-foreground-dim mt-2">
                            Score capped at 100. Outcome penalties include zero-match streaks (+10/+20/+35) and Playwright fallback (+10).
                          </p>
                        </div>
                      );
                    })()}
                    {expanded.column === 'interval' && (() => {
                      const { multipliers, raw, final: finalVal } = getIntervalBreakdown(site);
                      return (
                        <div className="max-w-md">
                          <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">
                            Interval Breakdown — {site.domain}
                          </p>
                          {site.overrideInterval != null && (
                            <p className="text-[10px] text-orange-400 mb-2">Manual override: {site.overrideInterval}m</p>
                          )}
                          <table className="text-[10px] w-full">
                            <tbody>
                              {multipliers.map((m, i) => (
                                <tr key={i} className="border-b border-border/30">
                                  <td className="py-1 text-foreground-muted">{m.label}</td>
                                  <td className="py-1 text-right font-heading text-blue-400">{m.value}</td>
                                </tr>
                              ))}
                              <tr className="font-bold">
                                <td className="py-1 pt-2 text-foreground">Result</td>
                                <td className="py-1 pt-2 text-right font-heading text-foreground">{finalVal}m</td>
                              </tr>
                            </tbody>
                          </table>
                          <p className="text-[9px] text-foreground-dim mt-2">
                            Peak hours (×1.3), seasonal (×1.5), demand ({'>'}{' '}5 searches: ×0.8), and yield bonuses also apply at crawl time. Clamped to 30m–1440m.
                          </p>
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
