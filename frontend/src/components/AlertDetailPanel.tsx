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

  // Match history with pagination
  const [historyMatches, setHistoryMatches] = useState<(Match & { websiteUrl?: string })[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyTotal, setHistoryTotal] = useState(0);

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

  const handleRefresh = async () => {
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
        if (onRefresh) onRefresh();
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Failed to refresh');
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
        setHistoryTotal((data as any).totalMatches ?? data.matches.length);
      } else {
        const data = await searchesApi.matches(search!.id);
        setHistoryMatches(data.matches);
        setHistoryTotal((data as any).total ?? data.matches.length);
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
      {/* Header with metadata */}
      <div className="px-6 py-5 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <span className={`flex-shrink-0 ${isActive ? 'dot-active' : 'dot-paused'}`} />
          <h2 className="font-heading text-2xl tracking-wide">{keyword}</h2>
          {isGroup && (
            <span className="text-[10px] font-heading tracking-widest uppercase px-1.5 py-0.5 border border-accent/30 text-accent">
              All Sites
            </span>
          )}
        </div>
        <p className="text-xs text-foreground-muted mb-3 pl-5">
          {isGroup
            ? `${group.siteCount} sites \u00B7 ${matchCount} matches \u00B7 Last: ${lastChecked}`
            : `${search!.websiteUrl} \u00B7 ${matchCount} matches \u00B7 Last: ${lastChecked}`
          }
        </p>
        {/* Metadata badges */}
        <div className="flex items-center gap-3 pl-5 flex-wrap">
          <span className="text-[10px] text-foreground-dim border border-border px-2 py-0.5 font-heading uppercase tracking-wider">
            {INTERVAL_LABELS[checkInterval] ?? `${checkInterval} min`}
          </span>
          <span className="text-[10px] text-foreground-dim border border-border px-2 py-0.5 font-heading uppercase tracking-wider">
            {NOTIFY_LABELS[notificationType]}
          </span>
          {inStockOnly && (
            <span className="text-[10px] text-accent border border-accent/20 px-2 py-0.5 font-heading uppercase tracking-wider">
              In-Stock Only
            </span>
          )}
          {maxPrice != null && (
            <span className="text-[10px] text-foreground-dim border border-border px-2 py-0.5 font-heading uppercase tracking-wider">
              Max ${maxPrice}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons (separate row) */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-2 flex-shrink-0">
        <button
          onClick={handleRefresh}
          disabled={scanning}
          className="text-[11px] font-heading uppercase tracking-wider px-4 py-1.5 border border-blue-400/30 text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-40"
        >
          {scanning ? 'Loading...' : (isGroup ? 'Refresh All' : 'Refresh Results')}
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
      </div>

      {/* Content area (scrollable) */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

        {/* Section: Results */}
        <section>
          <div className="flex items-center gap-3 pb-1 border-b border-border/40 mb-3">
            <span className="text-[10px] font-heading tracking-[0.2em] uppercase text-foreground-muted">Results</span>
            {scanResults && <span className="text-[10px] text-foreground-dim">{scanResults.length} items</span>}
          </div>

          {scanError && (
            <div className="text-xs text-secondary border border-secondary/20 bg-secondary/5 px-4 py-2.5 rounded">
              {scanError}
            </div>
          )}

          {scanning && (
            <div className="text-xs text-foreground-muted py-8 text-center animate-pulse">
              {isGroup ? `Loading results from ${group.siteCount} sites...` : 'Loading results...'}
            </div>
          )}

          {!scanning && !scanResults && (
            <div className="text-xs text-foreground-dim py-4 text-center">
              Click Refresh to load cached results.
            </div>
          )}

          {!scanning && scanResults && scanResults.length === 0 && (
            <div className="text-xs text-foreground-dim py-6 text-center border border-border/30 rounded">
              No items matching &quot;{keyword}&quot; found yet. Results will appear after the next crawl cycle.
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
        </section>

        {/* Section: Match History */}
        <section>
          <button onClick={loadHistory} className="w-full">
            <div className="flex items-center gap-3 pb-1 border-b border-border/40">
              <svg className={`w-3 h-3 text-foreground-dim transition-transform duration-200 ${showHistory ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
              </svg>
              <span className="text-[10px] font-heading tracking-[0.2em] uppercase text-foreground-muted">Match History</span>
              <span className="text-[10px] text-foreground-dim">{matchCount} total</span>
            </div>
          </button>

          {showHistory && (
            <div className="mt-3 space-y-1.5">
              {historyLoading && (
                <p className="text-xs text-foreground-muted py-4 text-center animate-pulse">Loading matches...</p>
              )}
              {!historyLoading && historyMatches && historyMatches.length === 0 && (
                <p className="text-xs text-foreground-dim py-4 text-center">No matches yet. Results will appear after the next crawl.</p>
              )}
              {historyMatches && historyMatches.length > 0 && (
                <>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-1.5">
                    {historyMatches.map((match) => (
                      <a
                        key={match.id}
                        href={match.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 px-3 py-2.5 bg-surface-elevated/50 border border-border/50 rounded text-xs hover:border-accent/30 transition-colors cursor-pointer group"
                      >
                        {match.thumbnail && (
                          <img src={match.thumbnail} alt="" className="w-12 h-12 object-cover border border-border/50 rounded flex-shrink-0" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-foreground truncate group-hover:text-accent transition-colors">{match.title}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {match.seller && <span className="text-[9px] text-foreground-dim">{match.seller}</span>}
                            {(match as any).websiteUrl && (
                              <span className="text-[9px] text-foreground-dim">
                                {(() => { try { return new URL((match as any).websiteUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })()}
                              </span>
                            )}
                          </div>
                        </div>
                        {match.price != null && (
                          <span className="text-accent font-heading flex-shrink-0">${match.price.toFixed(2)}</span>
                        )}
                        <svg className="w-3 h-3 text-foreground-dim flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    ))}
                  </div>
                  <p className="text-[10px] text-foreground-dim pt-2">
                    Showing {historyMatches.length} of {historyTotal} match{historyTotal !== 1 ? 'es' : ''}
                  </p>
                </>
              )}
            </div>
          )}
        </section>

        {/* Section: Monitored Sites (groups only) */}
        {isGroup && (
          <section>
            <div className="flex items-center gap-3 pb-1 border-b border-border/40 mb-3">
              <span className="text-[10px] font-heading tracking-[0.2em] uppercase text-foreground-muted">Monitored Sites</span>
              <span className="text-[10px] text-foreground-dim">{group.siteCount} sites</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
              {group.searches.map((s) => {
                const domain = (() => { try { return new URL(s.websiteUrl).hostname.replace(/^www\./, ''); } catch { return s.websiteUrl; } })();
                const siteMatches = s._count?.matches ?? 0;
                return (
                  <a
                    key={s.id}
                    href={s.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between px-3 py-2 bg-surface-elevated/50 border border-border/50 rounded text-[11px] hover:border-accent/30 transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.isActive ? 'bg-green-500' : 'bg-gray-500'}`} />
                      <span className="truncate text-foreground-muted group-hover:text-accent transition-colors">{domain}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {siteMatches > 0 && <span className="text-accent font-heading">{siteMatches}</span>}
                      <svg className="w-3 h-3 text-foreground-dim opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </div>
                  </a>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// Grouped scan results component
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
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] text-foreground-muted">
          {groupScanMeta ? `${groupScanMeta.totalMatches} results` : `${results.length} result${results.length !== 1 ? 's' : ''}`}
          {isGroup && siteGroups && ` across ${siteGroups.length} site${siteGroups.length !== 1 ? 's' : ''}`}
          {newCount > 0 && (
            <span className="ml-2 text-[9px] bg-green-600 text-white px-1.5 py-0.5 tracking-wider font-heading uppercase rounded-sm">{newCount} NEW</span>
          )}
        </p>
        {scanMeta && (
          <p className="text-[10px] text-foreground-dim">{scanMeta.totalDbMatches} in database</p>
        )}
      </div>

      {isGroup && siteGroups ? (
        <div className="space-y-1.5">
          {siteGroups.map((sg) => {
            const isExpanded = expandedSites.has(sg.domain);
            return (
              <div key={sg.domain} className="border border-border/50 rounded overflow-hidden">
                <button
                  onClick={() => toggleSite(sg.domain)}
                  className="w-full flex items-center justify-between px-4 py-2.5 bg-surface-elevated/30 hover:bg-surface-elevated/60 transition-colors text-left"
                >
                  <div className="flex items-center gap-2">
                    <svg className={`w-3 h-3 text-foreground-dim transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-xs text-foreground font-heading tracking-wide">{sg.domain}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {sg.newCount > 0 && <span className="text-[9px] bg-green-600 text-white px-1.5 py-0.5 font-heading tracking-wider uppercase rounded-sm">{sg.newCount} new</span>}
                    <span className="text-[10px] text-foreground-muted">{sg.items.length}</span>
                  </div>
                </button>
                {isExpanded && (
                  <div className="border-t border-border/30">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-px">
                      {sg.items.map((item, i) => (
                        <a key={i} href={item.url} target="_blank" rel="noopener noreferrer"
                          className={`flex items-center gap-3 px-4 py-2.5 text-xs hover:bg-surface-elevated/80 transition-colors cursor-pointer group ${
                            item.isNew ? 'bg-green-950/30 border-l-2 border-l-green-500' : 'bg-surface-elevated/50'
                          }`}
                        >
                          {item.isNew && <span className="text-[9px] font-heading tracking-widest uppercase bg-green-600 text-white px-1.5 py-0.5 flex-shrink-0 rounded-sm">NEW</span>}
                          {item.thumbnail && <img src={item.thumbnail} alt="" className="w-10 h-10 object-cover border border-border/50 rounded flex-shrink-0" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
                          <div className="flex-1 min-w-0">
                            <p className="text-foreground truncate group-hover:text-accent transition-colors">{item.title}</p>
                            {item.seller && <span className="text-[9px] text-foreground-dim">{item.seller}</span>}
                          </div>
                          {item.price != null && <span className="text-accent font-heading flex-shrink-0">${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>}
                          <svg className="w-3 h-3 text-foreground-dim flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-1.5">
          {results.map((item, i) => (
            <a key={i} href={item.url} target="_blank" rel="noopener noreferrer"
              className={`flex items-center gap-3 px-4 py-2.5 border rounded text-xs hover:border-accent/30 transition-colors cursor-pointer group ${
                item.isNew ? 'bg-green-950/30 border-l-2 border-l-green-500 border-green-700/40' : 'bg-surface-elevated/50 border-border/50'
              }`}
            >
              {item.isNew && <span className="text-[9px] font-heading tracking-widest uppercase bg-green-600 text-white px-1.5 py-0.5 flex-shrink-0 rounded-sm">NEW</span>}
              {item.thumbnail && <img src={item.thumbnail} alt="" className="w-12 h-12 object-cover border border-border/50 rounded flex-shrink-0" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
              <div className="flex-1 min-w-0">
                <p className="text-foreground truncate group-hover:text-accent transition-colors">{item.title}</p>
                {item.seller && <span className="text-[9px] text-foreground-dim">{item.seller}</span>}
              </div>
              {item.price != null && <span className="text-accent font-heading flex-shrink-0">${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>}
              <svg className="w-3 h-3 text-foreground-dim flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
