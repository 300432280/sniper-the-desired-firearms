'use client';

import { useState } from 'react';
import { Search, Match, LiveMatch, ScanResult, searchesApi } from '@/lib/api';
import type { SearchGroup } from '@/app/dashboard/page';

interface Props {
  search?: Search;
  group?: SearchGroup;
  onToggle?: (id: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onToggleGroup?: (groupId: string) => Promise<void>;
  onDeleteGroup?: (groupId: string) => Promise<void>;
  onRefresh?: () => void;
}

const INTERVAL_LABELS: Record<number, string> = {
  0: '10 sec',
  5: '5 min',
  30: '30 min',
  60: '1 hr',
};

const NOTIFY_LABELS: Record<string, string> = {
  EMAIL: 'Email',
  SMS: 'SMS',
  BOTH: 'Email + SMS',
};

// Shared match row component
function MatchRow({ match, showSite }: { match: Match & { websiteUrl?: string }; showSite?: boolean }) {
  const domain = match.websiteUrl
    ? (() => { try { return new URL(match.websiteUrl).hostname.replace(/^www\./, ''); } catch { return match.websiteUrl; } })()
    : null;

  return (
    <a
      href={match.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 px-3 py-2 bg-surface-elevated/50 border border-border/50 rounded text-xs hover:border-accent/30 hover:bg-surface-elevated transition-colors cursor-pointer"
    >
      {match.thumbnail && (
        <img
          src={match.thumbnail}
          alt=""
          className="w-10 h-10 object-cover border border-border/50 rounded flex-shrink-0"
          loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      <span className="text-[10px] text-foreground-dim font-mono flex-shrink-0 min-w-[68px]">
        {match.postDate
          ? new Date(match.postDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
          : new Date(match.foundAt).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
        }{' '}
        {(match.postDate ? new Date(match.postDate) : new Date(match.foundAt))
          .toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-foreground truncate" title={match.title}>
          {match.title}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          {match.seller && (
            <span className="text-[9px] text-foreground-dim">{match.seller}</span>
          )}
          {showSite && domain && (
            <span className="text-[9px] text-foreground-dim border border-border/50 px-1 rounded">
              {domain}
            </span>
          )}
        </div>
      </div>
      {match.price != null && (
        <span className="text-accent font-heading flex-shrink-0">${match.price.toFixed(2)}</span>
      )}
      <svg className="w-3.5 h-3.5 text-foreground-dim flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeWidth="1.5" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
      </svg>
    </a>
  );
}

export default function AlertCard({ search, group, onToggle, onDelete, onToggleGroup, onDeleteGroup, onRefresh }: Props) {
  const isGroup = !!group;

  // Derive common display values from either search or group
  const keyword = isGroup ? group.keyword : search!.keyword;
  const isActive = isGroup ? group.isActive : search!.isActive;
  const checkInterval = isGroup ? group.checkInterval : search!.checkInterval;
  const notificationType = isGroup ? group.notificationType : search!.notificationType;
  const inStockOnly = isGroup ? group.inStockOnly : search!.inStockOnly;
  const maxPrice = isGroup ? group.maxPrice : search!.maxPrice;
  const matchCount = isGroup ? group.totalMatches : (search!._count?.matches ?? 0);
  const lastCheckedRaw = isGroup ? group.lastChecked : search!.lastChecked;

  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<LiveMatch[] | null>(null);
  const [scanError, setScanError] = useState('');
  const [showResults, setShowResults] = useState(false);
  const [scanMeta, setScanMeta] = useState<{ newCount: number; totalDbMatches: number; notificationId: string | null } | null>(null);

  // Match history state
  const [showHistory, setShowHistory] = useState(false);
  const [historyMatches, setHistoryMatches] = useState<(Match & { websiteUrl?: string })[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Group sites list
  const [showSites, setShowSites] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    try {
      if (isGroup) {
        await onToggleGroup!(group.groupId);
      } else {
        await onToggle!(search!.id);
      }
    } finally {
      setToggling(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    setDeleting(true);
    try {
      if (isGroup) {
        await onDeleteGroup!(group.groupId);
      } else {
        await onDelete!(search!.id);
      }
    } finally {
      setDeleting(false);
    }
  };

  // Group scan state
  const [groupScanMeta, setGroupScanMeta] = useState<{ scannedSites: number; successCount: number; failCount: number; totalMatches: number } | null>(null);

  const handleScan = async () => {
    setScanning(true);
    setScanError('');
    setScanResults(null);
    setScanMeta(null);
    setGroupScanMeta(null);
    setShowResults(true);
    try {
      if (isGroup) {
        const data = await searchesApi.scanGroup(group.groupId);
        setScanResults(data.matches);
        setGroupScanMeta({ scannedSites: data.scannedSites, successCount: data.successCount, failCount: data.failCount, totalMatches: data.totalMatches });
        setHistoryMatches(null);
        if (onRefresh) onRefresh();
      } else {
        const data: ScanResult = await searchesApi.scanNow(search!.id);
        setScanResults(data.matches);
        setScanMeta({ newCount: data.newCount, totalDbMatches: data.totalDbMatches, notificationId: data.notificationId });
        setHistoryMatches(null);
        if (data.newCount > 0 && onRefresh) onRefresh();
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const toggleHistory = async () => {
    const willShow = !showHistory;
    setShowHistory(willShow);
    if (willShow && historyMatches === null) {
      setHistoryLoading(true);
      try {
        if (isGroup) {
          // Load aggregated matches from group endpoint
          const data = await searchesApi.getGroup(group.groupId);
          setHistoryMatches(data.matches);
        } else {
          const data = await searchesApi.matches(search!.id);
          setHistoryMatches(data.matches);
        }
      } catch {
        setHistoryMatches([]);
      } finally {
        setHistoryLoading(false);
      }
    }
  };

  const lastChecked = lastCheckedRaw
    ? new Date(lastCheckedRaw).toLocaleString('en-CA', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Pending';

  const isExpiring = !isGroup && search!.expiresAt
    ? new Date(search!.expiresAt).getTime() - Date.now() < 4 * 60 * 60 * 1000
    : false;

  return (
    <div
      className={`card border-l-2 transition-all duration-200 animate-fade-in ${
        isActive ? 'border-l-accent' : 'border-l-border-strong'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Left: keyword + url/site count */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 mb-1">
            <span
              className={`flex-shrink-0 ${isActive ? 'dot-active' : 'dot-paused'}`}
            />
            <h3 className="font-heading text-base tracking-wide truncate">
              {keyword}
            </h3>
            {isGroup && (
              <span className="text-[10px] font-heading tracking-widest uppercase px-1.5 py-0.5 border border-accent/30 text-accent flex-shrink-0">
                All Sites
              </span>
            )}
            {!isGroup && search!.expiresAt && (
              <span
                className={`text-[10px] font-heading tracking-widest uppercase px-1.5 py-0.5 border flex-shrink-0 ${
                  isExpiring
                    ? 'text-secondary border-secondary/30'
                    : 'text-foreground-muted border-border'
                }`}
              >
                Guest
              </span>
            )}
          </div>
          <p className="text-xs text-foreground-muted truncate pl-4.5">
            {isGroup
              ? `Monitoring ${group.siteCount} Canadian sites`
              : search!.websiteUrl
            }
          </p>
        </div>

        {/* Right: action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={handleScan}
            disabled={scanning}
            className="text-[11px] font-heading uppercase tracking-wider px-3 py-1 border border-blue-400/30 text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-40"
          >
            {scanning ? (isGroup ? `Scanning ${group.siteCount} sites...` : 'Scanning...') : (isGroup ? 'Scan All' : 'Scan Now')}
          </button>

          {isGroup && (
            <button
              onClick={() => setShowSites((v) => !v)}
              className="text-[11px] font-heading uppercase tracking-wider px-3 py-1 border border-blue-400/30 text-blue-400 hover:bg-blue-400/10 transition-colors"
            >
              {showSites ? 'Hide Sites' : `${group.siteCount} Sites`}
            </button>
          )}

          <button
            onClick={handleToggle}
            disabled={toggling}
            className={`text-[11px] font-heading uppercase tracking-wider px-3 py-1 border transition-colors disabled:opacity-40 ${
              isActive
                ? 'border-accent/30 text-accent hover:bg-accent/10'
                : 'border-border text-foreground-muted hover:border-accent/30 hover:text-accent'
            }`}
          >
            {toggling ? '...' : isActive ? 'Pause' : 'Resume'}
          </button>

          <button
            onClick={handleDelete}
            disabled={deleting}
            className={`text-[11px] font-heading uppercase tracking-wider px-3 py-1 border transition-colors disabled:opacity-40 ${
              confirmDelete
                ? 'border-danger text-danger bg-danger-subtle'
                : 'border-border text-foreground-muted hover:border-danger/30 hover:text-danger'
            }`}
          >
            {deleting ? '...' : confirmDelete ? 'Confirm' : 'Delete'}
          </button>
        </div>
      </div>

      {/* Metadata row */}
      <div className="mt-3.5 pt-3 border-t border-border flex items-center flex-wrap gap-x-4 gap-y-1 text-[11px] text-foreground-muted font-body">
        <span className="flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" strokeWidth="1.5" />
            <path strokeLinecap="round" strokeWidth="1.5" d="M12 6v6l3.5 3.5" />
          </svg>
          {INTERVAL_LABELS[checkInterval] ?? `${checkInterval} min`}
        </span>

        <span className="flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeWidth="1.5" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          {NOTIFY_LABELS[notificationType]}
        </span>

        {/* Clickable match count — toggles match history */}
        <button
          onClick={toggleHistory}
          className={`flex items-center gap-1 hover:text-accent transition-colors ${matchCount > 0 ? 'text-accent' : ''}`}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeWidth="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          {matchCount} match{matchCount !== 1 ? 'es' : ''}
          {isGroup && ` across ${group.siteCount} sites`}
          <svg
            className={`w-3 h-3 transition-transform duration-200 ${showHistory ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {inStockOnly && (
          <span className="text-accent border border-accent/20 px-1.5 py-0.5 font-heading tracking-wider uppercase text-[10px]">
            In-Stock Only
          </span>
        )}
        {maxPrice && (
          <span className="border border-border px-1.5 py-0.5 font-heading tracking-wider uppercase text-[10px]">
            Max ${maxPrice}
          </span>
        )}

        <span className="ml-auto">
          Checked: {lastChecked}
        </span>
      </div>

      {/* Group sites panel (expandable) */}
      {isGroup && showSites && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted">
              Monitored Sites ({group.siteCount})
            </span>
            <button
              onClick={() => setShowSites(false)}
              className="text-[10px] text-foreground-dim hover:text-foreground transition-colors"
            >
              Close
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1">
            {group.searches.map((s) => {
              const domain = (() => { try { return new URL(s.websiteUrl).hostname.replace(/^www\./, ''); } catch { return s.websiteUrl; } })();
              const siteMatches = s._count?.matches ?? 0;
              return (
                <div key={s.id} className="flex items-center justify-between px-2 py-1 bg-surface-elevated/50 border border-border/50 text-[10px]">
                  <span className="truncate flex-1 text-foreground-muted">{domain}</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {siteMatches > 0 && (
                      <span className="text-accent">{siteMatches}</span>
                    )}
                    <span className={`w-1.5 h-1.5 rounded-full ${s.isActive ? 'bg-green-500' : 'bg-gray-500'}`} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Match history panel (expandable) — works for both individual and group */}
      {showHistory && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted">
              Match History
              {isGroup && historyMatches && historyMatches.length > 0 && (
                <span className="ml-2 text-[9px] text-accent">
                  from {new Set((historyMatches as (Match & { websiteUrl?: string })[]).map(m => m.websiteUrl).filter(Boolean)).size} sites
                </span>
              )}
            </span>
            <button
              onClick={() => setShowHistory(false)}
              className="text-[10px] text-foreground-dim hover:text-foreground transition-colors"
            >
              Close
            </button>
          </div>

          {historyLoading && (
            <div className="text-xs text-foreground-muted py-4 text-center">
              <span className="inline-block animate-pulse">Loading matches...</span>
            </div>
          )}

          {!historyLoading && historyMatches && historyMatches.length === 0 && (
            <div className="text-xs text-foreground-dim py-3 text-center">
              No matches yet. {isGroup ? 'Results will appear as sites are scanned.' : 'Run a scan or wait for the next scheduled check.'}
            </div>
          )}

          {!historyLoading && historyMatches && historyMatches.length > 0 && (
            <div className="space-y-1.5">
              {historyMatches.map((match) => (
                <MatchRow key={match.id} match={match} showSite={isGroup} />
              ))}
              <p className="text-[10px] text-foreground-dim pt-1">
                Showing {historyMatches.length} match{historyMatches.length !== 1 ? 'es' : ''} (newest first)
              </p>
            </div>
          )}
        </div>
      )}

      {/* Scan results panel — works for both individual and group */}
      {showResults && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted">
              Live Scan Results
              {scanMeta && scanMeta.newCount > 0 && (
                <span className="ml-2 text-[9px] bg-green-600 text-white px-1.5 py-0.5 tracking-wider">
                  {scanMeta.newCount} NEW
                </span>
              )}
              {groupScanMeta && (
                <span className="ml-2 text-[9px] text-accent">
                  {groupScanMeta.successCount}/{groupScanMeta.scannedSites} sites scanned
                </span>
              )}
            </span>
            <button
              onClick={() => { setShowResults(false); setScanResults(null); setScanError(''); setScanMeta(null); setGroupScanMeta(null); }}
              className="text-[10px] text-foreground-dim hover:text-foreground transition-colors"
            >
              Close
            </button>
          </div>

          {scanning && (
            <div className="text-xs text-foreground-muted py-4 text-center">
              <span className="inline-block animate-pulse">
                {isGroup ? `Scanning ${group.siteCount} sites in parallel...` : `Scanning ${search!.websiteUrl}...`}
              </span>
            </div>
          )}

          {scanError && (
            <div className="text-xs text-secondary border border-secondary/20 bg-secondary/5 px-3 py-2">
              {scanError}
            </div>
          )}

          {!scanning && scanResults && scanResults.length === 0 && (
            <div className="text-xs text-foreground-dim py-3 text-center">
              No items matching &quot;{keyword}&quot; found right now.
            </div>
          )}

          {scanResults && scanResults.length > 0 && (
            <div className="space-y-1.5">
              {scanResults.map((item, i) => (
                <a
                  key={i}
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex items-center gap-3 px-3 py-2 border text-xs hover:border-accent/30 transition-colors cursor-pointer ${
                    item.isNew
                      ? 'bg-green-950/30 border-green-700/40'
                      : 'bg-surface-elevated/50 border-border/50'
                  }`}
                >
                  {item.isNew && (
                    <span className="text-[9px] font-heading tracking-widest uppercase bg-green-600 text-white px-1.5 py-0.5 flex-shrink-0">
                      NEW
                    </span>
                  )}
                  {item.thumbnail && (
                    <img
                      src={item.thumbnail}
                      alt=""
                      className="w-10 h-10 object-cover border border-border/50 rounded flex-shrink-0"
                      loading="lazy"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-foreground truncate">{item.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {item.seller && (
                        <span className="text-[9px] text-foreground-dim">{item.seller}</span>
                      )}
                      {isGroup && (item as any).websiteUrl && (
                        <span className="text-[9px] text-foreground-dim border border-border/50 px-1 rounded">
                          {(() => { try { return new URL((item as any).websiteUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })()}
                        </span>
                      )}
                    </div>
                  </div>
                  {item.price != null && (
                    <span className="text-accent font-heading flex-shrink-0">${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>
                  )}
                  {item.inStock !== undefined && (
                    <span className={`text-[9px] font-heading tracking-widest uppercase flex-shrink-0 px-1.5 py-0.5 border ${
                      item.inStock
                        ? 'text-green-400 border-green-400/30'
                        : 'text-red-400 border-red-400/30'
                    }`}>
                      {item.inStock ? 'In Stock' : 'Out'}
                    </span>
                  )}
                  <svg className="w-3.5 h-3.5 text-foreground-dim flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeWidth="1.5" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                  </svg>
                </a>
              ))}
              <div className="flex items-center justify-between pt-1">
                <p className="text-[10px] text-foreground-dim">
                  {scanResults.length} item{scanResults.length !== 1 ? 's' : ''}
                  {groupScanMeta
                    ? ` from ${groupScanMeta.successCount} sites (${groupScanMeta.failCount} failed)`
                    : scanMeta ? ` on site — ${scanMeta.totalDbMatches} in database` : ''
                  }
                </p>
                {scanMeta?.notificationId && (
                  <a
                    href={`http://localhost:4000/notifications/${scanMeta.notificationId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] font-heading tracking-wider uppercase text-accent hover:underline border border-accent/20 px-2 py-0.5"
                  >
                    View Notification
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
