'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { searchesApi } from '@/lib/api';
import { useAuth } from '@/lib/hooks';

export default function NewAlertPage() {
  const router = useRouter();
  const { user } = useAuth();

  const [keyword, setKeyword] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [checkInterval, setCheckInterval] = useState(30);
  const [notificationType, setNotificationType] = useState<'EMAIL' | 'SMS' | 'BOTH'>('EMAIL');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [maxPrice, setMaxPrice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const isPro = user?.tier === 'PRO';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await searchesApi.createAuth({
        keyword,
        websiteUrl,
        checkInterval,
        notificationType,
        inStockOnly,
        maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      });
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create alert');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
      {/* Header */}
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
          New Alert
        </p>
        <h1 className="font-heading text-4xl tracking-wider">Configure Alert</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">

        {/* Core fields */}
        <div className="card space-y-5">
          <h2 className="font-heading text-sm tracking-widest uppercase text-foreground-muted border-b border-border pb-3">
            Target
          </h2>

          <div>
            <label className="label">Search Keyword</label>
            <input
              type="text"
              className="input-field"
              placeholder='e.g. SKS rifle, AR-15 lower, 9mm 115gr'
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              required
              minLength={2}
              maxLength={100}
            />
          </div>

          <div>
            <label className="label">Retailer URL to Monitor</label>
            <input
              type="url"
              className="input-field"
              placeholder="https://www.ellwoodepps.com/collections/rifles"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              required
            />
            <p className="mt-1 text-xs text-foreground-dim">
              Use the URL of the search results or category page, not the homepage.
            </p>
          </div>
        </div>

        {/* Notification settings */}
        <div className="card space-y-5">
          <h2 className="font-heading text-sm tracking-widest uppercase text-foreground-muted border-b border-border pb-3">
            Notifications
          </h2>

          <div>
            <label className="label">Check Interval</label>
            <div className="grid grid-cols-3 gap-2">
              {([5, 30, 60] as const).map((interval) => {
                const locked = interval === 5 && !isPro;
                return (
                  <button
                    key={interval}
                    type="button"
                    disabled={locked}
                    onClick={() => !locked && setCheckInterval(interval)}
                    className={`py-2 text-sm font-heading tracking-wider uppercase border transition-colors
                      ${checkInterval === interval && !locked
                        ? 'border-accent bg-accent-subtle text-accent'
                        : 'border-border-strong text-foreground-muted hover:border-accent/30'
                      }
                      ${locked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                    `}
                  >
                    {interval === 5 ? '5 Min' : interval === 30 ? '30 Min' : '1 Hour'}
                    {locked && (
                      <span className="block text-[9px] tracking-widest text-foreground-dim normal-case mt-0.5">
                        Pro
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="label">Notify Via</label>
            <div className="grid grid-cols-3 gap-2">
              {(['EMAIL', 'SMS', 'BOTH'] as const).map((type) => {
                const locked = (type === 'SMS' || type === 'BOTH') && !isPro;
                return (
                  <button
                    key={type}
                    type="button"
                    disabled={locked}
                    onClick={() => !locked && setNotificationType(type)}
                    className={`py-2 text-sm font-heading tracking-wider uppercase border transition-colors
                      ${notificationType === type && !locked
                        ? 'border-accent bg-accent-subtle text-accent'
                        : 'border-border-strong text-foreground-muted hover:border-accent/30'
                      }
                      ${locked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                    `}
                  >
                    {type}
                    {locked && (
                      <span className="block text-[9px] tracking-widest text-foreground-dim normal-case mt-0.5">
                        Pro
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {(notificationType === 'SMS' || notificationType === 'BOTH') && !user?.phone && (
              <p className="mt-2 text-xs text-secondary">
                No phone number on file.{' '}
                <Link href="/dashboard/settings" className="underline hover:text-foreground">
                  Add one in settings
                </Link>
                .
              </p>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="card space-y-5">
          <h2 className="font-heading text-sm tracking-widest uppercase text-foreground-muted border-b border-border pb-3">
            Filters <span className="font-normal normal-case text-xs text-foreground-dim">(optional)</span>
          </h2>

          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-heading tracking-wider">In-Stock Only</div>
              <p className="text-xs text-foreground-muted">Only alert when item shows as available</p>
            </div>
            <button
              type="button"
              onClick={() => setInStockOnly((v) => !v)}
              className={`relative w-10 h-5 border transition-colors flex-shrink-0 ${
                inStockOnly ? 'bg-accent border-accent' : 'bg-surface-elevated border-border-strong'
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 bg-white transition-transform ${
                  inStockOnly ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <div>
            <label className="label">Maximum Price (CAD)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted text-sm font-mono">
                $
              </span>
              <input
                type="number"
                className="input-field pl-7"
                placeholder="e.g. 1500"
                min="0"
                step="0.01"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
              />
            </div>
            <p className="mt-1 text-xs text-foreground-dim">
              Leave empty to alert at any price.
            </p>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="border border-secondary/30 bg-secondary-subtle text-secondary px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* Submit */}
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="btn-primary flex-1"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />
                Creating...
              </span>
            ) : (
              'Create Alert'
            )}
          </button>
          <Link href="/dashboard" className="btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
