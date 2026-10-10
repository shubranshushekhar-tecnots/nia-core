import type { Metadata, Viewport } from 'next';
import { Geist, Inter, Inter_Tight, Archivo } from 'next/font/google';
import { ThemeProvider } from 'next-themes';
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

// "Precision Dark" redesign fonts (designs/Nia Core — Precision Dark
// redesign.pdf) — Suisse Int'l isn't licensed yet, so these Google Fonts
// stand in for it (--nx-font-ui/--nx-font-condensed in theme.css list
// Suisse Intl first so it drops in later without another code change).
// Same `variable` pattern as `geist` above, so only the app shell's
// --nx-* scope picks these up, not the whole app.
const interTight = Inter_Tight({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-inter-tight' });
const inter = Inter({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-inter' });
// Condensed caps token (APPEARANCE label, sidebar/TopBar wordmark, etc.):
// weight 700–800, font-stretch 62.5% applied at the component call site,
// not here. Archivo IS a variable font on Google Fonts with a wdth axis
// (62-125) — `axes: ['wdth']` makes next/font fetch the variable file so
// font-stretch actually selects the condensed instance instead of the
// browser's synthetic (and much uglier) condensing fallback. next/font
// only allows `axes` when `weight` is 'variable' (or omitted) — discrete
// weight arrays force a static, non-variable instance. Call sites still
// set `fontWeight: 700`/`800` via plain CSS, which the variable font's
// own wght axis renders correctly.
const archivo = Archivo({ subsets: ['latin'], weight: 'variable', axes: ['wdth'], variable: '--font-archivo' });

// SITE_URL is the same env var auth.ts/agents/actions.ts already treat as
// this app's single source of truth for its public origin (see
// memory/MEMORY.md); falls back to the local dev port only so metadataBase
// still resolves to a valid URL when SITE_URL isn't set (e.g. a bare build).
const siteUrl = process.env.SITE_URL || 'http://localhost:3100';
const description =
  'Nia Core connects your databases (including on-premise SQL Server, via a secure agent) to the tools your team uses, safely and automatically.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    template: '%s · Nia Core',
    default: 'Nia Core · ETL for your business data, safely',
  },
  description,
  openGraph: {
    type: 'website',
    siteName: 'Nia Core',
    title: 'Nia Core · ETL for your business data, safely',
    description,
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'Nia Core' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Nia Core · ETL for your business data, safely',
    description,
    images: ['/og-image.png'],
  },
  manifest: '/site.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#131A26',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${interTight.variable} ${inter.variable} ${archivo.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider
          attribute="data-nx-theme"
          defaultTheme="dark"
          enableSystem
          storageKey="nia-theme"
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
