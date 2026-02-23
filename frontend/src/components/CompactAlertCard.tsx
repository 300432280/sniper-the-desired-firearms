'use client';

import type { Search } from '@/lib/api';
import type { SearchGroup } from '@/app/dashboard/page';

interface Props {
  search?: Search;
  group?: SearchGroup;
  isSelected: boolean;
  onClick: () => void;
}

export default function CompactAlertCard({ search, group, isSelected, onClick }: Props) {
  const isGroup = !!group;
  const keyword = isGroup ? group.keyword : search!.keyword;
  const isActive = isGroup ? group.isActive : search!.isActive;
  const matchCount = isGroup ? group.totalMatches : (search!._count?.matches ?? 0);
  const lastCheckedRaw = isGroup ? group.lastChecked : search!.lastChecked;

  const siteLabel = isGroup
    ? `${group.siteCount} sites`
    : (() => {
        try { return new URL(search!.websiteUrl).hostname.replace(/^www\./, ''); }
        catch { return search!.websiteUrl; }
      })();

  const lastChecked = lastCheckedRaw
    ? formatRelativeTime(new Date(lastCheckedRaw))
    : 'Pending';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border transition-all duration-150 ${
        isSelected
          ? 'border-accent bg-accent/5 border-l-2 border-l-accent'
          : 'border-border/50 hover:border-border hover:bg-surface-elevated/30 border-l-2 border-l-transparent'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`flex-shrink-0 ${isActive ? 'dot-active' : 'dot-paused'}`} />
        <h3 className="font-heading text-sm tracking-wide truncate flex-1">{keyword}</h3>
        {matchCount > 0 && (
          <span className="text-[10px] font-heading text-accent flex-shrink-0">
            {matchCount}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between pl-4.5 text-[10px] text-foreground-muted">
        <span className="flex items-center gap-1.5">
          {isGroup && (
            <span className="text-[9px] font-heading tracking-widest uppercase px-1 py-px border border-accent/30 text-accent">
              ALL
            </span>
          )}
          <span className="truncate">{siteLabel}</span>
        </span>
        <span className="flex-shrink-0">{lastChecked}</span>
      </div>
    </button>
  );
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);

  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
