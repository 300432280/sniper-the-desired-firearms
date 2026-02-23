'use client';

import { useEffect, useState, useCallback } from 'react';
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

export default function SiteMonitorPage() {
  const [sites, setSites] = useState<SiteDashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortField, setSortField] = useState<SortField>('domain');
  const [sortAsc, setSortAsc] = useState(true);
  const [filterAdapter, setFilterAdapter] = useState('');
  const [filterTraffic, setFilterTraffic] = useState('');
  const [filterEnabled, setFilterEnabled] = useState<'all' | 'enabled' | 'disabled'>('all');

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

      {/* Table */}
      <div className="border border-border overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface-elevated border-b border-border">
              {[
                { field: 'domain' as SortField, label: 'Site' },
                { field: null, label: 'Adapter' },
                { field: 'traffic' as SortField, label: 'Traffic' },
                { field: 'difficulty' as SortField, label: 'Difficulty' },
                { field: 'interval' as SortField, label: 'Interval' },
                { field: 'nextCrawl' as SortField, label: 'Next Crawl' },
                { field: null, label: 'Last Crawl' },
                { field: 'failures' as SortField, label: 'Failures' },
                { field: 'searches' as SortField, label: 'Searches' },
                { field: null, label: 'Signals' },
                { field: null, label: 'Actions' },
              ].map((col) => (
                <th
                  key={col.label}
                  onClick={() => col.field && handleSort(col.field)}
                  className={`px-3 py-2 text-left text-[9px] font-heading tracking-widest uppercase text-foreground-muted whitespace-nowrap ${
                    col.field ? 'cursor-pointer hover:text-foreground' : ''
                  } ${sortField === col.field ? 'text-accent' : ''}`}
                >
                  {col.label}
                  {sortField === col.field && (sortAsc ? ' \u2191' : ' \u2193')}
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
              <tr
                key={site.id}
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

                {/* Difficulty */}
                <td className="px-3 py-2.5">
                  <span className={`font-heading font-bold ${difficultyColor(site.difficultyScore)}`}>
                    {site.overrideDifficulty != null ? `${site.difficultyScore}*` : site.difficultyScore}
                  </span>
                </td>

                {/* Interval */}
                <td className="px-3 py-2.5 text-foreground-muted whitespace-nowrap">
                  {site.overrideInterval != null ? (
                    <span className="text-orange-400">{site.overrideInterval}m*</span>
                  ) : (
                    `${site.crawlIntervalMin}m`
                  )}
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
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
