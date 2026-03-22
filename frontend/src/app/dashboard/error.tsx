'use client';

export default function DashboardError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <h2 className="text-xl font-semibold text-red-400">Something went wrong</h2>
      <p className="text-sm text-foreground-dim">{error.message}</p>
      <button onClick={reset} className="px-4 py-2 bg-accent text-white rounded hover:opacity-90">
        Try again
      </button>
    </div>
  );
}
