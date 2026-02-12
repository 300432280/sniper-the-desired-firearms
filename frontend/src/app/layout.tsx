import type { Metadata } from 'next';
import './globals.css';
import Navbar from '@/components/Navbar';

export const metadata: Metadata = {
  metadataBase: new URL('https://firearm-alert.ca'),
  title: {
    default: 'FirearmAlert – Canadian Firearm Restock Alerts',
    template: '%s | FirearmAlert Canada',
  },
  description:
    'Get instant email and SMS alerts when Canadian firearm retailers restock AR-15s, SKS rifles, handguns, and ammunition. Monitor any retailer. Never miss a drop.',
  keywords: [
    'firearm restock alert Canada',
    'AR15 in stock Canada',
    'SKS for sale Canada',
    'Canadian gun store stock alert',
    '9mm ammo in stock Canada',
    'rifle restock Canada alert',
    'handgun in stock Canada',
    'Canadian firearm availability tracker',
    'gun restock notification Canada',
    'firearm monitor Canada',
  ],
  authors: [{ name: 'FirearmAlert' }],
  openGraph: {
    type: 'website',
    siteName: 'FirearmAlert',
    locale: 'en_CA',
    title: 'FirearmAlert – Never Miss a Canadian Firearm Restock',
    description:
      'Real-time restock monitoring for Canadian firearm retailers. Email and SMS alerts when your target item drops.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FirearmAlert – Canadian Firearm Restock Alerts',
    description: 'Monitor any Canadian retailer. Get notified the moment your firearm is in stock.',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-CA">
      <body className="bg-background text-foreground font-body min-h-screen bg-grid">
        <Navbar />
        <main className="pt-14">{children}</main>
      </body>
    </html>
  );
}
