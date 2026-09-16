import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';

// Scoped to the hero + nav only via CSS variables (`variable` mode never
// touches the global font-family) — the rest of the landing page keeps
// its existing Satoshi/system-font stack from packages/ui/src/theme.css.
export const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});
