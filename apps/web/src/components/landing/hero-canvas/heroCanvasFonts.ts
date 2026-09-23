import { Geist_Mono } from 'next/font/google';

// Geist Sans (previously `geistSans` here) was dropped: it only backed the
// hero h1/sub copy, which now uses the hairline font stack (hairline/
// styles.ts's `hlFontFamily`) to match the rest of the landing page — see
// HeroCanvasSection.tsx. Geist Mono stays: it's a deliberate monospace
// telemetry-readout accent (REEL/timestamp/rows-count chrome), a distinct
// category from body/heading text, not part of the font-consistency fix.
export const geistMono = Geist_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-hero-mono',
  display: 'swap',
});
