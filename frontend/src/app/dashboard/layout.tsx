import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

// Server Component — reads httpOnly cookie to guard the dashboard.
// If no token cookie is present, redirect to /login immediately (no client-side flicker).
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = cookies();
  const token = cookieStore.get('token');

  if (!token?.value) {
    redirect('/login');
  }

  return (
    <div className="min-h-[calc(100vh-56px)]">
      {children}
    </div>
  );
}
