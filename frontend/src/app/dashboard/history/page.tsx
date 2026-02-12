'use client';

import { useState, useEffect } from 'react';
import { searchesApi, Match, Search } from '@/lib/api';
import Link from 'next/link';

export default function HistoryPage() {
  const [searches, setSearches] = useState<Search[]>([]);
  const [matches, setMatches] = useState<Record<string, Match[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    searchesApi
      .list()
      .then(async (data) => {
        setSearches(data.searches);
        // Load matches for searches that have some
        const searchesWithMatches = data.searches.filter(
          (s) => (s._count?.matches ?? 0) > 0
        );
        const results = await Promise.allSettled(
          searchesWithMatches.map((s) =>
            searchesApi.matches(s.id).then((d) => ({ id: s.id, matches: d.matches }))
          )
        );
        const matchMap: Record<string, Match[]> = {};
        results.forEach((r) => {
          if (r.status === 'fulfilled') {
            matchMap[r.value.id] = r.value.matches;
          }
        });
        setMatches(matchMap);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load history'))
      .finally(() => setLoading(false));
  }, []);

  const allMatches = Object.entries(matches).flatMap(([searchId, ms]) =>
    ms.map((m) => ({
      ...m,
      keyword: searches.find((s) => s.id === searchId)?.keyword ?? '',
    }))
  );

  allMatches.sort((a, b) => new Date(b.foundAt).getTime() - new Date(a.foundAt).getTime());

  const totalMatches = allMatches.length;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8">
        <Link
          href="/dashboard"
          className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted hover:text-foreground transition-colors flex items-center gap-2 mb-4"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
          Back to Dashboard
        </Link>
        <p className="text-[10px] font-heading tracking-[0.25em] text-secondary uppercase mb-1.5">
          Match History
        </p>
        <h1 className="font-heading text-4xl tracking-wider">
          All Matches{' '}
          {!loading && (
            <span className="text-foreground-muted text-2xl">({totalMatches})</span>
          )}
        </h1>
      </div>

      {error && (
        <div className="border border-danger/30 bg-danger-subtle text-secondary px-5 py-3 text-sm mb-6">
          {error}
        </div>
      )}

      {loading && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="card animate-pulse h-16 bg-surface-elevated" style={{ opacity: 1 - i * 0.15 }} />
          ))}
        </div>
      )}

      {!loading && totalMatches === 0 && (
        <div className="card border-dashed text-center py-16">
          <div className="text-foreground-dim text-4xl mb-4 font-heading">[ ]</div>
          <h2 className="font-heading text-2xl tracking-wider text-foreground-muted mb-3">
            No Matches Yet
          </h2>
          <p className="text-sm text-foreground-muted max-w-xs mx-auto">
            Matches will appear here when FirearmAlert finds your keywords on a monitored site.
          </p>
        </div>
      )}

      {!loading && totalMatches > 0 && (
        <div className="border border-border bg-border space-y-px">
          {/* Header row */}
          <div className="bg-surface-elevated px-5 py-2.5 grid grid-cols-12 gap-4 text-[10px] font-heading tracking-widest uppercase text-foreground-muted">
            <div className="col-span-1">Date</div>
            <div className="col-span-2">Keyword</div>
            <div className="col-span-6">Item</div>
            <div className="col-span-1 text-right">Price</div>
            <div className="col-span-2 text-right">Link</div>
          </div>

          {allMatches.map((match) => (
            <div
              key={match.id}
              className="bg-background px-5 py-3 grid grid-cols-12 gap-4 items-center text-sm hover:bg-surface transition-colors"
            >
              {/* Date */}
              <div className="col-span-1 text-[10px] font-mono text-foreground-muted whitespace-nowrap">
                {new Date(match.foundAt).toLocaleDateString('en-CA', {
                  month: 'short',
                  day: 'numeric',
                })}
                <br />
                {new Date(match.foundAt).toLocaleTimeString('en-CA', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>

              {/* Keyword */}
              <div className="col-span-2">
                <span className="text-[10px] font-heading tracking-wider uppercase border border-accent/20 text-accent px-1.5 py-0.5 truncate block max-w-full">
                  {match.keyword}
                </span>
              </div>

              {/* Title */}
              <div className="col-span-6 text-foreground text-xs truncate" title={match.title}>
                {match.title}
              </div>

              {/* Price */}
              <div className="col-span-1 text-right text-xs font-mono text-secondary">
                {match.price ? `$${match.price.toFixed(2)}` : '—'}
              </div>

              {/* Link */}
              <div className="col-span-2 text-right">
                <a
                  href={match.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-heading tracking-wider uppercase text-accent hover:underline border border-accent/20 px-2 py-0.5 transition-colors hover:bg-accent-subtle"
                >
                  View →
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
