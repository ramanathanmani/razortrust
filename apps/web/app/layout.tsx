import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

import './globals.css';

export const metadata: Metadata = {
  title: 'RazorTrust Console',
  description: 'An AI agent can only pay for what a human actually approved',
};

/**
 * Dark is not a preference here, it is the design. The console commits to one
 * visual world rather than resolving a theme, so `dark` is stamped on <html>
 * and the palette in globals.css is the only one that exists.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh bg-background font-sans antialiased">{children}</body>
    </html>
  );
}
