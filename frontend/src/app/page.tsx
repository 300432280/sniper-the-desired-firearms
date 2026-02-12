import type { Metadata } from 'next';
import Link from 'next/link';
import GuestSearchForm from '@/components/GuestSearchForm';

export const metadata: Metadata = {
  title: 'FirearmAlert – Canadian Firearm Restock Alerts | Never Miss The Drop',
  description:
    'Monitor Canadian firearm retailers for SKS, AR-15, handguns, ammunition and more. Get instant email or SMS alerts when items restock. Free 24-hour monitoring — no account needed.',
  alternates: { canonical: 'https://firearm-alert.ca' },
};

const FAQ_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'How does FirearmAlert work?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'FirearmAlert continuously monitors Canadian firearm retailer websites for your specified keywords. When a matching product appears, you receive an instant email or SMS notification with the item name, price, and direct link.',
      },
    },
    {
      '@type': 'Question',
      name: 'Which Canadian firearm retailers does FirearmAlert support?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'FirearmAlert supports any publicly accessible Canadian retailer website including Ellwood Epps, Marstar Canada, Cabela\'s Canada, Wolverine Supplies, and more. Simply paste the URL of a search or category page.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is it free to use FirearmAlert?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes. Guest mode allows one free 24-hour alert via email with no account required. Create a free account for unlimited alerts, faster 5-minute checks, and SMS notifications.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is monitoring firearm listings legal in Canada?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'FirearmAlert monitors publicly available retail websites only. We are not affiliated with any retailer and do not facilitate sales. Users are responsible for complying with all applicable Canadian federal and provincial firearm laws.',
      },
    },
    {
      '@type': 'Question',
      name: 'How quickly will I be notified of a restock?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Guest alerts are checked every 30 minutes. Pro accounts can enable 5-minute check intervals for near real-time notifications.',
      },
    },
  ],
};

const ORG_SCHEMA = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'FirearmAlert',
  url: 'https://firearm-alert.ca',
  description: 'Canadian firearm restock alert and monitoring service',
  potentialAction: {
    '@type': 'SearchAction',
    target: 'https://firearm-alert.ca/alerts/{search_term}',
    'query-input': 'required name=search_term',
  },
};

const SEO_KEYWORDS = [
  'AR15 In Stock Canada',
  'SKS For Sale Canada',
  'Glock 19 Canada Restock',
  'Lee-Enfield Canada Alert',
  '9mm Ammo Canada',
  'Firearm Restock Alert',
  'Canadian Gun Shop Monitor',
  'Rifle In Stock Canada',
];

const FEATURES = [
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeWidth="1.5" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
    ),
    title: 'Instant Alerts',
    desc: 'Email and SMS notifications the moment your item appears. Guest mode checks every 30 min. Pro checks every 5 min.',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeWidth="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
    title: 'Monitor Any Site',
    desc: 'Paste any Canadian retailer URL. Works with Ellwood Epps, Marstar, Cabela\'s, Wolverine Supplies, and more.',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeWidth="1.5" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
      </svg>
    ),
    title: 'Smart Filters',
    desc: 'Filter by "In Stock Only" or set a maximum price. Only get notified when the deal actually matches your criteria.',
  },
  {
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeWidth="1.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
    title: 'Match History',
    desc: 'Track every item that matched your alert — with price, timestamp, and direct link to the listing.',
  },
];

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_SCHEMA) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ORG_SCHEMA) }}
      />

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative min-h-[calc(100vh-56px)] flex flex-col items-center justify-center px-4 py-20">
        {/* Accent glow */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-accent/5 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 text-center max-w-3xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 border border-accent/20 bg-accent-subtle px-3 py-1.5 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot" />
            <span className="text-[10px] font-heading tracking-[0.25em] text-accent uppercase">
              Live Monitoring Active
            </span>
          </div>

          <h1 className="font-heading text-5xl sm:text-6xl lg:text-7xl font-bold tracking-wider leading-none mb-6">
            Never Miss a{' '}
            <span className="text-accent">Restock</span>
          </h1>

          <p className="text-foreground-muted text-base sm:text-lg max-w-xl mx-auto leading-relaxed">
            Monitor Canadian firearms retailers for the items you want.
            Get instant alerts when AR-15s, SKS rifles, handguns, and ammunition come back in stock.
          </p>
        </div>

        {/* Guest form */}
        <div className="relative z-10 w-full max-w-lg">
          <GuestSearchForm />
        </div>

        {/* SEO keyword cloud */}
        <div className="relative z-10 mt-16 flex flex-wrap gap-2 justify-center max-w-2xl">
          {SEO_KEYWORDS.map((kw) => (
            <span
              key={kw}
              className="text-[10px] font-heading tracking-widest uppercase border border-border text-foreground-muted px-3 py-1"
            >
              {kw}
            </span>
          ))}
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section className="py-24 px-4 border-t border-border">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <p className="text-[10px] font-heading tracking-[0.3em] text-secondary uppercase mb-3">
              Why FirearmAlert
            </p>
            <h2 className="font-heading text-4xl tracking-wider">Built for Canadian Shooters</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px border border-border bg-border">
            {FEATURES.map((f, i) => (
              <div key={i} className="bg-background p-6 sm:p-8">
                <div className="text-accent mb-4">{f.icon}</div>
                <h3 className="font-heading text-lg tracking-wider mb-2">{f.title}</h3>
                <p className="text-sm text-foreground-muted leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How It Works ──────────────────────────────────────────────────── */}
      <section className="py-24 px-4 border-t border-border bg-surface">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-14">
            <p className="text-[10px] font-heading tracking-[0.3em] text-secondary uppercase mb-3">
              Simple & Fast
            </p>
            <h2 className="font-heading text-4xl tracking-wider">How It Works</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                n: '01',
                title: 'Enter Your Keyword',
                desc: 'Type the exact item you\'re hunting — model name, calibre, SKU, or any search term.',
              },
              {
                n: '02',
                title: 'Paste the Retailer URL',
                desc: 'Give us the URL of the product listing or search results page at your preferred Canadian retailer.',
              },
              {
                n: '03',
                title: 'Receive Your Alert',
                desc: 'We monitor the page and send you an email (or SMS for Pro) the moment your keyword appears.',
              },
            ].map((step) => (
              <div key={step.n} className="flex gap-5">
                <div className="flex-shrink-0 font-heading text-4xl font-bold text-secondary/30 leading-none pt-1">
                  {step.n}
                </div>
                <div>
                  <h3 className="font-heading text-xl tracking-wider mb-2">{step.title}</h3>
                  <p className="text-sm text-foreground-muted leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ────────────────────────────────────────────────────────── */}
      <section className="py-24 px-4 border-t border-border" id="pricing">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-14">
            <p className="text-[10px] font-heading tracking-[0.3em] text-secondary uppercase mb-3">
              Pricing
            </p>
            <h2 className="font-heading text-4xl tracking-wider">Simple. Transparent.</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-px border border-border bg-border">
            {/* Free */}
            <div className="bg-background p-8">
              <p className="text-[10px] font-heading tracking-[0.25em] text-foreground-muted uppercase mb-4">
                Free
              </p>
              <div className="font-heading text-5xl font-bold mb-1">$0</div>
              <p className="text-foreground-muted text-sm mb-8">No account needed.</p>
              <ul className="space-y-3 text-sm mb-8">
                {[
                  '1 active alert at a time',
                  '1 retailer URL',
                  '30-minute check interval',
                  '24-hour monitoring window',
                  'Email notification only',
                ].map((f) => (
                  <li key={f} className="flex items-center gap-3 text-foreground-muted">
                    <span className="text-accent text-xs">&#10003;</span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/" className="btn-secondary w-full block text-center">
                Start Free
              </Link>
            </div>

            {/* Pro */}
            <div className="bg-surface-elevated p-8 relative border-l border-accent/20">
              <div className="absolute top-4 right-4 text-[10px] font-heading tracking-[0.25em] uppercase bg-accent text-white px-2 py-0.5">
                Popular
              </div>
              <p className="text-[10px] font-heading tracking-[0.25em] text-accent uppercase mb-4">
                Pro
              </p>
              <div className="font-heading text-5xl font-bold mb-1">
                $14<span className="text-2xl text-foreground-muted">/mo</span>
              </div>
              <p className="text-foreground-muted text-sm mb-8">Cancel anytime.</p>
              <ul className="space-y-3 text-sm mb-8">
                {[
                  'Unlimited alerts',
                  'Unlimited retailer URLs',
                  '5-minute check intervals',
                  'Indefinite monitoring',
                  'Email + SMS notifications',
                  'Price filter & in-stock filter',
                  'Match history & analytics',
                ].map((f) => (
                  <li key={f} className="flex items-center gap-3 text-foreground">
                    <span className="text-accent text-xs">&#10003;</span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/register" className="btn-primary w-full block text-center">
                Get Pro Access
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────────────── */}
      <section className="py-24 px-4 border-t border-border bg-surface" id="faq">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-14">
            <p className="text-[10px] font-heading tracking-[0.3em] text-secondary uppercase mb-3">
              FAQ
            </p>
            <h2 className="font-heading text-4xl tracking-wider">Questions</h2>
          </div>

          <div className="space-y-px border border-border bg-border">
            {FAQ_SCHEMA.mainEntity.map((faq, i) => (
              <div key={i} className="bg-background p-6">
                <h3 className="font-heading text-base tracking-wide text-foreground mb-2">
                  {faq.name}
                </h3>
                <p className="text-sm text-foreground-muted leading-relaxed">
                  {faq.acceptedAnswer.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────────── */}
      <section className="py-24 px-4 border-t border-border text-center">
        <div className="max-w-2xl mx-auto">
          <p className="text-[10px] font-heading tracking-[0.3em] text-secondary uppercase mb-4">
            Ready to Monitor
          </p>
          <h2 className="font-heading text-4xl sm:text-5xl font-bold tracking-wider mb-6">
            Never Miss a Drop.
          </h2>
          <p className="text-foreground-muted mb-10">
            Start free — no account, no credit card. Upgrade to Pro for unlimited monitoring.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/register" className="btn-primary">
              Create Free Account
            </Link>
            <a href="#pricing" className="btn-secondary">
              View Pricing
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border py-10 px-4">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-foreground-muted">
          <div className="font-heading tracking-widest">
            <span className="text-accent">FIREARM</span>
            <span className="text-secondary">ALERT</span>
            <span className="ml-2 text-foreground-dim">CA</span>
          </div>
          <p className="text-center">
            Not affiliated with any retailer. For legal civilian use only.
            Users are responsible for compliance with Canadian firearm laws.
          </p>
          <div className="flex gap-4">
            <Link href="/alerts/ar15-canada" className="hover:text-foreground transition-colors">
              AR-15 Alerts
            </Link>
            <Link href="/alerts/sks-canada" className="hover:text-foreground transition-colors">
              SKS Alerts
            </Link>
          </div>
        </div>
      </footer>
    </>
  );
}
