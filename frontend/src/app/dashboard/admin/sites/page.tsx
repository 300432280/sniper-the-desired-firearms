'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';

interface TierCycleState {
  status: 'idle' | 'in_progress' | 'cooldown';
  cycleStartedAt?: string;
  snapshotStart?: string;
  snapshotEnd?: string;
  pagesScanned?: number;
  lastCompletedAt?: string;
}

interface TierState {
  tier2?: TierCycleState;
  tier3?: TierCycleState;
  tier4?: TierCycleState;
}

interface SiteDashboard {
  id: string;
  domain: string;
  name: string;
  url: string;
  isEnabled: boolean;
  isPaused: boolean;
  adapterType: string;
  siteType: string;
  siteCategory: string;

  // v2 pressure/capacity model
  pressure: number | null;
  capacity: number | null;
  baseBudget: number | null;
  effectiveBudget: number | null;
  minGapSeconds: number | null;
  v2IntervalMin: number | null;

  // Crawl metrics
  crawlIntervalMin: number;
  nextCrawlAt: string | null;
  lastCrawlAt: string | null;
  crawlLock: string | null;
  consecutiveFailures: number;
  avgResponseTimeMs: number | null;

  // v2 catalog fields
  lastWatermarkUrl: string | null;
  tierState: TierState | string;
  addedAt: string;
  coldStartOverride: boolean;
  productCount: number;

  // Difficulty signals
  hasWaf: boolean;
  hasRateLimit: boolean;
  hasCaptcha: boolean;
  requiresSucuri: boolean;

  // Per-site crawl tuning
  crawlTuning: Record<string, number | null> | null;

  // Computed
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

const STATUS_COLORS: Record<string, string> = {
  success: 'text-green-400',
  fail: 'text-red-400',
  timeout: 'text-yellow-400',
  blocked: 'text-orange-400',
  captcha: 'text-red-500',
};

const CATEGORY_LABELS: Record<string, string> = {
  retailer: 'RET',
  forum: 'FRM',
  classified: 'CLS',
  auction: 'AUC',
};

const CATEGORY_COLORS: Record<string, string> = {
  retailer: 'text-blue-400 border-blue-400/30',
  forum: 'text-purple-400 border-purple-400/30',
  classified: 'text-green-400 border-green-400/30',
  auction: 'text-orange-400 border-orange-400/30',
};

function capacityColor(cap: number): string {
  if (cap >= 0.7) return 'text-green-400';
  if (cap >= 0.4) return 'text-yellow-400';
  if (cap >= 0.15) return 'text-orange-400';
  return 'text-red-400';
}

function capacityBarColor(cap: number): string {
  if (cap >= 0.7) return 'bg-green-500';
  if (cap >= 0.4) return 'bg-yellow-500';
  if (cap >= 0.15) return 'bg-orange-500';
  return 'bg-red-500';
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

function getColdStartPhase(addedAt: string, coldStartOverride: boolean): { phase: string; label: string; color: string } {
  if (coldStartOverride) return { phase: 'steady', label: 'Steady (override)', color: 'text-green-400' };
  const hoursElapsed = (Date.now() - new Date(addedAt).getTime()) / (1000 * 60 * 60);
  if (hoursElapsed < 6) return { phase: 'probe', label: `Probe (${Math.round(hoursElapsed)}h/6h)`, color: 'text-orange-400' };
  if (hoursElapsed < 48) return { phase: 'ramp', label: `Ramp (${Math.round(hoursElapsed)}h/48h)`, color: 'text-yellow-400' };
  return { phase: 'steady', label: 'Steady', color: 'text-green-400' };
}

function parseTierState(ts: TierState | string): TierState {
  if (typeof ts === 'string') {
    try { return JSON.parse(ts); } catch { return {}; }
  }
  return ts || {};
}

function tierStatusBadge(state?: TierCycleState): { label: string; color: string } {
  if (!state || state.status === 'idle') return { label: 'idle', color: 'text-foreground-dim' };
  if (state.status === 'in_progress') return { label: `running (${state.pagesScanned ?? 0}p)`, color: 'text-blue-400' };
  if (state.status === 'cooldown') return { label: 'cooldown', color: 'text-yellow-400' };
  return { label: 'idle', color: 'text-foreground-dim' };
}

// ── Crawl Tuning Constants (client-side mirror of backend defaults) ──────────

const TUNING_DEFAULTS: Record<string, number | null> = {
  baseBudget: 60,
  tier1IntervalMin: null,
  tier1ReservePct: 70,
  t2CooldownHrs: 5,
  t3CooldownHrs: 9,
  t4CooldownHrs: 17,
  t2SharePct: 35,
  t3SharePct: 35,
  t4SharePct: 30,
};

const BASE_RATES: Record<string, number> = {
  forum: 4,
  classified: 4,
  retailer: 2,
  auction: 0.17,
};

// ── CrawlTuningPanel ────────────────────────────────────────────────────────

function CrawlTuningPanel({
  site,
  onSaved,
}: {
  site: SiteDashboard;
  onSaved: () => void;
}) {
  const resolved = useMemo(() => {
    const r = { ...TUNING_DEFAULTS };
    if (site.crawlTuning && typeof site.crawlTuning === 'object') {
      for (const key of Object.keys(TUNING_DEFAULTS)) {
        if (key in site.crawlTuning && site.crawlTuning[key] != null) {
          r[key] = site.crawlTuning[key];
        }
      }
    }
    return r;
  }, [site.crawlTuning]);

  const [draft, setDraft] = useState<Record<string, number | null>>({ ...resolved });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'ok' | 'err' } | null>(null);

  // Reset draft when site.crawlTuning changes externally
  useEffect(() => {
    const r = { ...TUNING_DEFAULTS };
    if (site.crawlTuning && typeof site.crawlTuning === 'object') {
      for (const key of Object.keys(TUNING_DEFAULTS)) {
        if (key in site.crawlTuning && site.crawlTuning[key] != null) {
          r[key] = site.crawlTuning[key];
        }
      }
    }
    setDraft({ ...r });
  }, [site.crawlTuning]);

  const setField = (key: string, val: string) => {
    if (val === '' || val === '-') {
      setDraft(d => ({ ...d, [key]: null }));
    } else {
      const n = parseFloat(val);
      if (!isNaN(n)) setDraft(d => ({ ...d, [key]: n }));
    }
    setMessage(null);
  };

  const isOverridden = (key: string) => draft[key] !== TUNING_DEFAULTS[key];
  const hasChanges = Object.keys(TUNING_DEFAULTS).some(k => draft[k] !== resolved[k]);

  // ── Live formula preview ──────────────────────────────────────────────────

  const preview = useMemo(() => {
    const baseBudget = draft.baseBudget ?? 60;
    const capacity = site.capacity ?? 1;
    const tier1ReservePct = draft.tier1ReservePct ?? 70;
    const t2SharePct = draft.t2SharePct ?? 35;
    const t3SharePct = draft.t3SharePct ?? 35;
    const t4SharePct = draft.t4SharePct ?? 30;

    const effectiveBudget = Math.max(5, Math.floor(baseBudget * capacity));
    const minGap = Math.round(3600 / effectiveBudget);

    // Token allocation
    const tier1Tokens = Math.floor(effectiveBudget * tier1ReservePct / 100);
    const catalogPool = effectiveBudget - tier1Tokens;
    const t3Tokens = Math.floor(catalogPool * t3SharePct / 100);
    const t4Tokens = Math.floor(catalogPool * t4SharePct / 100);
    const t2Base = Math.floor(catalogPool * t2SharePct / 100);
    const t2Tokens = Math.max(t2Base, catalogPool - t3Tokens - t4Tokens);

    // Tier 1 interval
    const baseRate = BASE_RATES[site.siteCategory] ?? 2;
    const tier1IntervalMin = draft.tier1IntervalMin;
    let intervalPeak: number;
    let intervalOff: number;
    let intervalFormula: string;

    if (tier1IntervalMin != null) {
      intervalPeak = tier1IntervalMin;
      intervalOff = tier1IntervalMin;
      intervalFormula = `override: ${tier1IntervalMin}m (fixed)`;
    } else {
      const rawInterval = baseRate * capacity > 0 ? 60 / (baseRate * capacity) : 1440;
      intervalPeak = Math.max(15, Math.min(1440, Math.round(rawInterval * 0.85)));
      intervalOff = Math.max(15, Math.min(1440, Math.round(rawInterval * 1.2)));
      intervalFormula = `60 / (${baseRate} x ${(capacity * 100).toFixed(1)}%) = ${Math.round(rawInterval)}m`;
    }

    return {
      baseBudget,
      capacity,
      effectiveBudget,
      minGap,
      tier1Tokens,
      catalogPool,
      t2Tokens,
      t3Tokens,
      t4Tokens,
      baseRate,
      intervalPeak,
      intervalOff,
      intervalFormula,
      tier1IntervalMin,
    };
  }, [draft, site.capacity, site.siteCategory]);

  // ── Save / Reset ──────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      // Only send fields that differ from defaults
      const patch: Record<string, number | null> = {};
      for (const key of Object.keys(TUNING_DEFAULTS)) {
        if (draft[key] !== TUNING_DEFAULTS[key]) {
          patch[key] = draft[key];
        }
      }

      const res = await fetch(`/api/admin/sites/${site.id}/tuning`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setMessage({ text: 'Saved', type: 'ok' });
      onSaved();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Save failed', type: 'err' });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/sites/${site.id}/tuning`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      setDraft({ ...TUNING_DEFAULTS });
      setMessage({ text: 'Reset to defaults', type: 'ok' });
      onSaved();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Reset failed', type: 'err' });
    } finally {
      setSaving(false);
    }
  };

  // ── Input helper ──────────────────────────────────────────────────────────

  const TuningInput = ({ label, field, unit, placeholder }: { label: string; field: string; unit: string; placeholder?: string }) => (
    <div className="flex items-center gap-2 py-0.5">
      <span className={`text-[10px] w-24 flex-shrink-0 ${isOverridden(field) ? 'text-orange-400' : 'text-foreground-muted'}`}>
        {label}
      </span>
      <input
        type="number"
        value={draft[field] ?? ''}
        onChange={e => setField(field, e.target.value)}
        placeholder={placeholder ?? String(TUNING_DEFAULTS[field] ?? 'auto')}
        className="w-16 bg-surface border border-border px-1.5 py-0.5 text-[10px] text-foreground font-heading text-right focus:border-accent/50 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-[9px] text-foreground-dim w-10">{unit}</span>
    </div>
  );

  // ── Preview value with change indicator ─────────────────────────────────

  const PreviewVal = ({ label, value, suffix }: { label: string; value: string | number; suffix?: string }) => (
    <div className="flex justify-between py-0.5">
      <span className="text-foreground-dim">{label}</span>
      <span className="text-foreground font-heading">{value}{suffix || ''}</span>
    </div>
  );

  return (
    <div className="mt-4 border border-border/50 bg-surface/50">
      <div className="px-4 py-2 border-b border-border/30 flex items-center justify-between">
        <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted">
          Crawl Tuning
        </p>
        <div className="flex items-center gap-2">
          {message && (
            <span className={`text-[9px] ${message.type === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
              {message.text}
            </span>
          )}
          <button
            onClick={handleReset}
            disabled={saving}
            className="text-[9px] font-heading uppercase tracking-wider px-2.5 py-0.5 border border-foreground-dim/30 text-foreground-dim hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50"
          >
            Reset to Default
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className="text-[9px] font-heading uppercase tracking-wider px-2.5 py-0.5 border border-accent/30 text-accent hover:bg-accent/10 transition-colors disabled:opacity-30"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-4 py-3">
        {/* Left: Inputs */}
        <div className="space-y-3">
          <div>
            <p className="text-[9px] font-heading tracking-widest uppercase text-foreground-dim/70 mb-1">Token Budget</p>
            <TuningInput label="Base Budget" field="baseBudget" unit="req/hr" />
            <TuningInput label="T1 Reserve" field="tier1ReservePct" unit="%" />
            <TuningInput label="T2 Share" field="t2SharePct" unit="%" />
            <TuningInput label="T3 Share" field="t3SharePct" unit="%" />
            <TuningInput label="T4 Share" field="t4SharePct" unit="%" />
          </div>
          <div>
            <p className="text-[9px] font-heading tracking-widest uppercase text-foreground-dim/70 mb-1">Intervals / Cooldowns</p>
            <TuningInput label="T1 Interval" field="tier1IntervalMin" unit="min" placeholder="auto" />
            <TuningInput label="T2 Cooldown" field="t2CooldownHrs" unit="hrs" />
            <TuningInput label="T3 Cooldown" field="t3CooldownHrs" unit="hrs" />
            <TuningInput label="T4 Cooldown" field="t4CooldownHrs" unit="hrs" />
          </div>
        </div>

        {/* Right: Live Formula Preview */}
        <div className="text-[10px] space-y-3 border-l border-border/30 pl-4">
          <div>
            <p className="text-[9px] font-heading tracking-widest uppercase text-foreground-dim/70 mb-1">Effective Budget</p>
            <PreviewVal label={`floor(${preview.baseBudget} x ${(preview.capacity * 100).toFixed(1)}%)`} value={`= ${preview.effectiveBudget}`} suffix=" req/hr" />
            <PreviewVal label="Min gap" value={`${preview.minGap}s`} suffix={` (${Math.round(3600 / preview.minGap * 10) / 10} req/hr)`} />
          </div>
          <div>
            <p className="text-[9px] font-heading tracking-widest uppercase text-foreground-dim/70 mb-1">Token Allocation</p>
            <PreviewVal label={`Tier 1 (${draft.tier1ReservePct ?? 70}%)`} value={preview.tier1Tokens} suffix=" tokens" />
            <PreviewVal label="Catalog pool" value={preview.catalogPool} suffix=" tokens" />
            <PreviewVal label={`Tier 2 (${draft.t2SharePct ?? 35}%)`} value={preview.t2Tokens} suffix=" tokens" />
            <PreviewVal label={`Tier 3 (${draft.t3SharePct ?? 35}%)`} value={preview.t3Tokens} suffix=" tokens" />
            <PreviewVal label={`Tier 4 (${draft.t4SharePct ?? 30}%)`} value={preview.t4Tokens} suffix=" tokens" />
          </div>
          <div>
            <p className="text-[9px] font-heading tracking-widest uppercase text-foreground-dim/70 mb-1">Tier 1 Interval</p>
            <div className="text-foreground-dim">
              {preview.tier1IntervalMin != null ? (
                <span>Override: <span className="text-orange-400 font-heading">{preview.tier1IntervalMin}m</span> (fixed)</span>
              ) : (
                <>
                  <div className="flex justify-between py-0.5">
                    <span>baseRate = {preview.baseRate}/hr ({site.siteCategory})</span>
                    <span className="font-heading text-foreground">{preview.intervalFormula}</span>
                  </div>
                  <div className="flex justify-between py-0.5">
                    <span>x 0.85 peak</span>
                    <span className="font-heading text-foreground">{preview.intervalPeak}m</span>
                  </div>
                  <div className="flex justify-between py-0.5">
                    <span>x 1.20 off-peak</span>
                    <span className="font-heading text-foreground">{preview.intervalOff}m</span>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="flex gap-4 pt-1 border-t border-border/20">
            <span className="text-foreground-dim">pressure: <span className="text-orange-400 font-heading">{((site.pressure ?? 0) * 100).toFixed(1)}%</span></span>
            <span className="text-foreground-dim">capacity: <span className={`font-heading ${capacityColor(site.capacity ?? 1)}`}>{((site.capacity ?? 1) * 100).toFixed(1)}%</span></span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SiteIssue {
  id: string;
  domain: string;
  severity: 'critical' | 'warning' | 'info';
  issueType: string;
  issue: string;
  detail: string;
  suggestion: string;
  issueKey: string;
  isDismissed: boolean;
}

interface SiteIssuesResponse {
  totalIssues: number;
  totalDismissed: number;
  critical: number;
  warning: number;
  info: number;
  issues: SiteIssue[];
}

type SortField = 'domain' | 'capacity' | 'interval' | 'nextCrawl' | 'failures' | 'budget' | 'searches' | 'products' | 'category';
type ExpandedRow = string | null;

export default function SiteMonitorPage() {
  const [sites, setSites] = useState<SiteDashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortField, setSortField] = useState<SortField>('domain');
  const [sortAsc, setSortAsc] = useState(true);
  const [filterAdapter, setFilterAdapter] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterEnabled, setFilterEnabled] = useState<'all' | 'enabled' | 'paused' | 'disabled'>('all');
  const [expanded, setExpanded] = useState<ExpandedRow>(null);
  const [headerInfo, setHeaderInfo] = useState<'capacity' | 'interval' | 'budget' | null>(null);
  const [selectedSites, setSelectedSites] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  const [siteIssues, setSiteIssues] = useState<SiteIssuesResponse | null>(null);
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [dismissLoading, setDismissLoading] = useState<string | null>(null);
  const [issueFilter, setIssueFilter] = useState<'all' | 'critical' | 'warning' | 'info'>('all');

  const fetchSiteIssues = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/site-issues?showDismissed=${showDismissed}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setSiteIssues(data);
    } catch {}
  }, [showDismissed]);

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

  useEffect(() => { fetchSites(); fetchSiteIssues(); }, [fetchSites, fetchSiteIssues]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => { fetchSites(); fetchSiteIssues(); }, 60000);
    return () => clearInterval(interval);
  }, [fetchSites, fetchSiteIssues]);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortAsc(!sortAsc);
    else { setSortField(field); setSortAsc(true); }
  };

  // Get unique adapter types and categories for filters
  const adapterTypes = [...new Set(sites.map(s => s.adapterType))].sort();
  const categories = [...new Set(sites.map(s => s.siteCategory))].sort();

  // Filter and sort
  const filteredSites = sites
    .filter(s => !filterAdapter || s.adapterType === filterAdapter)
    .filter(s => !filterCategory || s.siteCategory === filterCategory)
    .filter(s => {
      if (filterEnabled === 'all') return true;
      if (filterEnabled === 'paused') return s.isPaused;
      if (filterEnabled === 'disabled') return !s.isEnabled;
      return s.isEnabled && !s.isPaused; // 'enabled' = on and not paused
    })
    .sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      switch (sortField) {
        case 'domain': return dir * a.domain.localeCompare(b.domain);
        case 'capacity': return dir * ((a.capacity ?? 1) - (b.capacity ?? 1));
        case 'interval': return dir * ((a.v2IntervalMin ?? a.crawlIntervalMin) - (b.v2IntervalMin ?? b.crawlIntervalMin));
        case 'nextCrawl': return dir * ((a.nextCrawlAt || '').localeCompare(b.nextCrawlAt || ''));
        case 'failures': return dir * (a.consecutiveFailures - b.consecutiveFailures);
        case 'budget': return dir * ((a.effectiveBudget ?? 60) - (b.effectiveBudget ?? 60));
        case 'searches': return dir * (a.activeSearches - b.activeSearches);
        case 'products': return dir * (a.productCount - b.productCount);
        case 'category': return dir * a.siteCategory.localeCompare(b.siteCategory);
        default: return 0;
      }
    });

  // Summary stats
  const enabledCount = sites.filter(s => s.isEnabled && !s.isPaused).length;
  const pausedCount = sites.filter(s => s.isPaused).length;
  const failingCount = sites.filter(s => s.consecutiveFailures >= 3).length;
  const lockedCount = sites.filter(s => s.crawlLock).length;
  const totalProducts = sites.reduce((s, site) => s + site.productCount, 0);
  const avgCapacity = sites.length > 0
    ? (sites.filter(s => s.isEnabled).reduce((s, site) => s + (site.capacity ?? 1), 0) / enabledCount)
    : 0;

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

  const handleBatchToggle = async (enable: boolean) => {
    if (selectedSites.size === 0) return;
    setBatchLoading(true);
    try {
      await fetch('/api/admin/sites/batch', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteIds: [...selectedSites], isEnabled: enable }),
      });
      setSelectedSites(new Set());
      fetchSites();
    } catch {} finally {
      setBatchLoading(false);
    }
  };

  const handlePause = async (id: string, currentPaused: boolean) => {
    try {
      await fetch(`/api/admin/sites/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPaused: !currentPaused }),
      });
      fetchSites();
    } catch {}
  };

  const handleBatchPause = async (paused: boolean) => {
    if (selectedSites.size === 0) return;
    setBatchLoading(true);
    try {
      await fetch('/api/admin/sites/batch', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteIds: [...selectedSites], isPaused: paused }),
      });
      setSelectedSites(new Set());
      fetchSites();
    } catch {} finally {
      setBatchLoading(false);
    }
  };

  const handleDismissIssue = async (issue: SiteIssue) => {
    setDismissLoading(issue.issueKey);
    try {
      if (issue.isDismissed) {
        // Restore
        await fetch('/api/admin/site-issues/dismiss', {
          method: 'DELETE',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: issue.id, issueType: issue.issueType }),
        });
      } else {
        // Dismiss
        await fetch('/api/admin/site-issues/dismiss', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: issue.id, issueType: issue.issueType, conditionSnapshot: issue.detail }),
        });
      }
      fetchSiteIssues();
    } catch {} finally {
      setDismissLoading(null);
    }
  };

  const handleSetWaf = async (siteId: string, hasWaf: boolean) => {
    try {
      await fetch(`/api/admin/sites/${siteId}/set-waf`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hasWaf }),
      });
      fetchSites();
      fetchSiteIssues();
    } catch {}
  };

  const toggleSelectSite = (id: string) => {
    setSelectedSites(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedSites.size === filteredSites.length) {
      setSelectedSites(new Set());
    } else {
      setSelectedSites(new Set(filteredSites.map(s => s.id)));
    }
  };

  return (
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-10">
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
          <p className="text-[10px] text-foreground-dim mt-1">v2 Pressure/Capacity Model + Catalog Tiers</p>
        </div>
        <button
          onClick={() => { setLoading(true); fetchSites(); }}
          className="text-[11px] font-heading uppercase tracking-wider px-4 py-2 border border-border text-foreground-muted hover:border-accent/30 hover:text-accent transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-7 gap-px border border-border bg-border mb-6">
        {[
          { label: 'Total Sites', value: sites.length },
          { label: 'Enabled', value: enabledCount },
          { label: 'Paused', value: pausedCount, warn: pausedCount > 0 },
          { label: 'Failing (3+)', value: failingCount, danger: failingCount > 0 },
          { label: 'Crawling Now', value: lockedCount },
          { label: 'Products Indexed', value: totalProducts },
          { label: 'Avg Capacity', value: loading ? '\u2014' : `${(avgCapacity * 100).toFixed(0)}%`, isCapacity: true },
        ].map((stat) => (
          <div key={stat.label} className="bg-surface px-4 py-3">
            <div className={`font-heading text-xl font-bold ${
              stat.danger ? 'text-red-400' :
              (stat as any).warn ? 'text-yellow-400' :
              (stat as any).isCapacity ? capacityColor(avgCapacity) :
              'text-foreground'
            }`}>
              {loading && !('isCapacity' in stat) ? '\u2014' : stat.value}
            </div>
            <div className="text-[9px] font-heading tracking-widest uppercase text-foreground-muted mt-0.5">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Site Issues Alert Panel */}
      {siteIssues && (siteIssues.totalIssues > 0 || siteIssues.totalDismissed > 0) && (
        <div className={`border mb-6 ${
          siteIssues.critical > 0 ? 'border-red-400/40 bg-red-400/[0.04]' :
          siteIssues.warning > 0 ? 'border-yellow-400/40 bg-yellow-400/[0.04]' :
          'border-blue-400/40 bg-blue-400/[0.04]'
        }`}>
          <button
            onClick={() => setIssuesExpanded(!issuesExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className={`text-sm font-heading ${
                siteIssues.critical > 0 ? 'text-red-400' : siteIssues.warning > 0 ? 'text-yellow-400' : 'text-blue-400'
              }`}>
                {siteIssues.critical > 0 ? '\u26a0' : '\u24d8'}
              </span>
              <span className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted">
                Site Issues
              </span>
              <div className="flex items-center gap-2">
                {siteIssues.critical > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setIssueFilter(issueFilter === 'critical' ? 'all' : 'critical'); if (!issuesExpanded) setIssuesExpanded(true); }}
                    className={`text-[9px] font-heading uppercase tracking-wider px-1.5 py-0.5 border transition-colors ${
                      issueFilter === 'critical' ? 'border-red-400 text-red-400 bg-red-400/20' : 'border-red-400/30 text-red-400 bg-red-400/10 hover:bg-red-400/20'
                    }`}
                  >
                    {siteIssues.critical} critical
                  </button>
                )}
                {siteIssues.warning > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setIssueFilter(issueFilter === 'warning' ? 'all' : 'warning'); if (!issuesExpanded) setIssuesExpanded(true); }}
                    className={`text-[9px] font-heading uppercase tracking-wider px-1.5 py-0.5 border transition-colors ${
                      issueFilter === 'warning' ? 'border-yellow-400 text-yellow-400 bg-yellow-400/20' : 'border-yellow-400/30 text-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/20'
                    }`}
                  >
                    {siteIssues.warning} warning
                  </button>
                )}
                {siteIssues.info > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setIssueFilter(issueFilter === 'info' ? 'all' : 'info'); if (!issuesExpanded) setIssuesExpanded(true); }}
                    className={`text-[9px] font-heading uppercase tracking-wider px-1.5 py-0.5 border transition-colors ${
                      issueFilter === 'info' ? 'border-blue-400 text-blue-400 bg-blue-400/20' : 'border-blue-400/30 text-blue-400 bg-blue-400/10 hover:bg-blue-400/20'
                    }`}
                  >
                    {siteIssues.info} info
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {siteIssues.totalDismissed > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setShowDismissed(!showDismissed); }}
                  className={`text-[9px] font-heading uppercase tracking-wider px-1.5 py-0.5 border transition-colors ${
                    showDismissed ? 'border-foreground-muted/50 text-foreground-muted bg-foreground-muted/10' : 'border-border text-foreground-dim hover:text-foreground-muted'
                  }`}
                >
                  {showDismissed ? 'Hide' : 'Show'} {siteIssues.totalDismissed} dismissed
                </button>
              )}
              <span className="text-foreground-dim text-xs">{issuesExpanded ? '\u25b2' : '\u25bc'}</span>
            </div>
          </button>

          {issuesExpanded && (() => {
            const filteredIssues = siteIssues.issues.filter(issue =>
              issueFilter === 'all' || issue.severity === issueFilter
            );
            return (
            <div className="border-t border-border/30 px-4 py-3">
              {filteredIssues.length === 0 ? (
                <p className="text-[11px] text-foreground-dim py-2">No {issueFilter !== 'all' ? issueFilter : ''} issues to show.</p>
              ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-[9px] font-heading tracking-widest uppercase text-foreground-muted">
                    <th className="pb-2 pr-3 w-16">Severity</th>
                    <th className="pb-2 pr-3 w-36">Site</th>
                    <th className="pb-2 pr-3 w-36">Issue</th>
                    <th className="pb-2 pr-3">Detail</th>
                    <th className="pb-2 pr-3">Suggestion</th>
                    <th className="pb-2 w-24 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIssues.map((issue, i) => (
                    <tr
                      key={issue.issueKey || `${issue.id}-${issue.issueType}-${i}`}
                      className={`border-t border-border/20 ${issue.isDismissed ? 'opacity-40' : ''}`}
                    >
                      <td className="py-1.5 pr-3">
                        <span className={`text-[8px] font-heading uppercase tracking-wider px-1.5 py-0.5 border ${
                          issue.severity === 'critical' ? 'border-red-400/30 text-red-400 bg-red-400/10' :
                          issue.severity === 'warning' ? 'border-yellow-400/30 text-yellow-400 bg-yellow-400/10' :
                          'border-blue-400/30 text-blue-400 bg-blue-400/10'
                        }`}>
                          {issue.severity}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-foreground font-heading tracking-wide">{issue.domain}</td>
                      <td className="py-1.5 pr-3 text-foreground-muted">{issue.issue}</td>
                      <td className="py-1.5 pr-3 text-foreground-dim text-[10px]">{issue.detail}</td>
                      <td className="py-1.5 pr-3 text-foreground-dim text-[10px]">{issue.suggestion}</td>
                      <td className="py-1.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Quick action buttons based on issue type */}
                          {issue.issueType === 'waf_blocked' && !issue.isDismissed && (
                            <button
                              onClick={() => handleSetWaf(issue.id, true)}
                              className="text-[8px] font-heading uppercase tracking-wider px-1.5 py-0.5 border border-orange-400/30 text-orange-400 hover:bg-orange-400/10 transition-colors"
                              title="Flag site as WAF-protected (uses Playwright)"
                            >
                              Set WAF
                            </button>
                          )}
                          {(issue.issueType === 'consecutive_failures' || issue.issueType === 'all_recent_failed') && !issue.isDismissed && (
                            <button
                              onClick={async () => {
                                await fetch(`/api/admin/sites/${issue.id}`, {
                                  method: 'PATCH', credentials: 'include',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ isPaused: true }),
                                });
                                fetchSites(); fetchSiteIssues();
                              }}
                              className="text-[8px] font-heading uppercase tracking-wider px-1.5 py-0.5 border border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/10 transition-colors"
                              title="Pause this site"
                            >
                              Pause
                            </button>
                          )}
                          {/* Dismiss / Restore button */}
                          <button
                            onClick={() => handleDismissIssue(issue)}
                            disabled={dismissLoading === issue.issueKey}
                            className={`text-[8px] font-heading uppercase tracking-wider px-1.5 py-0.5 border transition-colors ${
                              issue.isDismissed
                                ? 'border-green-400/30 text-green-400 hover:bg-green-400/10'
                                : 'border-foreground-dim/30 text-foreground-dim hover:text-foreground-muted hover:border-foreground-muted/30'
                            } ${dismissLoading === issue.issueKey ? 'opacity-50 cursor-wait' : ''}`}
                            title={issue.isDismissed ? 'Restore this issue' : 'Dismiss this issue'}
                          >
                            {dismissLoading === issue.issueKey ? '\u2026' : issue.isDismissed ? 'Restore' : '\u2715'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              )}
            </div>
            );
          })()}
        </div>
      )}

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
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          className="bg-surface border border-border text-xs text-foreground-muted px-2 py-1"
        >
          <option value="">All categories</option>
          {categories.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={filterEnabled}
          onChange={e => setFilterEnabled(e.target.value as any)}
          className="bg-surface border border-border text-xs text-foreground-muted px-2 py-1"
        >
          <option value="all">All status</option>
          <option value="enabled">Enabled</option>
          <option value="paused">Paused</option>
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
      {headerInfo === 'capacity' && (
        <div className="border border-border bg-surface-elevated px-5 py-4 mb-2">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">Pressure/Capacity Model (v2)</p>
              <p className="text-xs text-foreground-dim mb-3">Replaces the old difficulty score + traffic class system with a smooth continuous model.</p>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <p className="text-[10px] font-heading text-foreground-muted mb-1">Pressure (0-1)</p>
                  <table className="text-[10px]">
                    <tbody>
                      {[
                        ['Failure rate (HTTP errors)', '40%'],
                        ['Block rate (429/captcha/WAF)', '20%'],
                        ['Latency score (normalized)', '20%'],
                        ['Extraction failure rate', '20%'],
                      ].map(([label, weight]) => (
                        <tr key={label} className="border-b border-border/30">
                          <td className="py-1 pr-4 text-foreground-muted">{label}</td>
                          <td className="py-1 text-right font-heading text-blue-400">{weight}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <p className="text-[10px] font-heading text-foreground-muted mb-1">Capacity = e^(-3 x pressure)</p>
                  <table className="text-[10px]">
                    <tbody>
                      {[
                        ['0.0', '1.00', 'Fully healthy'],
                        ['0.1', '0.74', 'Occasional hiccups'],
                        ['0.3', '0.41', 'Moderate issues'],
                        ['0.5', '0.22', 'Significant pushback'],
                        ['1.0', '0.05', 'Nearly blocked'],
                      ].map(([p, c, desc]) => (
                        <tr key={p} className="border-b border-border/30">
                          <td className="py-0.5 pr-3 text-foreground-muted">{p}</td>
                          <td className="py-0.5 pr-3 font-heading text-green-400">{c}</td>
                          <td className="py-0.5 text-foreground-dim">{desc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="text-[9px] text-foreground-dim mt-2">Rolling window of last 20 crawls. Click any row to see detailed breakdown.</p>
            </div>
            <button onClick={() => setHeaderInfo(null)} className="text-foreground-dim hover:text-foreground text-xs ml-4">&#x2715;</button>
          </div>
        </div>
      )}
      {headerInfo === 'budget' && (
        <div className="border border-border bg-surface-elevated px-5 py-4 mb-2">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">Token Budget System</p>
              <p className="text-xs text-foreground-dim mb-3">Per-site hourly request budget, scaled by capacity.</p>
              <table className="text-[10px]">
                <tbody>
                  {[
                    ['Base budget', '60 req/hr (admin-configurable)'],
                    ['Effective budget', 'max(5, floor(base x capacity))'],
                    ['Min gap', '3600 / effective_budget seconds'],
                    ['Tier 1 reservation', '70% of effective budget'],
                    ['Catalog tiers (2-4)', 'Share remaining 30% + unused Tier 1 tokens'],
                  ].map(([label, value]) => (
                    <tr key={label} className="border-b border-border/30">
                      <td className="py-1 pr-6 text-foreground-muted">{label}</td>
                      <td className="py-1 text-foreground-dim">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={() => setHeaderInfo(null)} className="text-foreground-dim hover:text-foreground text-xs ml-4">&#x2715;</button>
          </div>
        </div>
      )}
      {headerInfo === 'interval' && (
        <div className="border border-border bg-surface-elevated px-5 py-4 mb-2">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">Crawl Interval (v2 Formula)</p>
              <p className="text-xs text-foreground-dim mb-3">Based on site category and capacity. No multiplier stack.</p>
              <table className="text-[10px]">
                <tbody>
                  {[
                    ['Forum / Classified base rate', '4/hour (every 15 min)'],
                    ['Retailer base rate', '2/hour (every 30 min)'],
                    ['Auction base rate', '0.17/hour (every ~6 hours)'],
                    ['Formula', 'interval = 60 / (base_rate x capacity)'],
                    ['Peak hours (9AM-9PM EST)', 'interval x 0.85 (crawl more)'],
                    ['Off-peak', 'interval x 1.2 (crawl less)'],
                    ['Bounds', 'Clamped to [15 min, 1440 min]'],
                  ].map(([label, value]) => (
                    <tr key={label} className="border-b border-border/30">
                      <td className="py-1 pr-6 text-foreground-muted">{label}</td>
                      <td className="py-1 text-foreground-dim">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={() => setHeaderInfo(null)} className="text-foreground-dim hover:text-foreground text-xs ml-4">&#x2715;</button>
          </div>
        </div>
      )}

      {/* Batch action bar */}
      {selectedSites.size > 0 && (
        <div className="flex items-center gap-3 mb-2 px-3 py-2 border border-accent/30 bg-accent/5">
          <span className="text-[10px] font-heading tracking-widest uppercase text-accent">
            {selectedSites.size} selected
          </span>
          <button
            onClick={() => handleBatchToggle(true)}
            disabled={batchLoading}
            className="text-[9px] font-heading uppercase tracking-wider px-2.5 py-0.5 border border-green-400/30 text-green-400 hover:bg-green-400/10 transition-colors disabled:opacity-50"
          >
            Enable
          </button>
          <button
            onClick={() => handleBatchToggle(false)}
            disabled={batchLoading}
            className="text-[9px] font-heading uppercase tracking-wider px-2.5 py-0.5 border border-red-400/30 text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-50"
          >
            Disable
          </button>
          <span className="text-foreground-dim/30">|</span>
          <button
            onClick={() => handleBatchPause(true)}
            disabled={batchLoading}
            className="text-[9px] font-heading uppercase tracking-wider px-2.5 py-0.5 border border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/10 transition-colors disabled:opacity-50"
          >
            Pause
          </button>
          <button
            onClick={() => handleBatchPause(false)}
            disabled={batchLoading}
            className="text-[9px] font-heading uppercase tracking-wider px-2.5 py-0.5 border border-blue-400/30 text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-50"
          >
            Unpause
          </button>
          <button
            onClick={() => setSelectedSites(new Set())}
            className="text-[9px] font-heading uppercase tracking-wider px-2.5 py-0.5 border border-foreground-dim/30 text-foreground-dim hover:text-foreground hover:border-foreground/30 transition-colors ml-auto"
          >
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      <div className="border border-border overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface-elevated border-b border-border">
              <th className="px-2 py-2 w-8">
                <input
                  type="checkbox"
                  checked={filteredSites.length > 0 && selectedSites.size === filteredSites.length}
                  onChange={toggleSelectAll}
                  className="accent-accent cursor-pointer"
                  title="Select all"
                />
              </th>
              {[
                { field: 'domain' as SortField, label: 'Site', info: null as typeof headerInfo },
                { field: 'category' as SortField, label: 'Type', info: null },
                { field: 'capacity' as SortField, label: 'Capacity', info: 'capacity' as const },
                { field: 'budget' as SortField, label: 'Budget', info: 'budget' as const },
                { field: 'interval' as SortField, label: 'Interval', info: 'interval' as const },
                { field: 'nextCrawl' as SortField, label: 'Next Crawl', info: null },
                { field: null, label: 'Last Crawl', info: null },
                { field: 'products' as SortField, label: 'Products', info: null },
                { field: 'failures' as SortField, label: 'Fails', info: null },
                { field: 'searches' as SortField, label: 'Alerts', info: null },
                { field: null, label: 'Signals', info: null },
                { field: null, label: '', info: null },
              ].map((col) => (
                <th
                  key={col.label || 'actions'}
                  className={`px-2.5 py-2 text-left text-[9px] font-heading tracking-widest uppercase text-foreground-muted whitespace-nowrap ${
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
              <tr><td colSpan={13} className="px-3 py-8 text-center text-foreground-dim animate-pulse">Loading sites...</td></tr>
            )}
            {!loading && filteredSites.length === 0 && (
              <tr><td colSpan={13} className="px-3 py-8 text-center text-foreground-dim">No sites match filters</td></tr>
            )}
            {filteredSites.map((site) => {
              const coldStart = getColdStartPhase(site.addedAt, site.coldStartOverride);
              const isExpanded = expanded === site.id;

              return (
              <React.Fragment key={site.id}>
              <tr
                onClick={() => setExpanded(isExpanded ? null : site.id)}
                className={`border-b border-border/50 hover:bg-surface-elevated/30 transition-colors cursor-pointer ${
                  !site.isEnabled ? 'opacity-50' : site.isPaused ? 'opacity-60 bg-yellow-400/[0.03]' : ''
                }`}
              >
                {/* Checkbox */}
                <td className="px-2 py-2.5" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedSites.has(site.id)}
                    onChange={() => toggleSelectSite(site.id)}
                    className="accent-accent cursor-pointer"
                  />
                </td>
                {/* Site name + domain */}
                <td className="px-2.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${healthDot(site.consecutiveFailures)}`} />
                    <div className="min-w-0">
                      <p className="text-foreground font-heading tracking-wide truncate max-w-[160px]">{site.name}</p>
                      <p className="text-[10px] text-foreground-dim truncate max-w-[160px]">{site.domain}</p>
                    </div>
                  </div>
                </td>

                {/* Category + Adapter */}
                <td className="px-2.5 py-2.5">
                  <div className="flex flex-col gap-1">
                    <span className={`text-[8px] font-heading tracking-wider uppercase border px-1.5 py-0.5 inline-block w-fit ${CATEGORY_COLORS[site.siteCategory] || 'text-foreground-muted border-border/50'}`}>
                      {CATEGORY_LABELS[site.siteCategory] || site.siteCategory}
                    </span>
                    <span className="text-[9px] text-foreground-dim">{site.adapterType}</span>
                  </div>
                </td>

                {/* Capacity (gauge) */}
                <td className="px-2.5 py-2.5">
                  <div className="min-w-[80px]">
                    <div className="flex items-baseline gap-1.5">
                      <span className={`font-heading font-bold text-sm ${capacityColor(site.capacity ?? 1)}`}>
                        {((site.capacity ?? 1) * 100).toFixed(0)}%
                      </span>
                      <span className="text-[9px] text-foreground-dim">
                        p:{(site.pressure ?? 0).toFixed(2)}
                      </span>
                    </div>
                    {/* Capacity bar */}
                    <div className="w-full h-1.5 bg-border/50 mt-1 rounded-sm overflow-hidden">
                      <div
                        className={`h-full ${capacityBarColor(site.capacity ?? 1)} transition-all duration-500`}
                        style={{ width: `${Math.max(2, (site.capacity ?? 1) * 100)}%` }}
                      />
                    </div>
                  </div>
                </td>

                {/* Budget */}
                <td className="px-2.5 py-2.5 whitespace-nowrap">
                  <div>
                    <span className="font-heading text-foreground">{site.effectiveBudget ?? 60}</span>
                    <span className="text-foreground-dim">/{site.baseBudget ?? 60}</span>
                    <p className="text-[9px] text-foreground-dim">{site.minGapSeconds ?? 60}s gap</p>
                  </div>
                </td>

                {/* Interval */}
                <td className="px-2.5 py-2.5 whitespace-nowrap">
                  {site.crawlTuning?.tier1IntervalMin != null ? (
                    <span className="text-orange-400 font-heading">{site.crawlTuning.tier1IntervalMin}m*</span>
                  ) : (
                    <span className="text-foreground-muted font-heading">{site.v2IntervalMin ?? site.crawlIntervalMin}m</span>
                  )}
                </td>

                {/* Next crawl */}
                <td className="px-2.5 py-2.5 text-foreground-muted whitespace-nowrap">
                  {site.crawlLock ? (
                    <span className="text-blue-400 animate-pulse">Crawling...</span>
                  ) : (
                    formatCountdown(site.nextCrawlAt)
                  )}
                </td>

                {/* Last crawl */}
                <td className="px-2.5 py-2.5 whitespace-nowrap">
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
                    <span className="text-foreground-dim">{'\u2014'}</span>
                  )}
                </td>

                {/* Products */}
                <td className="px-2.5 py-2.5 font-heading text-foreground-muted">
                  {(site.productCount ?? 0) > 0 ? (site.productCount ?? 0).toLocaleString() : '\u2014'}
                </td>

                {/* Failures */}
                <td className="px-2.5 py-2.5">
                  <span className={site.consecutiveFailures > 0 ? 'text-red-400 font-bold' : 'text-foreground-dim'}>
                    {site.consecutiveFailures}
                  </span>
                </td>

                {/* Active searches */}
                <td className="px-2.5 py-2.5 text-foreground-muted">
                  {site.activeSearches}
                </td>

                {/* Signals */}
                <td className="px-2.5 py-2.5">
                  <div className="flex items-center gap-1 flex-wrap">
                    {site.hasWaf && <span className="text-[8px] border border-yellow-400/30 text-yellow-400 px-1 rounded" title="WAF detected">WAF</span>}
                    {site.hasRateLimit && <span className="text-[8px] border border-orange-400/30 text-orange-400 px-1 rounded" title="Rate limit detected">RL</span>}
                    {site.hasCaptcha && <span className="text-[8px] border border-red-400/30 text-red-400 px-1 rounded" title="CAPTCHA detected">CAP</span>}
                    {site.requiresSucuri && <span className="text-[8px] border border-purple-400/30 text-purple-400 px-1 rounded" title="Requires Sucuri bypass">SUC</span>}
                  </div>
                </td>

                {/* Actions */}
                <td className="px-2.5 py-2.5">
                  <div className="flex items-center gap-1">
                    {site.isPaused ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handlePause(site.id, true); }}
                        className="text-[9px] font-heading uppercase tracking-wider px-2 py-0.5 border border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/10 transition-colors"
                        title="Unpause crawling"
                      >
                        Paused
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleToggle(site.id, site.isEnabled); }}
                          className={`text-[9px] font-heading uppercase tracking-wider px-2 py-0.5 border transition-colors ${
                            site.isEnabled
                              ? 'border-green-400/30 text-green-400 hover:bg-green-400/10'
                              : 'border-red-400/30 text-red-400 hover:bg-red-400/10'
                          }`}
                        >
                          {site.isEnabled ? 'On' : 'Off'}
                        </button>
                        {site.isEnabled && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handlePause(site.id, false); }}
                            className="text-[9px] px-1 py-0.5 border border-foreground-dim/20 text-foreground-dim hover:text-yellow-400 hover:border-yellow-400/30 transition-colors"
                            title="Pause crawling"
                          >
                            ||
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>

              {/* Expandable detail row */}
              {isExpanded && (
                <tr className="bg-surface-elevated/50">
                  <td colSpan={13} className="px-5 py-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      {/* Pressure breakdown */}
                      <div>
                        <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">
                          Pressure / Capacity
                        </p>
                        <table className="text-[10px] w-full">
                          <tbody>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Pressure</td>
                              <td className="py-1 text-right font-heading text-orange-400">{(site.pressure ?? 0).toFixed(3)}</td>
                            </tr>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Capacity</td>
                              <td className={`py-1 text-right font-heading ${capacityColor(site.capacity ?? 1)}`}>{((site.capacity ?? 1) * 100).toFixed(1)}%</td>
                            </tr>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Effective Budget</td>
                              <td className="py-1 text-right font-heading text-foreground">{site.effectiveBudget ?? 60} / {site.baseBudget ?? 60} req/hr</td>
                            </tr>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Min Gap</td>
                              <td className="py-1 text-right font-heading text-foreground">{site.minGapSeconds ?? 60}s</td>
                            </tr>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Interval</td>
                              <td className="py-1 text-right font-heading text-foreground">
                                {site.v2IntervalMin ?? site.crawlIntervalMin}m
                                {site.crawlTuning?.tier1IntervalMin != null && <span className="text-orange-400 ml-1">(tuned: {site.crawlTuning.tier1IntervalMin}m)</span>}
                              </td>
                            </tr>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Cold Start</td>
                              <td className={`py-1 text-right font-heading ${coldStart.color}`}>{coldStart.label}</td>
                            </tr>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Avg Response</td>
                              <td className="py-1 text-right font-heading text-foreground">{site.avgResponseTimeMs ? `${site.avgResponseTimeMs}ms` : '\u2014'}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>

                      {/* Catalog tier status */}
                      <div>
                        <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">
                          Catalog Tiers
                        </p>
                        {(() => {
                          const ts = parseTierState(site.tierState);
                          const t2 = tierStatusBadge(ts.tier2);
                          const t3 = tierStatusBadge(ts.tier3);
                          const t4 = tierStatusBadge(ts.tier4);
                          return (
                            <table className="text-[10px] w-full">
                              <tbody>
                                <tr className="border-b border-border/30">
                                  <td className="py-1 text-foreground-muted">Tier 1 (New Items)</td>
                                  <td className="py-1 text-right">
                                    {site.lastWatermarkUrl ? (
                                      <span className="text-green-400 font-heading">Active</span>
                                    ) : (
                                      <span className="text-foreground-dim">No watermark</span>
                                    )}
                                  </td>
                                </tr>
                                <tr className="border-b border-border/30">
                                  <td className="py-1 text-foreground-muted">Tier 2 (0-7d)</td>
                                  <td className={`py-1 text-right font-heading ${t2.color}`}>{t2.label}</td>
                                </tr>
                                <tr className="border-b border-border/30">
                                  <td className="py-1 text-foreground-muted">Tier 3 (8-21d)</td>
                                  <td className={`py-1 text-right font-heading ${t3.color}`}>{t3.label}</td>
                                </tr>
                                <tr className="border-b border-border/30">
                                  <td className="py-1 text-foreground-muted">Tier 4 (22+d)</td>
                                  <td className={`py-1 text-right font-heading ${t4.color}`}>{t4.label}</td>
                                </tr>
                                <tr className="border-b border-border/30">
                                  <td className="py-1 text-foreground-muted">Products Indexed</td>
                                  <td className="py-1 text-right font-heading text-foreground">{(site.productCount ?? 0).toLocaleString()}</td>
                                </tr>
                              </tbody>
                            </table>
                          );
                        })()}
                        {site.lastWatermarkUrl && (
                          <p className="text-[9px] text-foreground-dim mt-2 truncate" title={site.lastWatermarkUrl}>
                            Watermark: {site.lastWatermarkUrl}
                          </p>
                        )}
                      </div>

                      {/* Site info */}
                      <div>
                        <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">
                          Site Details
                        </p>
                        <table className="text-[10px] w-full">
                          <tbody>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Category</td>
                              <td className="py-1 text-right font-heading text-foreground">{site.siteCategory}</td>
                            </tr>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Adapter</td>
                              <td className="py-1 text-right font-heading text-foreground">{site.adapterType}</td>
                            </tr>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Active Alerts</td>
                              <td className="py-1 text-right font-heading text-foreground">{site.activeSearches}</td>
                            </tr>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Total Crawl Events</td>
                              <td className="py-1 text-right font-heading text-foreground">{site.totalCrawlEvents}</td>
                            </tr>
                            <tr className="border-b border-border/30">
                              <td className="py-1 text-foreground-muted">Added</td>
                              <td className="py-1 text-right text-foreground-dim">{new Date(site.addedAt).toLocaleDateString()}</td>
                            </tr>
                          </tbody>
                        </table>
                        <a
                          href={site.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[9px] text-accent hover:underline mt-2 block truncate"
                        >
                          {site.url}
                        </a>
                      </div>
                    </div>

                    {/* Crawl Tuning Panel */}
                    <CrawlTuningPanel site={site} onSaved={fetchSites} />
                  </td>
                </tr>
              )}
              </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
