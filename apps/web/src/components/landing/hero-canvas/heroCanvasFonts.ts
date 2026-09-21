import { Geist, Geist_Mono } from 'next/font/google';

// Scoped to this hero only via CSS variables (`variable` mode never touches
// the global font-family) — root layout.tsx already loads Geist at weights
// 400/500/700 for --font-geist (app/auth display token), but this hero also
// needs weight 300 for the h1, so it gets its own scoped instance rather
// than widening the global one.
export const geistSans = Geist({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  variable: '--font-hero-sans',
  display: 'swap',
});

export const geistMono = Geist_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-hero-mono',
  display: 'swap',
});
