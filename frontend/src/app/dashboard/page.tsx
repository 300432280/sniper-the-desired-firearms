'use client';

import { useMemo } from 'react';
import { useSearches, useAuth } from '@/lib/hooks';
import AlertCard from '@/components/AlertCard';
import Link from 'next/link';
import type { Search } from '@/lib/api';

export interface SearchGroup {
  groupId: string;
  keyword: string;
  searches: Search[];
  isActive: boolean;
  totalMatches: number;
  siteCount: number;
  lastChecked: string | null;
  checkInterval: number;
  notificationType: string;
  inStockOnly: boolean;
  maxPrice: number | null;
  createdAt: string;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { searches, loading, error, refresh, toggleSearch, deleteSearch, toggleGroup, deleteGroup } = useSearches();

  // Group search-all alerts by searchAllGroupId, keep individual searches separate
  const { individualSearches, groups } = useMemo(() => {
    const groupMap = new Map<string, Search[]>();
    const individual: Search[] = [];

    for (const s of searches) {
      if (s.searchAllGroupId) {
        const list = groupMap.get(s.searchAllGroupId) || [];
        list.push(s);
        groupMap.set(s.searchAllGroupId, list);
      } else {
        individual.push(s);
      }
    }

    const groupList: SearchGroup[] = [];
    for (const [groupId, groupSearches] of groupMap) {
      const first = groupSearches[0];
      groupList.push({
        groupId,
        keyword: first.keyword,
        searches: groupSearches,
        isActive: groupSearches.some((s) => s.isActive),
        totalMatches: groupSearches.reduce((n, s) => n + (s._count?.matches ?? 0), 0),
        siteCount: groupSearches.length,
        lastChecked: groupSearches.reduce((latest: string | null, s) => {
          if (!s.lastChecked) return latest;
          if (!latest) return s.lastChecked;
          return s.lastChecked > latest ? s.lastChecked : latest;
        }, null),
        checkInterval: first.checkInterval,
        notificationType: first.notificationType,
        inStockOnly: first.inStockOnly,
        maxPrice: first.maxPrice ?? null,
        createdAt: first.createdAt,
      });
    }

    return { individualSearches: individual, groups: groupList };
  }, [searches]);

  const activeCount = individualSearches.filter((s) => s.isActive).length + groups.filter((g) => g.isActive).length;
  const totalMatches = individualSearches.reduce((n, s) => n + (s._count?.matches ?? 0), 0)
    + groups.reduce((n, g) => n + g.totalMatches, 0);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">

      {/* Page header */}
      <div className="flex items-start justify-between gap-4 mb-10">
        <div>
          <p className="text-[10px] font-heading tracking-[0.25em] text-secondary uppercase mb-1.5">
            Dashboard
          </p>
          <h1 className="font-heading text-4xl tracking-wider">
            Active Alerts
          </h1>
          {user && (
            <p className="text-xs text-foreground-muted mt-1">
              {user.email}
              {user.isAdmin && (
                <span className="ml-2 text-[9px] font-heading tracking-widest uppercase bg-orange-600 text-white px-1.5 py-0.5">
                  Admin
                </span>
              )}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {user?.isAdmin && (
            <a
              href="http://localhost:4000/test-page"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] font-heading uppercase tracking-wider px-4 py-2 border border-orange-500/30 text-orange-400 hover:bg-orange-500/10 transition-colors"
            >
              Test Store
            </a>
          )}
          <Link href="/dashboard/alerts/new" className="btn-primary">
            + New Alert
          </Link>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-px border border-border bg-border mb-8">
        {[
          { label: 'Monitoring', value: loading ? '\u2014' : `${activeCount} alert${activeCount !== 1 ? 's' : ''}` },
          { label: 'Items Found', value: loading ? '\u2014' : totalMatches },
        ].map((stat) => (
          <div key={stat.label} className="bg-surface px-5 py-4">
            <div className="font-heading text-2xl font-bold text-foreground">
              {stat.value}
            </div>
            <div className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted mt-0.5">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Pro upsell for FREE tier (hide for admin) */}
      {user?.tier === 'FREE' && !user?.isAdmin && (individualSearches.length > 0 || groups.length > 0) && (
        <div className="border border-accent/20 bg-accent-subtle px-5 py-3 flex items-center justify-between gap-4 mb-6">
          <p className="text-xs text-accent">
            <span className="font-heading font-semibold tracking-wider">Free plan:</span>{' '}
            Upgrade to Pro for 5-min checks, unlimited alerts, and SMS notifications.
          </p>
          <Link href="/#pricing" className="btn-primary text-xs py-1.5 px-4 flex-shrink-0">
            Upgrade
          </Link>
        </div>
      )}

      {/* Admin quick links */}
      {user?.isAdmin && (
        <div className="border border-orange-500/20 bg-orange-500/5 px-5 py-3 flex items-center gap-4 mb-6">
          <span className="text-[10px] font-heading tracking-widest uppercase text-orange-400">Admin Tools</span>
          <a href="http://localhost:4000/test-page" target="_blank" rel="noopener noreferrer" className="text-xs text-orange-300 hover:underline">
            Test Store
          </a>
          <Link href="/dashboard/admin/debug" className="text-xs text-orange-300 hover:underline">
            Debug Log
          </Link>
          <Link href="/dashboard/history" className="text-xs text-orange-300 hover:underline">
            Match History
          </Link>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="border border-danger/30 bg-danger-subtle text-secondary px-5 py-3 text-sm mb-6">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="card animate-pulse h-24 bg-surface-elevated"
              style={{ opacity: 1 - i * 0.2 }}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && individualSearches.length === 0 && groups.length === 0 && (
        <div className="card border-dashed text-center py-16">
          <div className="text-foreground-dim text-4xl mb-4 font-heading">[ ]</div>
          <h2 className="font-heading text-2xl tracking-wider text-foreground-muted mb-3">
            No Alerts Yet
          </h2>
          <p className="text-sm text-foreground-muted mb-8 max-w-sm mx-auto">
            Create your first alert to start monitoring Canadian retailers for the items you want.
          </p>
          <Link href="/dashboard/alerts/new" className="btn-primary">
            Create First Alert
          </Link>
        </div>
      )}

      {/* Alert list */}
      {!loading && (individualSearches.length > 0 || groups.length > 0) && (
        <div className="space-y-3">
          {groups.map((group) => (
            <AlertCard
              key={group.groupId}
              group={group}
              onToggleGroup={toggleGroup}
              onDeleteGroup={deleteGroup}
              onRefresh={refresh}
            />
          ))}
          {individualSearches.map((search) => (
            <AlertCard
              key={search.id}
              search={search}
              onToggle={toggleSearch}
              onDelete={deleteSearch}
              onRefresh={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}
