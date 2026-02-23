'use client';

import { useState } from 'react';
import type { Search, Match, LiveMatch, ScanResult } from '@/lib/api';
import { searchesApi } from '@/lib/api';
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

export default function AlertDetailPanel({ search, group, onToggle, onDelete, onToggleGroup, onDeleteGroup, onRefresh }: Props) {
  const isGroup = !!group;
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
  const [scanMeta, setScanMeta] = useState<{ newCount: number; totalDbMatches: number; notificationId: string | null } | null>(null);
  const [groupScanMeta, setGroupScanMeta] = useState<{ scannedSites: number; successCount: number; failCount: number; totalMatches: number } | null>(null);

  // Match history
  const [historyMatches, setHistoryMatches] = useState<(Match & { websiteUrl?: string })[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    try {
      if (isGroup) await onToggleGroup!(group.groupId);
      else await onToggle!(search!.id);
    } finally { setToggling(false); }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    setDeleting(true);
    try {
      if (isGroup) await onDeleteGroup!(group.groupId);
      else await onDelete!(search!.id);
    } finally { setDeleting(false); }
  };

  const handleScan = async () => {
    setScanning(true);
    setScanError('');
    setScanResults(null);
    setScanMeta(null);
    setGroupScanMeta(null);
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
    } finally { setScanning(false); }
  };

  const loadHistory = async () => {
    if (historyMatches !== null) {
      setShowHistory(!showHistory);
      return;
    }
    setHistoryLoading(true);
    setShowHistory(true);
    try {
      if (isGroup) {
        const data = await searchesApi.getGroup(group.groupId);
        setHistoryMatches(data.matches);
      } else {
        const data = await searchesApi.matches(search!.id);
        setHistoryMatches(data.matches);
      }
    } catch {
      setHistoryMatches([]);
    } finally { setHistoryLoading(false); }
  };

  const lastChecked = lastCheckedRaw
    ? new Date(lastCheckedRaw).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'Pending';

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={`flex-shrink-0 ${isActive ? 'dot-active' : 'dot-paused'}`} />
          <h2 className="font-heading text-xl tracking-wide">{keyword}</h2>
          {isGroup && (
            <span className="text-[10px] font-heading tracking-widest uppercase px-1.5 py-0.5 border border-accent/30 text-accent">
              All Sites
            </span>
          )}
        </div>
        <p className="text-xs text-foreground-muted pl-4.5">
          {isGroup
            ? `${group.siteCount} sites \u00B7 ${matchCount} matches \u00B7 Last: ${lastChecked}`
            : `${search!.websiteUrl} \u00B7 ${matchCount} matches \u00B7 Last: ${lastChecked}`
          }
        </p>
      </div>

      {/* Action buttons */}
      <div className="px-5 py-3 border-b border-border flex items-center gap-2 flex-shrink-0 flex-wrap">
        <button
          onClick={handleScan}
          disabled={scanning}
          className="text-[11px] font-heading uppercase tracking-wider px-3 py-1.5 border border-blue-400/30 text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-40"
        >
          {scanning ? 'Scanning...' : (isGroup ? 'Scan All' : 'Scan Now')}
        </button>
        <button
          onClick={handleToggle}
          disabled={toggling}
          className={`text-[11px] font-heading uppercase tracking-wider px-3 py-1.5 border transition-colors disabled:opacity-40 ${
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
          className={`text-[11px] font-heading uppercase tracking-wider px-3 py-1.5 border transition-colors disabled:opacity-40 ${
            confirmDelete
              ? 'border-danger text-danger bg-danger-subtle'
              : 'border-border text-foreground-muted hover:border-danger/30 hover:text-danger'
          }`}
        >
          {deleting ? '...' : confirmDelete ? 'Confirm Delete' : 'Delete'}
        </button>

        {/* Metadata badges */}
        <div className="flex items-center gap-2 ml-auto text-[10px] text-foreground-muted">
          <span>{INTERVAL_LABELS[checkInterval] ?? `${checkInterval} min`}</span>
          <span>{NOTIFY_LABELS[notificationType]}</span>
          {inStockOnly && <span className="text-accent border border-accent/20 px-1 py-px font-heading uppercase tracking-wider text-[9px]">In-Stock</span>}
          {maxPrice && <span className="border border-border px-1 py-px font-heading uppercase tracking-wider text-[9px]">Max ${maxPrice}</span>}
        </div>
      </div>

      {/* Content area — scrollable */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Match history toggle */}
        <button
          onClick={loadHistory}
          className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted hover:text-accent transition-colors flex items-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeWidth="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          {showHistory ? 'Hide' : 'Show'} Match History ({matchCount})
        </button>

        {/* Match history */}
        {showHistory && (
          <div className="space-y-1.5">
            {historyLoading && (
              <p className="text-xs text-foreground-muted py-3 text-center animate-pulse">Loading matches...</p>
            )}
            {!historyLoading && historyMatches && historyMatches.length === 0 && (
              <p className="text-xs text-foreground-dim py-3 text-center">No matches yet.</p>
            )}
            {!historyLoading && historyMatches && historyMatches.length > 0 && (
              <>
                {historyMatches.map((match) => (
                  <a
                    key={match.id}
                    href={match.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 px-3 py-2 bg-surface-elevated/50 border border-border/50 rounded text-xs hover:border-accent/30 transition-colors cursor-pointer"
                  >
                    {match.thumbnail && (
                      <img src={match.thumbnail} alt="" className="w-10 h-10 object-cover border border-border/50 rounded flex-shrink-0" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-foreground truncate">{match.title}</p>
                      {match.seller && <span className="text-[9px] text-foreground-dim">{match.seller}</span>}
                    </div>
                    {match.price != null && (
                      <span className="text-accent font-heading flex-shrink-0">${match.price.toFixed(2)}</span>
                    )}
                  </a>
                ))}
                <p className="text-[10px] text-foreground-dim">
                  Showing {historyMatches.length} match{historyMatches.length !== 1 ? 'es' : ''}
                </p>
              </>
            )}
          </div>
        )}

        {/* Scan error */}
        {scanError && (
          <div className="text-xs text-secondary border border-secondary/20 bg-secondary/5 px-3 py-2">
            {scanError}
          </div>
        )}

        {/* Scanning indicator */}
        {scanning && (
          <div className="text-xs text-foreground-muted py-6 text-center animate-pulse">
            {isGroup ? `Scanning ${group.siteCount} sites...` : 'Scanning...'}
          </div>
        )}

        {/* Scan results */}
        {!scanning && scanResults && scanResults.length === 0 && (
          <div className="text-xs text-foreground-dim py-4 text-center">
            No items matching &quot;{keyword}&quot; found.
          </div>
        )}

        {scanResults && scanResults.length > 0 && (
          <ScanResultsGrouped
            results={scanResults}
            isGroup={isGroup}
            scanMeta={scanMeta}
            groupScanMeta={groupScanMeta}
          />
        )}

        {/* Group sites list */}
        {isGroup && (
          <div>
            <p className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mb-2">
              Monitored Sites ({group.siteCount})
            </p>
            <div className="grid grid-cols-2 gap-1">
              {group.searches.map((s) => {
                const domain = (() => { try { return new URL(s.websiteUrl).hostname.replace(/^www\./, ''); } catch { return s.websiteUrl; } })();
                const siteMatches = s._count?.matches ?? 0;
                return (
                  <div key={s.id} className="flex items-center justify-between px-2 py-1 bg-surface-elevated/50 border border-border/50 text-[10px]">
                    <span className="truncate flex-1 text-foreground-muted">{domain}</span>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {siteMatches > 0 && <span className="text-accent">{siteMatches}</span>}
                      <span className={`w-1.5 h-1.5 rounded-full ${s.isActive ? 'bg-green-500' : 'bg-gray-500'}`} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Inline grouped scan results component (same logic as AlertCard's GroupedScanResults)
function ScanResultsGrouped({
  results, isGroup, scanMeta, groupScanMeta,
}: {
  results: LiveMatch[];
  isGroup: boolean;
  scanMeta: { newCount: number; totalDbMatches: number; notificationId: string | null } | null;
  groupScanMeta: { scannedSites: number; successCount: number; failCount: number; totalMatches: number } | null;
}) {
  const [expandedSites, setExpandedSites] = useState<Set<string>>(new Set());

  // Group by site
  const siteGroups = (() => {
    if (!isGroup) return null;
    const groups = new Map<string, { domain: string; items: LiveMatch[]; newCount: number }>();
    for (const item of results) {
      const url = (item as any).websiteUrl || '';
      let domain: string;
      try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { domain = url || 'Unknown'; }
      if (!groups.has(domain)) groups.set(domain, { domain, items: [], newCount: 0 });
      const g = groups.get(domain)!;
      g.items.push(item);
      if (item.isNew) g.newCount++;
    }
    return [...groups.values()].sort((a, b) => b.newCount - a.newCount || b.items.length - a.items.length);
  })();

  const toggleSite = (domain: string) => {
    setExpandedSites(prev => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain); else next.add(domain);
      return next;
    });
  };

  const newCount = results.filter(r => r.isNew).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] text-foreground-muted">
          {results.length} result{results.length !== 1 ? 's' : ''}
          {isGroup && siteGroups && ` across ${siteGroups.length} site${siteGroups.length !== 1 ? 's' : ''}`}
          {newCount > 0 && (
            <span className="ml-1.5 text-[9px] bg-green-600 text-white px-1.5 py-0.5 tracking-wider font-heading uppercase">{newCount} NEW</span>
          )}
        </p>
      </div>

      {isGroup && siteGroups ? (
        <div className="space-y-1">
          {siteGroups.map((sg) => {
            const isExpanded = expandedSites.has(sg.domain);
            return (
              <div key={sg.domain} className="border border-border/50">
                <button
                  onClick={() => toggleSite(sg.domain)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-surface-elevated/30 hover:bg-surface-elevated/60 transition-colors text-left"
                >
                  <div className="flex items-center gap-2">
                    <svg className={`w-3 h-3 text-foreground-dim transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-xs text-foreground font-heading tracking-wide">{sg.domain}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {sg.newCount > 0 && <span className="text-[9px] bg-green-600 text-white px-1.5 py-0.5 font-heading tracking-wider uppercase">{sg.newCount} new</span>}
                    <span className="text-[10px] text-foreground-muted">{sg.items.length}</span>
                  </div>
                </button>
                {isExpanded && (
                  <div className="border-t border-border/30 space-y-px">
                    {sg.items.map((item, i) => (
                      <a key={i} href={item.url} target="_blank" rel="noopener noreferrer"
                        className={`flex items-center gap-3 px-3 py-2 text-xs hover:border-accent/30 transition-colors cursor-pointer ${
                          item.isNew ? 'bg-green-950/30 border-l-2 border-l-green-500' : 'bg-surface-elevated/50'
                        }`}
                      >
                        {item.isNew && <span className="text-[9px] font-heading tracking-widest uppercase bg-green-600 text-white px-1.5 py-0.5 flex-shrink-0">NEW</span>}
                        <div className="flex-1 min-w-0"><p className="text-foreground truncate">{item.title}</p></div>
                        {item.price != null && <span className="text-accent font-heading flex-shrink-0">${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-1.5">
          {results.map((item, i) => (
            <a key={i} href={item.url} target="_blank" rel="noopener noreferrer"
              className={`flex items-center gap-3 px-3 py-2 border text-xs hover:border-accent/30 transition-colors cursor-pointer ${
                item.isNew ? 'bg-green-950/30 border-l-2 border-l-green-500 border-green-700/40' : 'bg-surface-elevated/50 border-border/50'
              }`}
            >
              {item.isNew && <span className="text-[9px] font-heading tracking-widest uppercase bg-green-600 text-white px-1.5 py-0.5 flex-shrink-0">NEW</span>}
              {item.thumbnail && <img src={item.thumbnail} alt="" className="w-10 h-10 object-cover border border-border/50 rounded flex-shrink-0" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
              <div className="flex-1 min-w-0">
                <p className="text-foreground truncate">{item.title}</p>
                {item.seller && <span className="text-[9px] text-foreground-dim">{item.seller}</span>}
              </div>
              {item.price != null && <span className="text-accent font-heading flex-shrink-0">${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>}
            </a>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <p className="text-[10px] text-foreground-dim">
          {groupScanMeta ? `${groupScanMeta.successCount} sites scanned` : scanMeta ? `${scanMeta.totalDbMatches} in database` : ''}
        </p>
        {scanMeta?.notificationId && (
          <a href={`http://localhost:4000/notifications/${scanMeta.notificationId}`} target="_blank" rel="noopener noreferrer"
            className="text-[10px] font-heading tracking-wider uppercase text-accent hover:underline border border-accent/20 px-2 py-0.5">
            View Notification
          </a>
        )}
      </div>
    </div>
  );
}
