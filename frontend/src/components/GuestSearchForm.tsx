'use client';

import { useState } from 'react';
import { searchesApi } from '@/lib/api';

interface Props {
  defaultKeyword?: string;
}

export default function GuestSearchForm({ defaultKeyword = '' }: Props) {
  const [keyword, setKeyword] = useState(defaultKeyword);
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('loading');
    setErrorMsg('');
    try {
      await searchesApi.createGuest({ keyword, websiteUrl, notifyEmail: email });
      setStatus('success');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create alert');
      setStatus('error');
    }
  };

  if (status === 'success') {
    return (
      <div className="card border border-accent/30 text-center py-10 animate-fade-in">
        <div className="text-4xl text-accent mb-4 font-heading">&#10003;</div>
        <h3 className="font-heading text-2xl text-accent tracking-widest mb-3">
          Alert Active
        </h3>
        <p className="text-foreground-muted text-sm leading-relaxed max-w-sm mx-auto">
          Monitoring for{' '}
          <span className="text-foreground font-medium">&ldquo;{keyword}&rdquo;</span>{' '}
          every 30 minutes for 24 hours. Email notification goes to{' '}
          <span className="text-foreground font-medium">{email}</span>.
        </p>
        <div className="mt-8 pt-6 border-t border-border">
          <p className="text-xs text-foreground-muted mb-4">
            Need more? Create a free account for unlimited alerts + SMS.
          </p>
          <a href="/register" className="btn-primary">
            Create Free Account
          </a>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-5">
      <div>
        <h2 className="font-heading text-lg tracking-widest text-foreground mb-0.5">
          Free 24-Hour Alert
        </h2>
        <p className="text-xs text-foreground-muted">
          No account required &mdash; monitored every 30 min for 24 hrs.
        </p>
      </div>

      <div>
        <label className="label">Search Keyword</label>
        <input
          className="input-field"
          type="text"
          placeholder='e.g. SKS rifle, AR-15, 9mm ammo'
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
          className="input-field"
          type="url"
          placeholder="https://www.ellwoodepps.com/collections/rifles"
          value={websiteUrl}
          onChange={(e) => setWebsiteUrl(e.target.value)}
          required
        />
        <p className="mt-1 text-xs text-foreground-dim">
          Paste the URL of the search/category page, not the homepage.
        </p>
      </div>

      <div>
        <label className="label">Your Email for Notifications</label>
        <input
          className="input-field"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      {status === 'error' && (
        <p className="text-secondary text-sm border border-secondary/20 bg-secondary-subtle px-3 py-2">
          {errorMsg}
        </p>
      )}

      <button
        type="submit"
        disabled={status === 'loading'}
        className="btn-primary w-full text-sm"
      >
        {status === 'loading' ? (
          <span className="flex items-center gap-2">
            <span className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />
            Activating...
          </span>
        ) : (
          'Monitor For Free'
        )}
      </button>

      <p className="text-xs text-center text-foreground-dim">
        By using this service you agree to our{' '}
        <a href="/terms" className="text-foreground-muted hover:text-foreground underline">
          terms
        </a>
        . We are not affiliated with any retailer.
      </p>
    </form>
  );
}
