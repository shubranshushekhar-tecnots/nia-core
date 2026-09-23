import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import '@fontsource/bricolage-grotesque/400.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import '@fontsource/schibsted-grotesk/600.css';
import '@fontsource/schibsted-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';

// Backs the app/auth `--font-display` token (packages/ui/src/theme.css),
// replacing Satoshi there. Exposed as a CSS variable rather than applied
// directly so the landing page's own --font-display (Bricolage Grotesque)
// is unaffected.
const geist = Geist({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-geist' });

export const metadata: Metadata = {
  title: 'Nia Core',
  description: 'Draw the ETL pipeline, schedule it, and wake up to dashboards that filled themselves.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body>{children}</body>
    </html>
  );
}
