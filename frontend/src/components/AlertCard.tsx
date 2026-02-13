'use client';

import { useState } from 'react';
import { Search, LiveMatch, ScanResult, searchesApi } from '@/lib/api';

interface Props {
  search: Search;
  onToggle: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
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

export default function AlertCard({ search, onToggle, onDelete, onRefresh }: Props) {
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<LiveMatch[] | null>(null);
  const [scanError, setScanError] = useState('');
  const [showResults, setShowResults] = useState(false);
  const [scanMeta, setScanMeta] = useState<{ newCount: number; totalDbMatches: number; notificationId: string | null } | null>(null);

  const handleToggle = async () => {
    setToggling(true);
    try {
      await onToggle(search.id);
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
      await onDelete(search.id);
    } finally {
      setDeleting(false);
    }
  };

  const handleScan = async () => {
    setScanning(true);
    setScanError('');
    setScanResults(null);
    setScanMeta(null);
    setShowResults(true);
    try {
      const data: ScanResult = await searchesApi.scanNow(search.id);
      setScanResults(data.matches);
      setScanMeta({ newCount: data.newCount, totalDbMatches: data.totalDbMatches, notificationId: data.notificationId });
      if (data.newCount > 0 && onRefresh) {
        onRefresh();
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const lastChecked = search.lastChecked
    ? new Date(search.lastChecked).toLocaleString('en-CA', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Pending';

  const isExpiring = search.expiresAt
    ? new Date(search.expiresAt).getTime() - Date.now() < 4 * 60 * 60 * 1000
    : false;

  return (
    <div
      className={`card border-l-2 transition-all duration-200 animate-fade-in ${
        search.isActive ? 'border-l-accent' : 'border-l-border-strong'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Left: keyword + url */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 mb-1">
            <span
              className={`flex-shrink-0 ${search.isActive ? 'dot-active' : 'dot-paused'}`}
            />
            <h3 className="font-heading text-base tracking-wide truncate">
              {search.keyword}
            </h3>
            {search.expiresAt && (
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
          <p className="text-xs text-foreground-muted truncate pl-4.5">{search.websiteUrl}</p>
        </div>

        {/* Right: action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={handleScan}
            disabled={scanning}
            className="text-[11px] font-heading uppercase tracking-wider px-3 py-1 border border-blue-400/30 text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-40"
          >
            {scanning ? 'Scanning...' : 'Scan Now'}
          </button>

          <button
            onClick={handleToggle}
            disabled={toggling}
            className={`text-[11px] font-heading uppercase tracking-wider px-3 py-1 border transition-colors disabled:opacity-40 ${
              search.isActive
                ? 'border-accent/30 text-accent hover:bg-accent/10'
                : 'border-border text-foreground-muted hover:border-accent/30 hover:text-accent'
            }`}
          >
            {toggling ? '...' : search.isActive ? 'Pause' : 'Resume'}
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
          {INTERVAL_LABELS[search.checkInterval] ?? `${search.checkInterval} min`}
        </span>

        <span className="flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeWidth="1.5" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          {NOTIFY_LABELS[search.notificationType]}
        </span>

        {search._count !== undefined && (
          <span className={`flex items-center gap-1 ${search._count.matches > 0 ? 'text-accent' : ''}`}>
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeWidth="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            {search._count.matches} match{search._count.matches !== 1 ? 'es' : ''}
          </span>
        )}

        {search.inStockOnly && (
          <span className="text-accent border border-accent/20 px-1.5 py-0.5 font-heading tracking-wider uppercase text-[10px]">
            In-Stock Only
          </span>
        )}
        {search.maxPrice && (
          <span className="border border-border px-1.5 py-0.5 font-heading tracking-wider uppercase text-[10px]">
            Max ${search.maxPrice}
          </span>
        )}

        <span className="ml-auto">
          Checked: {lastChecked}
        </span>
      </div>

      {/* Scan results panel */}
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
            </span>
            <button
              onClick={() => { setShowResults(false); setScanResults(null); setScanError(''); setScanMeta(null); }}
              className="text-[10px] text-foreground-dim hover:text-foreground transition-colors"
            >
              Close
            </button>
          </div>

          {scanning && (
            <div className="text-xs text-foreground-muted py-4 text-center">
              <span className="inline-block animate-pulse">Scanning {search.websiteUrl}...</span>
            </div>
          )}

          {scanError && (
            <div className="text-xs text-secondary border border-secondary/20 bg-secondary/5 px-3 py-2">
              {scanError}
            </div>
          )}

          {scanResults && scanResults.length === 0 && (
            <div className="text-xs text-foreground-dim py-3 text-center">
              No items matching &quot;{search.keyword}&quot; found on this page right now.
            </div>
          )}

          {scanResults && scanResults.length > 0 && (
            <div className="space-y-1.5">
              {scanResults.map((item, i) => (
                <div key={i} className={`flex items-center gap-3 px-3 py-2 border text-xs ${
                  item.isNew
                    ? 'bg-green-950/30 border-green-700/40'
                    : 'bg-surface-elevated/50 border-border/50'
                }`}>
                  {item.isNew && (
                    <span className="text-[9px] font-heading tracking-widest uppercase bg-green-600 text-white px-1.5 py-0.5 flex-shrink-0">
                      NEW
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground hover:text-accent transition-colors truncate block"
                    >
                      {item.title}
                    </a>
                  </div>
                  {item.price != null && (
                    <span className="text-accent font-heading flex-shrink-0">${item.price}</span>
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
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground-dim hover:text-blue-400 flex-shrink-0"
                    title="Open link"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeWidth="1.5" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                    </svg>
                  </a>
                </div>
              ))}
              <div className="flex items-center justify-between pt-1">
                <p className="text-[10px] text-foreground-dim">
                  {scanResults.length} item{scanResults.length !== 1 ? 's' : ''} on site
                  {scanMeta ? ` \u2014 ${scanMeta.totalDbMatches} in database` : ''}
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
