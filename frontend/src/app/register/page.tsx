'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authApi } from '@/lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await authApi.register({ email, password, phone: phone || undefined });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-56px)] flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 text-center">
          <p className="text-[10px] font-heading tracking-[0.25em] text-secondary uppercase mb-2">
            Create Account
          </p>
          <h1 className="font-heading text-4xl tracking-widest">Register</h1>
        </div>

        <div className="card space-y-5">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="label">Email Address</label>
              <input
                type="email"
                className="input-field"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div>
              <label className="label">Password</label>
              <input
                type="password"
                className="input-field"
                placeholder="Minimum 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>

            <div>
              <label className="label">
                Phone Number{' '}
                <span className="normal-case font-normal text-foreground-dim">
                  (optional — for SMS alerts)
                </span>
              </label>
              <input
                type="tel"
                className="input-field"
                placeholder="+1 (604) 555-0199"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
              />
              <p className="mt-1 text-xs text-foreground-dim">
                Add your number now to enable SMS notifications on Pro plan.
              </p>
            </div>

            {error && (
              <div className="text-secondary text-sm border border-secondary/20 bg-secondary-subtle px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />
                  Creating account...
                </span>
              ) : (
                'Create Account'
              )}
            </button>
          </form>

          <p className="text-xs text-foreground-dim text-center pt-2 border-t border-border leading-relaxed">
            By registering you agree that FirearmAlert is a notification service only.
            We are not affiliated with any retailer. You are responsible for compliance
            with all applicable Canadian firearm laws.
          </p>

          <div className="text-center">
            <p className="text-sm text-foreground-muted">
              Already have an account?{' '}
              <Link href="/login" className="text-accent hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
