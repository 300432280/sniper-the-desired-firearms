'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SiteProfile {
  platform?: string;
  adapter?: string;
  phase?: string;
  hasWaf?: boolean;
  wafType?: string;
  perPage?: number;
  chunkSize?: number;
  enrichmentChunkSize?: number;
  timeout?: number;
  sortParam?: string;
  searchUrl?: string;
  catalogUrls?: string[];
  dataFlow?: Record<string, any>;
  crawlers?: Record<string, any>;
  apiConfig?: Record<string, any>;
  notes?: string;
  [key: string]: any;
}

interface SiteWithProfile {
  id: string;
  domain: string;
  name: string;
  url: string;
  isEnabled: boolean;
  adapterType: string;
  siteType: string;
  siteCategory: string;
  hasWaf: boolean;
  hasRateLimit: boolean;
  hasCaptcha: boolean;
  requiresSucuri: boolean;
  crawlPhase: string;
  siteProfile: SiteProfile | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const PROFILE_KEY_FIELDS = [
  'platform', 'adapter', 'phase', 'hasWaf', 'wafType', 'perPage',
  'chunkSize', 'enrichmentChunkSize', 'timeout', 'sortParam', 'searchUrl',
  'catalogUrls', 'dataFlow', 'crawlers', 'apiConfig', 'notes',
];

function computeCompleteness(profile: SiteProfile | null): { filled: number; total: number; pct: number } {
  const total = PROFILE_KEY_FIELDS.length;
  if (!profile) return { filled: 0, total, pct: 0 };
  let filled = 0;
  for (const key of PROFILE_KEY_FIELDS) {
    const val = profile[key];
    if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)) {
      filled++;
    }
  }
  return { filled, total, pct: Math.round((filled / total) * 100) };
}

function completenessColor(pct: number): string {
  if (pct >= 70) return 'text-green-400';
  if (pct >= 40) return 'text-yellow-400';
  if (pct >= 15) return 'text-orange-400';
  return 'text-red-400';
}

function completenessBarColor(pct: number): string {
  if (pct >= 70) return 'bg-green-500';
  if (pct >= 40) return 'bg-yellow-500';
  if (pct >= 15) return 'bg-orange-500';
  return 'bg-red-500';
}

function parseProfile(raw: any): SiteProfile | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

// ── Sort ───────────────────────────────────────────────────────────────────────

type SortField = 'domain' | 'adapter' | 'platform' | 'phase' | 'completeness' | 'waf' | 'category';

// ── Component ──────────────────────────────────────────────────────────────────

export default function SiteProfilesPage() {
  const [sites, setSites] = useState<SiteWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('domain');
  const [sortAsc, setSortAsc] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState('');
  const [filterAdapter, setFilterAdapter] = useState('');
  const [filterCompleteness, setFilterCompleteness] = useState<'all' | 'complete' | 'partial' | 'empty'>('all');

  const fetchSites = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/sites/profiles', { credentials: 'include' });
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

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortAsc(!sortAsc);
    else { setSortField(field); setSortAsc(true); }
  };

  // Derive parsed profiles and completeness
  const sitesWithMeta = useMemo(() => {
    return sites.map(s => {
      const profile = parseProfile(s.siteProfile);
      const completeness = computeCompleteness(profile);
      return { ...s, profile, completeness };
    });
  }, [sites]);

  const categories = useMemo(() => [...new Set(sites.map(s => s.siteCategory))].sort(), [sites]);
  const adapterTypes = useMemo(() => [...new Set(sites.map(s => s.adapterType))].sort(), [sites]);

  const filtered = useMemo(() => {
    return sitesWithMeta
      .filter(s => !searchQuery || s.domain.toLowerCase().includes(searchQuery.toLowerCase()) || s.name.toLowerCase().includes(searchQuery.toLowerCase()))
      .filter(s => !filterCategory || s.siteCategory === filterCategory)
      .filter(s => !filterAdapter || s.adapterType === filterAdapter)
      .filter(s => {
        if (filterCompleteness === 'all') return true;
        if (filterCompleteness === 'empty') return s.completeness.pct === 0;
        if (filterCompleteness === 'partial') return s.completeness.pct > 0 && s.completeness.pct < 70;
        return s.completeness.pct >= 70; // complete
      })
      .sort((a, b) => {
        const dir = sortAsc ? 1 : -1;
        switch (sortField) {
          case 'domain': return dir * a.domain.localeCompare(b.domain);
          case 'adapter': return dir * a.adapterType.localeCompare(b.adapterType);
          case 'platform': return dir * ((a.profile?.platform ?? '').localeCompare(b.profile?.platform ?? ''));
          case 'phase': return dir * a.crawlPhase.localeCompare(b.crawlPhase);
          case 'completeness': return dir * (a.completeness.pct - b.completeness.pct);
          case 'waf': return dir * (Number(a.hasWaf) - Number(b.hasWaf));
          case 'category': return dir * a.siteCategory.localeCompare(b.siteCategory);
          default: return 0;
        }
      });
  }, [sitesWithMeta, searchQuery, filterCategory, filterAdapter, filterCompleteness, sortField, sortAsc]);

  // Summary stats
  const totalProfiles = sitesWithMeta.filter(s => s.profile !== null).length;
  const emptyProfiles = sitesWithMeta.filter(s => s.completeness.pct === 0).length;
  const avgCompleteness = sitesWithMeta.length > 0
    ? Math.round(sitesWithMeta.reduce((sum, s) => sum + s.completeness.pct, 0) / sitesWithMeta.length)
    : 0;
  const wafCount = sitesWithMeta.filter(s => s.hasWaf).length;

  const SortHeader = ({ field, label, className }: { field: SortField; label: string; className?: string }) => (
    <th
      className={`pb-2 pr-3 cursor-pointer hover:text-foreground transition-colors select-none ${className ?? ''}`}
      onClick={() => handleSort(field)}
    >
      {label}
      {sortField === field && (
        <span className="ml-0.5 text-accent">{sortAsc ? '\u25b2' : '\u25bc'}</span>
      )}
    </th>
  );

  return (
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-4 mb-2">
            <Link href="/dashboard" className="text-[10px] font-heading tracking-widest uppercase text-foreground-dim hover:text-foreground transition-colors block">
              &larr; Dashboard
            </Link>
            <Link href="/dashboard/admin/sites" className="text-[10px] font-heading tracking-widest uppercase text-foreground-dim hover:text-foreground transition-colors block">
              Site Monitor
            </Link>
          </div>
          <p className="text-[10px] font-heading tracking-[0.25em] text-orange-400 uppercase mb-1.5">
            Admin
          </p>
          <h1 className="font-heading text-3xl tracking-wider">
            Site Profiles
          </h1>
          <p className="text-[10px] text-foreground-dim mt-1">Per-site configuration: platform, URLs, WAF, data flow, crawler config</p>
        </div>
        <button
          onClick={() => { setLoading(true); fetchSites(); }}
          className="text-[11px] font-heading uppercase tracking-wider px-4 py-2 border border-border text-foreground-muted hover:border-accent/30 hover:text-accent transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-px border border-border bg-border mb-6">
        {[
          { label: 'Total Sites', value: sites.length },
          { label: 'With Profile', value: totalProfiles },
          { label: 'No Profile', value: emptyProfiles, warn: emptyProfiles > 0 },
          { label: 'WAF Sites', value: wafCount },
          { label: 'Avg Completeness', value: `${avgCompleteness}%`, pct: avgCompleteness },
        ].map((stat) => (
          <div key={stat.label} className="bg-surface px-4 py-3">
            <div className={`font-heading text-xl font-bold ${
              (stat as any).warn ? 'text-yellow-400' :
              (stat as any).pct !== undefined ? completenessColor((stat as any).pct) :
              'text-foreground'
            }`}>
              {loading ? '\u2014' : stat.value}
            </div>
            <div className="text-[9px] font-heading tracking-widest uppercase text-foreground-muted mt-0.5">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search by domain or name..."
          className="bg-surface border border-border px-3 py-1.5 text-[11px] text-foreground placeholder:text-foreground-dim focus:border-accent/50 focus:outline-none w-64"
        />
        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          className="bg-surface border border-border px-2 py-1.5 text-[11px] text-foreground focus:border-accent/50 focus:outline-none"
        >
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={filterAdapter}
          onChange={e => setFilterAdapter(e.target.value)}
          className="bg-surface border border-border px-2 py-1.5 text-[11px] text-foreground focus:border-accent/50 focus:outline-none"
        >
          <option value="">All Adapters</option>
          {adapterTypes.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select
          value={filterCompleteness}
          onChange={e => setFilterCompleteness(e.target.value as any)}
          className="bg-surface border border-border px-2 py-1.5 text-[11px] text-foreground focus:border-accent/50 focus:outline-none"
        >
          <option value="all">All Completeness</option>
          <option value="complete">Complete (70%+)</option>
          <option value="partial">Partial (1-69%)</option>
          <option value="empty">Empty (0%)</option>
        </select>
        <span className="text-[10px] text-foreground-dim ml-auto">
          {filtered.length} of {sites.length} sites
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="border border-red-400/40 bg-red-400/[0.04] px-4 py-3 mb-6 text-[11px] text-red-400">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-center py-12 text-foreground-dim text-sm">Loading site profiles...</div>
      )}

      {/* Table */}
      {!loading && (
        <div className="border border-border overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[9px] font-heading tracking-widest uppercase text-foreground-muted border-b border-border bg-surface/50">
                <SortHeader field="domain" label="Domain" className="pl-4" />
                <SortHeader field="category" label="Cat" />
                <SortHeader field="adapter" label="Adapter" />
                <SortHeader field="platform" label="Platform" />
                <SortHeader field="phase" label="Phase" />
                <SortHeader field="waf" label="WAF" />
                <th className="pb-2 pr-3">WAF Type</th>
                <th className="pb-2 pr-3">perPage</th>
                <th className="pb-2 pr-3">chunkSize</th>
                <th className="pb-2 pr-3">timeout</th>
                <th className="pb-2 pr-3">sortParam</th>
                <th className="pb-2 pr-3">searchUrl</th>
                <SortHeader field="completeness" label="Profile %" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((site) => {
                const p = site.profile;
                const isExpanded = expandedId === site.id;
                const comp = site.completeness;

                return (
                  <React.Fragment key={site.id}>
                    <tr
                      className={`border-b border-border/30 hover:bg-white/[0.02] cursor-pointer transition-colors ${
                        !site.isEnabled ? 'opacity-40' : ''
                      } ${isExpanded ? 'bg-white/[0.03]' : ''}`}
                      onClick={() => setExpandedId(isExpanded ? null : site.id)}
                    >
                      <td className="pl-4 pr-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-foreground font-heading">{site.domain}</span>
                          {!site.isEnabled && (
                            <span className="text-[8px] uppercase tracking-wider text-foreground-dim border border-foreground-dim/30 px-1">off</span>
                          )}
                        </div>
                        <div className="text-[9px] text-foreground-dim">{site.name}</div>
                      </td>
                      <td className="pr-3 py-2">
                        <span className={`text-[9px] uppercase tracking-wider border px-1 py-0.5 ${categoryStyle(site.siteCategory)}`}>
                          {categoryAbbr(site.siteCategory)}
                        </span>
                      </td>
                      <td className="pr-3 py-2 text-foreground-muted">{site.adapterType}</td>
                      <td className="pr-3 py-2 text-foreground-muted">{p?.platform ?? '\u2014'}</td>
                      <td className="pr-3 py-2">
                        <span className={phaseColor(site.crawlPhase)}>{site.crawlPhase}</span>
                      </td>
                      <td className="pr-3 py-2">
                        {site.hasWaf ? (
                          <span className="text-orange-400 font-heading">WAF</span>
                        ) : (
                          <span className="text-foreground-dim">\u2014</span>
                        )}
                      </td>
                      <td className="pr-3 py-2 text-foreground-muted">{p?.wafType ?? '\u2014'}</td>
                      <td className="pr-3 py-2 text-foreground-muted font-heading">{p?.perPage ?? '\u2014'}</td>
                      <td className="pr-3 py-2 text-foreground-muted font-heading">{p?.chunkSize ?? p?.enrichmentChunkSize ?? '\u2014'}</td>
                      <td className="pr-3 py-2 text-foreground-muted font-heading">{p?.timeout ? `${p.timeout}ms` : '\u2014'}</td>
                      <td className="pr-3 py-2 text-foreground-muted">{p?.sortParam ? truncate(p.sortParam, 20) : '\u2014'}</td>
                      <td className="pr-3 py-2 text-foreground-muted">{p?.searchUrl ? truncate(p.searchUrl, 25) : '\u2014'}</td>
                      <td className="pr-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="w-12 h-1.5 bg-border overflow-hidden">
                            <div
                              className={`h-full ${completenessBarColor(comp.pct)}`}
                              style={{ width: `${comp.pct}%` }}
                            />
                          </div>
                          <span className={`font-heading text-[10px] ${completenessColor(comp.pct)}`}>
                            {comp.filled}/{comp.total}
                          </span>
                        </div>
                      </td>
                    </tr>

                    {/* Expanded detail row */}
                    {isExpanded && (
                      <tr className="border-b border-border/30">
                        <td colSpan={13} className="px-4 py-4 bg-surface/30">
                          <ProfileDetailPanel profile={p} site={site} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {filtered.length === 0 && !loading && (
                <tr>
                  <td colSpan={13} className="text-center py-8 text-foreground-dim">
                    No sites match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Category styling ───────────────────────────────────────────────────────────

function categoryAbbr(cat: string): string {
  const map: Record<string, string> = { retailer: 'RET', forum: 'FRM', classified: 'CLS', auction: 'AUC' };
  return map[cat] ?? cat.slice(0, 3).toUpperCase();
}

function categoryStyle(cat: string): string {
  const map: Record<string, string> = {
    retailer: 'text-blue-400 border-blue-400/30',
    forum: 'text-purple-400 border-purple-400/30',
    classified: 'text-green-400 border-green-400/30',
    auction: 'text-orange-400 border-orange-400/30',
  };
  return map[cat] ?? 'text-foreground-dim border-border';
}

function phaseColor(phase: string): string {
  if (phase === 'maintain') return 'text-green-400';
  if (phase === 'bootstrap') return 'text-yellow-400';
  return 'text-foreground-dim';
}

// ── Expanded Profile Detail Panel ──────────────────────────────────────────────

function ProfileDetailPanel({ profile, site }: { profile: SiteProfile | null; site: SiteWithProfile }) {
  if (!profile) {
    return (
      <div className="text-foreground-dim text-[11px] py-4">
        <p className="font-heading text-foreground-muted mb-2">No site profile configured.</p>
        <p>This site has no siteProfile JSON in the database. Adapter-level defaults will be used.</p>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-4 text-[10px]">
          <div>
            <span className="text-foreground-dim">DB Adapter:</span>{' '}
            <span className="text-foreground font-heading">{site.adapterType}</span>
          </div>
          <div>
            <span className="text-foreground-dim">Site Type:</span>{' '}
            <span className="text-foreground font-heading">{site.siteType}</span>
          </div>
          <div>
            <span className="text-foreground-dim">Has WAF:</span>{' '}
            <span className={site.hasWaf ? 'text-orange-400 font-heading' : 'text-foreground'}>{String(site.hasWaf)}</span>
          </div>
          <div>
            <span className="text-foreground-dim">Requires Sucuri:</span>{' '}
            <span className={site.requiresSucuri ? 'text-orange-400 font-heading' : 'text-foreground'}>{String(site.requiresSucuri)}</span>
          </div>
        </div>
      </div>
    );
  }

  // Group profile fields into sections
  const sections: Array<{ title: string; fields: Array<{ key: string; value: any }> }> = [];

  // Basic config
  const basicFields: Array<{ key: string; value: any }> = [];
  for (const key of ['platform', 'adapter', 'phase', 'hasWaf', 'wafType', 'perPage', 'chunkSize', 'enrichmentChunkSize', 'timeout', 'sortParam', 'searchUrl']) {
    if (profile[key] !== undefined && profile[key] !== null) {
      basicFields.push({ key, value: profile[key] });
    }
  }
  if (basicFields.length > 0) sections.push({ title: 'Configuration', fields: basicFields });

  // Catalog URLs
  if (profile.catalogUrls && profile.catalogUrls.length > 0) {
    sections.push({
      title: `Catalog URLs (${profile.catalogUrls.length})`,
      fields: profile.catalogUrls.map((url, i) => ({ key: `[${i}]`, value: url })),
    });
  }

  // Complex JSON sections
  for (const key of ['dataFlow', 'crawlers', 'apiConfig']) {
    if (profile[key] && typeof profile[key] === 'object' && Object.keys(profile[key]).length > 0) {
      sections.push({
        title: key,
        fields: [{ key: '', value: profile[key] }],
      });
    }
  }

  // Notes
  if (profile.notes) {
    sections.push({
      title: 'Notes',
      fields: [{ key: '', value: profile.notes }],
    });
  }

  // Any remaining unknown fields
  const knownKeys = new Set([
    'platform', 'adapter', 'phase', 'hasWaf', 'wafType', 'perPage', 'chunkSize',
    'enrichmentChunkSize', 'timeout', 'sortParam', 'searchUrl', 'catalogUrls',
    'dataFlow', 'crawlers', 'apiConfig', 'notes',
  ]);
  const extraFields: Array<{ key: string; value: any }> = [];
  for (const [key, val] of Object.entries(profile)) {
    if (!knownKeys.has(key) && val !== undefined && val !== null) {
      extraFields.push({ key, value: val });
    }
  }
  if (extraFields.length > 0) sections.push({ title: 'Other Fields', fields: extraFields });

  return (
    <div className="space-y-4">
      {/* DB-level flags (always show) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px] pb-3 border-b border-border/30">
        <div>
          <span className="text-foreground-dim">DB Adapter:</span>{' '}
          <span className="text-foreground font-heading">{site.adapterType}</span>
        </div>
        <div>
          <span className="text-foreground-dim">Site Type:</span>{' '}
          <span className="text-foreground font-heading">{site.siteType}</span>
        </div>
        <div>
          <span className="text-foreground-dim">Category:</span>{' '}
          <span className="text-foreground font-heading">{site.siteCategory}</span>
        </div>
        <div>
          <span className="text-foreground-dim">Crawl Phase:</span>{' '}
          <span className={`font-heading ${phaseColor(site.crawlPhase)}`}>{site.crawlPhase}</span>
        </div>
      </div>

      {/* Profile sections */}
      {sections.map((section) => (
        <div key={section.title}>
          <p className="text-[9px] font-heading tracking-widest uppercase text-foreground-muted mb-2">
            {section.title}
          </p>
          {section.fields.length === 1 && section.fields[0].key === '' ? (
            // Full JSON block (dataFlow, crawlers, apiConfig, notes)
            typeof section.fields[0].value === 'string' ? (
              <p className="text-[11px] text-foreground whitespace-pre-wrap">{section.fields[0].value}</p>
            ) : (
              <pre className="text-[10px] text-foreground bg-surface border border-border/30 p-3 overflow-x-auto max-h-64 overflow-y-auto">
                {JSON.stringify(section.fields[0].value, null, 2)}
              </pre>
            )
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-1">
              {section.fields.map(({ key, value }) => (
                <div key={key} className="text-[10px] flex gap-1.5 py-0.5">
                  <span className="text-foreground-dim flex-shrink-0">{key}:</span>
                  <span className="text-foreground font-heading break-all">
                    {typeof value === 'boolean' ? String(value) :
                     typeof value === 'object' ? JSON.stringify(value) :
                     String(value)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Full raw JSON toggle */}
      <RawJsonToggle profile={profile} />
    </div>
  );
}

// ── Raw JSON expandable section ────────────────────────────────────────────────

function RawJsonToggle({ profile }: { profile: SiteProfile }) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="pt-2 border-t border-border/30">
      <button
        onClick={(e) => { e.stopPropagation(); setShowRaw(!showRaw); }}
        className="text-[9px] font-heading uppercase tracking-wider text-foreground-dim hover:text-foreground transition-colors"
      >
        {showRaw ? '\u25b2 Hide' : '\u25bc Show'} Raw JSON
      </button>
      {showRaw && (
        <pre className="mt-2 text-[10px] text-foreground bg-surface border border-border/30 p-3 overflow-x-auto max-h-96 overflow-y-auto">
          {JSON.stringify(profile, null, 2)}
        </pre>
      )}
    </div>
  );
}
