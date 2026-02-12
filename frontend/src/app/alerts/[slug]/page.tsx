import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import GuestSearchForm from '@/components/GuestSearchForm';

// ─── SEO slug map ─────────────────────────────────────────────────────────────
// Add more slugs here to expand topical authority for Google ranking.
const SLUG_MAP: Record<
  string,
  { keyword: string; title: string; description: string; h1: string; body: string }
> = {
  'ar15-canada': {
    keyword: 'AR-15',
    title: 'AR-15 In Stock Canada – Restock Alert | FirearmAlert',
    description:
      'Get instant email or SMS alerts when AR-15 rifles and parts come back in stock at Canadian retailers. Monitor Cabela\'s, Ellwood Epps, and more. Free 24-hour trial.',
    h1: 'AR-15 Restock Alerts Canada',
    body: 'AR-15 style rifles are among the most popular semi-automatic platforms in Canada. Finding one in stock at Canadian retailers can be challenging — inventory sells fast. FirearmAlert monitors your chosen retailer and notifies you the moment AR-15 rifles, lowers, uppers, or accessories appear.',
  },
  'sks-canada': {
    keyword: 'SKS',
    title: 'SKS For Sale Canada – Stock Alert | FirearmAlert',
    description:
      'Receive instant notifications when SKS rifles are listed at Canadian gun shops. Never miss a restock at Ellwood Epps, Marstar, or any Canadian retailer.',
    h1: 'SKS Rifle Restock Alerts Canada',
    body: 'The SKS is a beloved semi-automatic rifle among Canadian sport shooters and collectors. Demand often outpaces supply at Canadian retailers. Set up a FirearmAlert and be the first to know when SKS rifles, magazines, or accessories hit the shelves.',
  },
  'glock-canada': {
    keyword: 'Glock',
    title: 'Glock Handgun In Stock Canada – Alert | FirearmAlert',
    description:
      'Track Glock handgun availability at Canadian firearm dealers. Get email or SMS when Glock 17, 19, 43X and other models are back in stock.',
    h1: 'Glock Handgun Restock Alerts Canada',
    body: 'Glock handguns are among the most sought-after restricted firearms in Canada. Models like the Glock 17, 19, and 43X sell out quickly. FirearmAlert keeps watch 24/7 so you never miss your chance to purchase.',
  },
  'lee-enfield-canada': {
    keyword: 'Lee-Enfield',
    title: 'Lee-Enfield Rifle Canada – Restock Alert | FirearmAlert',
    description:
      'Get notified when Lee-Enfield rifles are listed by Canadian gun dealers. Monitor No.4 Mk1, Jungle Carbine, and other variants with FirearmAlert.',
    h1: 'Lee-Enfield Restock Alerts Canada',
    body: 'The Lee-Enfield is a classic bolt-action rifle with a rich history and strong collector following in Canada. Finding a well-priced example requires being in the right place at the right time. FirearmAlert monitors Canadian dealers and alerts you immediately when one lists.',
  },
  '9mm-ammo-canada': {
    keyword: '9mm ammo',
    title: '9mm Ammo In Stock Canada – Restock Alert | FirearmAlert',
    description:
      'Monitor Canadian retailers for 9mm ammunition restocks. Get instant notifications when 9mm 115gr, 124gr, or 147gr comes back in stock.',
    h1: '9mm Ammo Restock Alerts Canada',
    body: 'Ammunition availability in Canada can be unpredictable. FirearmAlert monitors retailers like Wolverine Supplies, Cabela\'s Canada, and more for 9mm restock events, so you can stock up before it sells out again.',
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface PageProps {
  params: { slug: string };
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const entry = SLUG_MAP[params.slug];
  if (!entry) return { title: 'Not Found' };

  return {
    title: entry.title,
    description: entry.description,
    alternates: { canonical: `https://firearm-alert.ca/alerts/${params.slug}` },
    openGraph: {
      title: entry.title,
      description: entry.description,
      url: `https://firearm-alert.ca/alerts/${params.slug}`,
    },
  };
}

// ─── Static params — pre-render all SEO pages at build time ──────────────────

export function generateStaticParams() {
  return Object.keys(SLUG_MAP).map((slug) => ({ slug }));
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AlertSlugPage({ params }: PageProps) {
  const entry = SLUG_MAP[params.slug];
  if (!entry) notFound();

  const PAGE_SCHEMA = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: entry.h1,
    description: entry.description,
    url: `https://firearm-alert.ca/alerts/${params.slug}`,
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://firearm-alert.ca' },
        { '@type': 'ListItem', position: 2, name: entry.h1, item: `https://firearm-alert.ca/alerts/${params.slug}` },
      ],
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(PAGE_SCHEMA) }}
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-xs text-foreground-muted mb-10" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-foreground transition-colors">Home</Link>
          <span>/</span>
          <span className="text-foreground">{entry.h1}</span>
        </nav>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
          {/* Left: content */}
          <div>
            <p className="text-[10px] font-heading tracking-[0.25em] text-secondary uppercase mb-4">
              Restock Alert
            </p>
            <h1 className="font-heading text-4xl sm:text-5xl font-bold tracking-wider mb-6">
              {entry.h1}
            </h1>
            <p className="text-foreground-muted text-base leading-relaxed mb-8">
              {entry.body}
            </p>

            {/* How it works mini-steps */}
            <div className="space-y-4 mb-8">
              {[
                'Enter your keyword (or use our pre-filled suggestion)',
                'Paste the retailer URL you want us to monitor',
                'We check every 30 minutes and email you immediately on a match',
              ].map((step, i) => (
                <div key={i} className="flex items-start gap-4">
                  <span className="flex-shrink-0 font-heading font-bold text-secondary/40 text-lg leading-none pt-0.5">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <p className="text-sm text-foreground-muted leading-relaxed">{step}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-3">
              <Link href="/register" className="btn-primary">
                Create Account (More Alerts)
              </Link>
              <Link href="/#pricing" className="btn-secondary">
                View Pro Plans
              </Link>
            </div>
          </div>

          {/* Right: form */}
          <div className="lg:sticky lg:top-20">
            <GuestSearchForm defaultKeyword={entry.keyword} />
          </div>
        </div>
      </div>
    </>
  );
}
