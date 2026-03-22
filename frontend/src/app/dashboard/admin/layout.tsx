'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi } from '@/lib/api';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    authApi.me().then(({ user }) => {
      if (user?.isAdmin) {
        setAuthorized(true);
      } else {
        setAuthorized(false);
        router.replace('/dashboard');
      }
    }).catch(() => {
      router.replace('/login');
    });
  }, [router]);

  if (authorized === null) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <span className="text-foreground-dim text-sm">Checking access...</span>
      </div>
    );
  }

  if (!authorized) return null;

  return <>{children}</>;
}
