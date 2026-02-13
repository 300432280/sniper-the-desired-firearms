'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';

interface DebugEvent {
  id: number;
  timestamp: string;
  type: string;
  searchId?: string;
  keyword?: string;
  websiteUrl?: string;
  message: string;
  data?: unknown;
}

const TYPE_COLORS: Record<string, string> = {
  scrape_start: 'text-yellow-400 border-yellow-400/30 bg-yellow-400/5',
  scrape_done: 'text-blue-400 border-blue-400/30 bg-blue-400/5',
  scrape_fail: 'text-red-400 border-red-400/30 bg-red-400/5',
  matches_found: 'text-accent border-accent/30 bg-accent/5',
  email_sent: 'text-green-400 border-green-400/30 bg-green-400/5',
  email_failed: 'text-red-400 border-red-400/30 bg-red-400/5',
  sms_sent: 'text-green-400 border-green-400/30 bg-green-400/5',
  sms_failed: 'text-red-400 border-red-400/30 bg-red-400/5',
  job_completed: 'text-foreground-muted border-border bg-surface',
  job_failed: 'text-red-400 border-red-400/30 bg-red-400/5',
  search_created: 'text-accent border-accent/30 bg-accent/5',
  info: 'text-foreground-muted border-border bg-surface',
};

export default function AdminDebugPage() {
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const feedRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);

  // Keep ref in sync so SSE callback sees latest value
  pausedRef.current = paused;

  const toggleExpand = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;

    async function init() {
      // 1. Load history
      try {
        const res = await fetch('/api/admin/debug-log/history', { credentials: 'include' });
        if (res.status === 403) {
          setError('Access denied — admin only');
          return;
        }
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        setEvents(data.events || []);
      } catch {
        setError('Failed to load history');
        return;
      }

      // 2. Connect SSE
      es = new EventSource('/api/admin/debug-log', { withCredentials: true });

      es.onopen = () => setConnected(true);

      es.onmessage = (e) => {
        try {
          const event: DebugEvent = JSON.parse(e.data);
          setEvents((prev) => [...prev, event]);
        } catch {
          // Ignore parse errors (keepalive comments)
        }
      };

      es.onerror = () => {
        setConnected(false);
      };
    }

    init();

    return () => {
      es?.close();
    };
  }, []);

  // Auto-scroll when not paused
  useEffect(() => {
    if (!pausedRef.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events]);

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-CA', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
        <div className="card border border-secondary/30 text-center py-10">
          <p className="text-secondary text-lg font-heading tracking-widest">{error}</p>
          <Link href="/dashboard" className="btn-secondary mt-4 inline-block">Back to Dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <Link
            href="/dashboard"
            className="text-[10px] font-heading tracking-widest uppercase text-foreground-muted hover:text-foreground transition-colors flex items-center gap-2 mb-2"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
            </svg>
            Dashboard
          </Link>
          <h1 className="font-heading text-2xl tracking-wider">Debug Log</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 text-[10px] font-heading tracking-widest uppercase ${connected ? 'text-green-400' : 'text-red-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
            {connected ? 'Live' : 'Disconnected'}
          </span>
          <button
            onClick={() => setPaused((p) => !p)}
            className={`text-[10px] font-heading tracking-widest uppercase px-3 py-1.5 border transition-colors ${
              paused
                ? 'border-secondary text-secondary'
                : 'border-border text-foreground-muted hover:border-accent/30'
            }`}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={() => setEvents([])}
            className="text-[10px] font-heading tracking-widest uppercase px-3 py-1.5 border border-border text-foreground-muted hover:border-secondary/30 hover:text-secondary transition-colors"
          >
            Clear
          </button>
          <span className="text-[10px] text-foreground-dim font-mono">{events.length} events</span>
        </div>
      </div>

      {/* Feed */}
      <div
        ref={feedRef}
        className="border border-border bg-surface overflow-y-auto font-mono text-xs"
        style={{ height: 'calc(100vh - 180px)' }}
      >
        {events.length === 0 && (
          <div className="text-center py-16 text-foreground-muted">
            Waiting for events...
          </div>
        )}
        {events.map((evt) => {
          const colors = TYPE_COLORS[evt.type] || TYPE_COLORS.info;
          const hasData = evt.data && (Array.isArray(evt.data) ? evt.data.length > 0 : true);
          const isExpanded = expandedIds.has(evt.id);
          return (
            <div
              key={evt.id}
              className={`border-b border-border/50 px-3 py-2 hover:bg-surface-elevated/50 transition-colors`}
            >
              <div className="flex items-start gap-3">
                {/* Time */}
                <span className="text-foreground-dim flex-shrink-0 w-16">
                  {formatTime(evt.timestamp)}
                </span>

                {/* Type badge */}
                <span className={`inline-block px-1.5 py-0.5 border text-[9px] uppercase tracking-wider flex-shrink-0 w-28 text-center ${colors}`}>
                  {evt.type.replace(/_/g, ' ')}
                </span>

                {/* Message */}
                <div className="flex-1 min-w-0">
                  <span className="text-foreground">{evt.message}</span>
                  {evt.keyword && (
                    <span className="ml-2 text-accent">[{evt.keyword}]</span>
                  )}
                  {evt.websiteUrl && (
                    <span className="ml-2 text-foreground-dim truncate inline-block max-w-[200px] align-bottom">
                      {evt.websiteUrl}
                    </span>
                  )}
                </div>

                {/* Expand toggle */}
                {hasData && (
                  <button
                    onClick={() => toggleExpand(evt.id)}
                    className="text-foreground-muted hover:text-foreground flex-shrink-0 px-1"
                  >
                    {isExpanded ? '[-]' : '[+]'}
                  </button>
                )}
              </div>

              {/* Expanded data */}
              {hasData && isExpanded && (
                <div className="mt-2 ml-[7.5rem] pl-3 border-l border-border">
                  {Array.isArray(evt.data) ? (
                    (evt.data as Array<{ title: string; price?: number; url: string }>).map((item, i) => (
                      <div key={i} className="py-1">
                        <span className="text-foreground">{item.title}</span>
                        {item.price != null && (
                          <span className="text-accent ml-2">${item.price}</span>
                        )}
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-2 text-blue-400 hover:underline truncate inline-block max-w-[300px] align-bottom"
                        >
                          {item.url}
                        </a>
                      </div>
                    ))
                  ) : (
                    <pre className="text-foreground-dim whitespace-pre-wrap break-all">
                      {JSON.stringify(evt.data, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
