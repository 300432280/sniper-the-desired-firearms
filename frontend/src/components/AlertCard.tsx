'use client';

import { useState } from 'react';
import { Search } from '@/lib/api';

interface Props {
  search: Search;
  onToggle: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const INTERVAL_LABELS: Record<number, string> = {
  5: '5 min',
  30: '30 min',
  60: '1 hr',
};

const NOTIFY_LABELS: Record<string, string> = {
  EMAIL: 'Email',
  SMS: 'SMS',
  BOTH: 'Email + SMS',
};

export default function AlertCard({ search, onToggle, onDelete }: Props) {
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
        {/* Check interval */}
        <span className="flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" strokeWidth="1.5" />
            <path strokeLinecap="round" strokeWidth="1.5" d="M12 6v6l3.5 3.5" />
          </svg>
          {INTERVAL_LABELS[search.checkInterval] ?? `${search.checkInterval} min`}
        </span>

        {/* Notification type */}
        <span className="flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeWidth="1.5" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          {NOTIFY_LABELS[search.notificationType]}
        </span>

        {/* Match count */}
        {search._count !== undefined && (
          <span className={`flex items-center gap-1 ${search._count.matches > 0 ? 'text-accent' : ''}`}>
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeWidth="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            {search._count.matches} match{search._count.matches !== 1 ? 'es' : ''}
          </span>
        )}

        {/* Filters */}
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

        {/* Last checked — pushed right */}
        <span className="ml-auto">
          Checked: {lastChecked}
        </span>
      </div>
    </div>
  );
}
