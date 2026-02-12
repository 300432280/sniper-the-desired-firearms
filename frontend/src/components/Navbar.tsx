'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/hooks';

export default function Navbar() {
  const { user, loading, logout } = useAuth();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-sm border-b border-border">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        {/* Logo */}
        <Link
          href="/"
          className="font-heading font-bold text-xl tracking-[0.15em] flex items-center gap-1"
        >
          <span className="text-accent">FIREARM</span>
          <span className="text-secondary">ALERT</span>
          <span className="ml-2 text-[9px] font-body font-normal text-foreground-muted border border-border px-1.5 py-0.5 uppercase tracking-widest">
            CA
          </span>
        </Link>

        {/* Nav links */}
        <div className="flex items-center gap-3 sm:gap-4">
          {!loading && (
            <>
              {user ? (
                <>
                  <Link
                    href="/dashboard"
                    className="text-xs font-heading tracking-widest uppercase text-foreground-muted hover:text-foreground transition-colors"
                  >
                    Dashboard
                  </Link>
                  <button
                    onClick={logout}
                    className="btn-secondary text-xs py-1.5 px-4"
                  >
                    Logout
                  </button>
                </>
              ) : (
                <>
                  <Link
                    href="/login"
                    className="text-xs font-heading tracking-widest uppercase text-foreground-muted hover:text-foreground transition-colors"
                  >
                    Login
                  </Link>
                  <Link href="/register" className="btn-primary text-xs py-1.5 px-4">
                    Sign Up
                  </Link>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
