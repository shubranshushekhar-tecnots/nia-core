# Landing Page — Build Context

Read-only research report. Scope: `apps/web` landing page
(`apps/web/src/app/page.tsx` → `apps/web/src/components/landing/**`).
Purpose: give a new contributor everything needed to add a landing-page
section that matches existing conventions exactly.

---

## 1. Stack

- **Framework:** Next.js `^15.0.3`, App Router (`apps/web/src/app/`).
- **Language:** TypeScript `^5.6.3` throughout, no `.js`/`.jsx` in `src`.
- **React:** `^18.3.1` / `react-dom` `^18.3.1`.
- **Package manager:** pnpm, workspace root pinned to `packageManager: pnpm@9.12.0`
  (root `package.json`). Turborepo (`turbo ^2.3.3`) drives `dev`/`build`/
  `typecheck`/`test`/`lint` across the monorepo.
- **Monorepo layout:** `pnpm-workspace.yaml` → `apps/*`, `services/*`, `packages/*`.

**`apps/web/package.json` — full deps/devDeps:**

```json
{
  "dependencies": {
    "@fontsource/bricolage-grotesque": "^5.3.0",
    "@fontsource/jetbrains-mono": "^5.3.0",
    "@fontsource/schibsted-grotesk": "^5.3.0",
    "@nia/schemas": "workspace:*",
    "@nia/ui": "workspace:*",
    "@supabase/ssr": "^0.5.2",
    "@supabase/supabase-js": "^2.46.1",
    "@tanstack/react-query": "^5.103.0",
    "@xyflow/react": "^12.11.6",
    "next": "^15.0.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "simple-icons": "^16.31.0",
    "zod": "^3.23.8",
    "zustand": "^5.0.1"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.2",
    "@types/node": "^22.9.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "autoprefixer": "^10.4.20",
    "bullmq": "^5.28.0",
    "dotenv": "^16.4.5",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3",
    "vitest": "^5.0.0"
  }
}
```

Notably **no `framer-motion`, no CSS-in-JS library, no `next/image` use in
landing** — see §7/§8.

---

## 2. Styling system

**Inline `CSSProperties` objects, not Tailwind classes** — even though
Tailwind is installed and configured (see §11 "gotcha"). There is no
CSS-modules, styled-components, or class-name-driven styling in any landing
component; every style is a JS object passed to `style={...}`.

`apps/web/tailwind.config.ts` (full):

```ts
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        subtle: 'var(--subtle)',
        text: 'var(--text)',
        secondary: 'var(--secondary)',
        muted: 'var(--muted)',
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          soft: 'var(--primary-soft)',
        },
        line: {
          DEFAULT: 'var(--line)',
          strong: 'var(--line-strong)',
        },
        success: { DEFAULT: 'var(--success)', deep: 'var(--success-deep)' },
        warning: { DEFAULT: 'var(--warning)', deep: 'var(--warning-deep)' },
        error: { DEFAULT: 'var(--error)', deep: 'var(--error-deep)' },
        'c-trigger': 'var(--c-trigger)',
        'c-action': 'var(--c-action)',
        'c-condition': 'var(--c-condition)',
        'c-data': 'var(--c-data)',
        'c-ai': 'var(--c-ai)',
      },
      fontFamily: {
        sans: ['Satoshi', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
```

`apps/web/postcss.config.mjs` (full):

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

`apps/web/src/app/globals.css` (full — 5 lines):

```css
@import '@nia/ui/theme.css';

@tailwind base;
@tailwind components;
@tailwind utilities;
```

The **real global stylesheet is `packages/ui/src/theme.css`** (429 lines,
pasted in full below). It carries every design token, `@font-face`,
keyframe and the `.reveal` scroll-reveal utility.

`packages/ui/src/theme.css` (full):

```css
/* ============================================================
   Nia Core — theme layer
   Extracted verbatim from designs/*.html (Bundled Page exports).
   Do not hand-edit values by eye — re-extract from the source
   design file if a value needs to change.
   ============================================================ */

/* ------------------------------------------------------------
   Satoshi @font-face
   ------------------------------------------------------------ */
@font-face {
  font-family: 'Satoshi';
  src: url('/fonts/satoshi/satoshi-400.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Satoshi';
  src: url('/fonts/satoshi/satoshi-500.woff2') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Satoshi';
  src: url('/fonts/satoshi/satoshi-700.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Satoshi';
  src: url('/fonts/satoshi/satoshi-900.woff2') format('woff2');
  font-weight: 900;
  font-style: normal;
  font-display: swap;
}

/* ------------------------------------------------------------
   Nia Core Landing.html — :root tokens (light, landing-only)
   ------------------------------------------------------------ */
:root {
  --bg: #F8FAFC;
  --surface: #FFFFFF;
  --subtle: #F1F5F9;

  --text: #0F172A;
  --secondary: #475569;
  --muted: #94A3B8;

  --primary: #4F46E5;
  --primary-hover: #4338CA;
  --primary-soft: #EEF2FF;

  --line: #E2E8F0;
  --line-strong: #CBD5E1;

  --success: #10B981;
  --success-deep: #047857;
  --warning: #F59E0B;
  --warning-deep: #B45309;
  --error: #EF4444;
  --error-deep: #B91C1C;

  --c-trigger: #4F46E5;
  --c-action: #2563EB;
  --c-condition: #7C3AED;
  --c-data: #0891B2;
  --c-ai: #6366F1;
  --c-pink: #DB2777; /* marketing accent, ties Features.tsx aura colors to Hero */

  --flow: #C7D2FE;
  --packet: #6366F1;
}

/* [data-app-theme] — dark navy/rust default, light override with
   [data-app-theme][data-om-theme='light'] — app shell only, NOT used by
   the landing page. See full file for all ~30 tokens
   (--font-display: 'Bricolage Grotesque', --font-ui: 'Schibsted Grotesk',
   --font-data: 'JetBrains Mono', workflow canvas tokens, etc). */

/* [data-auth-theme] / [data-auth-theme][data-om-theme='dark'] — light
   indigo-accented auth screens, separate scope from both landing and app
   shell. */

/* ------------------------------------------------------------
   Nia Core Landing.html — base element styles
   ------------------------------------------------------------ */
html, body {
  margin: 0;
  overflow-x: clip;
  background: var(--bg);
  color: var(--text);
  font-family: 'Satoshi', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.01em;
}
[hidden] { display: none !important; }
a { color: inherit; text-decoration: none; }
button, a { font-family: inherit; }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

/* ------------------------------------------------------------
   Nia Core Landing.html — keyframes
   ------------------------------------------------------------ */
@keyframes popIn { 0% { opacity: 0; transform: translateY(14px) scale(.96); } 100% { opacity: 1; transform: none; } }
@keyframes riseIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@keyframes floatA { 0%, 100% { transform: translateY(-7px) rotate(-1.1deg); } 50% { transform: translateY(7px) rotate(-1.1deg); } }
@keyframes floatB { 0%, 100% { transform: translateY(6px) rotate(1.3deg); } 50% { transform: translateY(-6px) rotate(1.3deg); } }
@keyframes floatC { 0%, 100% { transform: translateY(-5px) rotate(.8deg); } 50% { transform: translateY(8px) rotate(.8deg); } }
@keyframes floatD { 0%, 100% { transform: translateY(8px) rotate(-.7deg); } 50% { transform: translateY(-6px) rotate(-.7deg); } }
@keyframes edgeFlow { to { stroke-dashoffset: -64; } }
@keyframes orbitk {
  from { transform: rotate(var(--a)) translateY(var(--r)) rotate(calc(-1 * var(--a))); }
  to { transform: rotate(calc(var(--a) + 360deg)) translateY(var(--r)) rotate(calc(-1 * (var(--a) + 360deg))); }
}

/* ------------------------------------------------------------
   Nia Core Landing.html — component base styles
   ------------------------------------------------------------ */
.otile {
  position: absolute;
  left: 50%;
  top: 50%;
  margin: -29px 0 0 -29px;
  width: 58px;
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 10px 24px -16px rgba(15, 23, 42, .5);
  font-size: 12px;
  font-weight: 700;
  transform: rotate(var(--a)) translateY(var(--r)) rotate(calc(-1 * var(--a)));
  animation: orbitk var(--dur) linear infinite;
}

.reveal { transition: opacity .6s cubic-bezier(.2, .7, .2, 1), transform .6s cubic-bezier(.2, .7, .2, 1); }
body.armed .reveal { opacity: 0; transform: translateY(18px); }
body.armed .reveal.in { opacity: 1; transform: none; }

@media (max-width: 1200px) { .orings { transform: scale(.82); } }
@media (max-width: 960px) { .orings { transform: scale(.62); } }
@media (max-width: 1100px) { .floatcard { display: none !important; } }
@media (max-width: 660px) { .orings { display: none; } }
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  .reveal { opacity: 1 !important; transform: none !important; }
}
```

(The `[data-app-theme]`/`[data-auth-theme]` blocks — ~150 lines of
app-shell/auth-only tokens — are trimmed above since a new *landing*
section will only ever read the bare `:root` tokens. They exist in the
real file if needed for reference.)

**Design tokens available to landing components** (bare `:root`, all in
theme.css above): `--bg`, `--surface`, `--subtle`, `--text`, `--secondary`,
`--muted`, `--primary` (+`-hover`/`-soft`), `--line` (+`-strong`),
`--success`/`--warning`/`--error` (+`-deep`), `--c-trigger`/`--c-action`/
`--c-condition`/`--c-data`/`--c-ai`/`--c-pink`.

**Dark mode:** Landing page is **light-only**, no toggle. (Auth and app
shell have `data-om-theme="light"|"dark"` toggles, unrelated to landing.)
The one exception is the hero: it's visually a "dark island" — `Nav`
imperatively flips `--nav-bg`/`--nav-fg` custom properties via a scroll
handler in `LandingPage.tsx` while the hero is on screen, not via a theme
attribute.

---

## 3. Fonts

Three separate font layers, each scoped via CSS-variable mode (never
applied globally via `className` except at the point of use):

1. **`apps/web/src/app/layout.tsx`** (root layout) loads Geist via
   `next/font/google` as `--font-geist` (backs app/auth `--font-display`,
   irrelevant to landing) plus imports `@fontsource/*` CSS for
   Bricolage Grotesque / Schibsted Grotesk / JetBrains Mono (app-shell
   fonts, not used on landing markup).
2. **Satoshi** — self-hosted, wired via `@font-face` in `theme.css` (see
   §2). This is the *default* body font for the whole app (`html, body {
   font-family: 'Satoshi', ... }`), so any landing text that doesn't
   opt into a different font falls back to Satoshi.
3. **`apps/web/src/components/landing/heroFonts.ts`** (full):

```ts
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
```

Usage: `Nav.tsx` applies `className={plexSans.variable}` on the `<nav>`
element, then references `fontFamily: 'var(--font-plex-sans)'` in its own
inline style. Other landing sections (Features, Pricing, etc.) use no
explicit `fontFamily` — they inherit Satoshi from `html, body`.

There's also `hero-canvas/heroCanvasFonts.ts` (Geist/Geist Mono, scoped to
just the hero canvas chrome overlay) — not relevant outside that subtree.

---

## 4. Page structure

**`apps/web/src/app/page.tsx`** (full — renders "/"):

```tsx
import LandingPage from '@/components/landing/LandingPage';

export default function Page() {
  return <LandingPage />;
}
```

**`apps/web/src/components/landing/LandingPage.tsx`** (full — the actual
composition root):

```tsx
'use client';

import { useEffect, useRef } from 'react';
import Nav, { NAV_HEIGHT } from './Nav';
import HeroCanvasSection from './hero-canvas/HeroCanvasSection';
import TrustedBy from './TrustedBy';
import Features from './Features';
import ConnectorsOrbit from './ConnectorsOrbit';
import TypeChips from './TypeChips';
import Stats from './Stats';
import Pricing from './Pricing';
import CtaBand from './CtaBand';
import Footer from './Footer';

export default function LandingPage() {
  const navRef = useRef<HTMLElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const bandRef = useRef<HTMLElement>(null);
  const footRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if ('IntersectionObserver' in window && !reduce) {
      document.body.classList.add('armed');
    }

    const onScroll = () => {
      const nav = navRef.current;
      if (!nav) return;

      const heroEl = heroRef.current;
      const heroRect = heroEl?.getBoundingClientRect();
      const pastHero = (heroRect?.bottom ?? -Infinity) <= NAV_HEIGHT;
      const pinned = !pastHero && heroEl?.dataset.heroPinned === 'true';
      const darkIsland = !pastHero;

      document.documentElement.style.backgroundColor = darkIsland ? '#000000' : '';

      nav.style.setProperty('--nav-bg', pastHero ? 'rgba(248,250,252,.82)' : pinned ? '#000000' : 'transparent');
      nav.style.setProperty('--nav-blur', pastHero ? 'blur(12px)' : 'none');
      nav.style.borderBottomColor = pastHero ? 'var(--line)' : 'transparent';
      nav.style.boxShadow = pastHero ? '0 10px 30px -24px rgba(15,23,42,.5)' : 'none';
      if (darkIsland) {
        nav.style.setProperty('--nav-fg', '#FFFFFF');
      } else {
        nav.style.removeProperty('--nav-fg');
      }
      if (reduce) return;

      const band = bandRef.current;
      const foot = footRef.current;
      if (band && foot) {
        const r = band.getBoundingClientRect();
        const vh = window.innerHeight || 1;
        const q = Math.max(0, Math.min(1, (vh - r.bottom) / (vh * 0.6)));
        const e2 = q * q * (3 - 2 * q);
        band.style.transform = `perspective(1200px) scale(${1 - e2 * 0.12}) translateY(${-e2 * 54}px) rotateX(${e2 * 6}deg)`;
        band.style.opacity = String(1 - e2 * 0.7);
        band.style.filter = `blur(${(e2 * 4).toFixed(2)}px)`;
        foot.style.transform = `translateY(${-e2 * 36}px)`;
        foot.style.borderTopLeftRadius = foot.style.borderTopRightRadius = `${36 - e2 * 22}px`;
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      document.documentElement.style.backgroundColor = '';
    };
  }, []);

  return (
    <div style={{ width: '100%', minHeight: '100vh', boxSizing: 'border-box', background: 'var(--bg)' }}>
      <Nav navRef={navRef} />
      <HeroCanvasSection heroRef={heroRef} />
      <TrustedBy />
      <Features />
      <ConnectorsOrbit />
      <TypeChips />
      <Stats />
      <Pricing />
      <CtaBand bandRef={bandRef} />
      <Footer footRef={footRef} />
    </div>
  );
}
```

**Section render order (top → bottom of `/`):**

| # | Component | File |
|---|---|---|
| 1 | `Nav` | `apps/web/src/components/landing/Nav.tsx` |
| 2 | `HeroCanvasSection` | `apps/web/src/components/landing/hero-canvas/HeroCanvasSection.tsx` |
| 3 | `TrustedBy` | `apps/web/src/components/landing/TrustedBy.tsx` |
| 4 | `Features` | `apps/web/src/components/landing/Features.tsx` |
| 5 | `ConnectorsOrbit` | `apps/web/src/components/landing/ConnectorsOrbit.tsx` |
| 6 | `TypeChips` | `apps/web/src/components/landing/TypeChips.tsx` |
| 7 | `Stats` | `apps/web/src/components/landing/Stats.tsx` |
| 8 | `Pricing` | `apps/web/src/components/landing/Pricing.tsx` |
| 9 | `CtaBand` | `apps/web/src/components/landing/CtaBand.tsx` |
| 10 | `Footer` | `apps/web/src/components/landing/Footer.tsx` |

**`Features.tsx`** — the three-card section ("A canvas that runs" /
"Every source, one grid" / "AI on the canvas") — full source, this is the
primary style reference:

```tsx
'use client';

import { useState } from 'react';
import type { CSSProperties } from 'react';
import Reveal from './Reveal';

const FEATURES = [
  { num: '01', key: 'a', aura: '#A5F3FC', title: 'A canvas that runs', body: 'Drag sources, transforms and destinations onto a grid, connect them, and press run. No YAML, no cron files.' },
  { num: '02', key: 'b', aura: '#DDD6FE', title: 'Every source, one grid', body: 'Databases, warehouses, files and BI tools connect once and appear as reusable handles in every pipeline.' },
  { num: '03', key: 'c', aura: '#FBCFE8', title: 'AI on the canvas', body: 'Ask for a pipeline in words, or drop an AI step in to classify and extract fields mid-flow.' },
] as const;

const ART: Record<string, CSSProperties[]> = {
  a: [0, 1, 2, 3, 4].map((i) => ({
    position: 'absolute',
    right: 4 + i * 16,
    top: 14 + i * 4,
    width: 52,
    height: 104,
    borderRadius: 12,
    transform: 'skewY(-10deg)',
    background: 'linear-gradient(160deg,rgba(165,243,252,.85),rgba(199,210,254,.82),rgba(251,207,232,.85))',
    filter: `hue-rotate(${-70 + i * 35}deg)`,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9),0 8px 18px -10px rgba(79,70,229,.5)',
  })),
  b: [
    {
      position: 'absolute',
      right: 26,
      top: 24,
      width: 96,
      height: 124,
      borderRadius: 12,
      transform: 'rotate(-9deg)',
      background: 'linear-gradient(165deg,#FFFFFF,#EDE9FE)',
      boxShadow: '0 14px 26px -16px rgba(15,23,42,.4),inset 0 14px 0 -12px rgba(148,163,184,.35),inset 0 30px 0 -28px rgba(148,163,184,.3)',
    },
  ],
  c: [
    {
      position: 'absolute',
      right: 22,
      top: 26,
      width: 112,
      height: 112,
      borderRadius: '50%',
      background: 'radial-gradient(circle at 32% 28%,#FFFFFF,#FBCFE8 34%,#C7D2FE 62%,#A7F3D0 100%)',
      boxShadow: 'inset -8px -10px 22px rgba(79,70,229,.28),0 16px 30px -14px rgba(124,58,237,.5)',
    },
    { position: 'absolute', right: 8, top: 14, width: 12, height: 12, borderRadius: '50%', background: 'linear-gradient(160deg,#C7D2FE,#A7F3D0)' },
    { position: 'absolute', right: 132, top: 112, width: 10, height: 10, borderRadius: '50%', background: 'linear-gradient(160deg,#FBCFE8,#C7D2FE)' },
  ],
};

export default function Features() {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <section id="product" style={{ maxWidth: 1180, margin: '0 auto', boxSizing: 'border-box', padding: '74px 24px 0' }}>
      <Reveal as="h2" style={{ margin: '0 0 26px', maxWidth: 600, fontSize: 'clamp(28px,4vw,38px)', fontWeight: 700, letterSpacing: '-.03em' }}>
        Pipelines you draw, not scripts you babysit
      </Reveal>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 18 }}>
        {FEATURES.map((f) => {
          const hov = hovered === f.key;
          return (
            <Reveal
              key={f.key}
              onMouseEnter={() => setHovered(f.key)}
              onMouseLeave={() => setHovered((cur) => (cur === f.key ? null : cur))}
              style={{
                position: 'relative',
                overflow: 'hidden',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 290,
                padding: '24px 22px',
                borderRadius: 20,
                background: 'linear-gradient(165deg,rgba(255,255,255,.75),rgba(255,255,255,.55))',
                backdropFilter: 'blur(14px) saturate(1.5)',
                WebkitBackdropFilter: 'blur(14px) saturate(1.5)',
                border: '1px solid rgba(255,255,255,.85)',
                outline: '1px solid rgba(203,213,225,.5)',
                boxShadow: `0 2px 6px rgba(15,23,42,.05),${hov ? '0 26px 48px -20px rgba(79,70,229,.3)' : '0 16px 36px -20px rgba(79,70,229,.2)'}`,
                transform: `translateY(${hov ? -4 : 0}px)`,
                transition: 'transform .22s cubic-bezier(.2,.7,.2,1), box-shadow .22s ease',
              }}
            >
              <span aria-hidden="true" style={{ position: 'absolute', right: -70, top: -80, width: 280, height: 280, borderRadius: '50%', background: `radial-gradient(circle,${f.aura},transparent 70%)`, opacity: 0.5, pointerEvents: 'none' }} />
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  right: -6,
                  bottom: -10,
                  width: 170,
                  height: 170,
                  pointerEvents: 'none',
                  transform: `scale(${hov ? 1.04 : 1})`,
                  transition: 'transform .24s cubic-bezier(.2,.7,.2,1)',
                }}
              >
                {ART[f.key]!.map((pieceStyle, i) => (
                  <span key={i} style={pieceStyle} />
                ))}
              </span>
              <span style={{ position: 'relative', fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>{f.num}</span>
              <span style={{ position: 'relative', marginTop: 8, fontSize: 19, fontWeight: 700, letterSpacing: '-.02em' }}>{f.title}</span>
              <span style={{ position: 'relative', marginTop: 8, maxWidth: '24ch', fontSize: 13.5, lineHeight: 1.6, color: 'var(--secondary)' }}>{f.body}</span>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}
```

**`Nav.tsx`** — second representative section, chosen because it shows the
"colocated `<style>` tag for hover pseudo-classes" pattern (inline
`CSSProperties` can't express `:hover`, so this is the escape hatch used
project-wide) plus the CSS-variable-driven theme-sweep pattern:

```tsx
import type { RefObject } from 'react';
import Logo from '@/components/Logo';
import { plexSans } from './heroFonts';

export const NAV_HEIGHT = 79;

export default function Nav({ navRef }: { navRef: RefObject<HTMLElement> }) {
  return (
    <nav
      ref={navRef}
      className={plexSans.variable}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        boxSizing: 'border-box',
        marginBottom: -NAV_HEIGHT,
        padding: '22px clamp(20px,4vw,56px)',
        background: 'var(--nav-bg, transparent)',
        backdropFilter: 'var(--nav-blur, none)',
        WebkitBackdropFilter: 'var(--nav-blur, none)',
        borderBottom: '1px solid transparent',
        transition: 'background .2s ease, backdrop-filter .2s ease, border-color .2s ease, box-shadow .2s ease',
        fontFamily: 'var(--font-plex-sans)',
      }}
    >
      <div
        style={{
          maxWidth: 1440,
          margin: '0 auto',
          boxSizing: 'border-box',
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <div className="nia-nav-logo" style={{ display: 'flex', alignItems: 'center' }}>
          <Logo size={26} wordmarkColor="var(--nav-fg, var(--text))" />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
          <a href="#product" className="nia-nav-link" style={navLinkStyle}>Product</a>
          <a href="#pricing" className="nia-nav-link" style={navLinkStyle}>Pricing</a>
          <a href="#connectors" className="nia-nav-link" style={navLinkStyle}>Docs</a>
          <a href="#stats" className="nia-nav-link" style={navLinkStyle}>Changelog</a>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 16 }}>
          <a href="/login" className="nia-nav-link" style={navLinkStyle}>Sign in</a>
          <a
            href="/signup"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 34,
              padding: '0 15px',
              borderRadius: 8,
              fontSize: 13.5,
              fontWeight: 600,
              color: '#07090c',
              background: '#e8ecf1',
            }}
          >
            Start free
          </a>
        </div>
      </div>

      <style>{`
        .nia-nav-link { color: var(--nav-fg, var(--secondary)); transition: color .2s ease; }
        .nia-nav-link:hover { color: var(--nav-fg, var(--text)); }
        .nia-nav-logo * { transition: color .2s ease; }
      `}</style>
    </nav>
  );
}

const navLinkStyle = {
  fontSize: 14.5,
  fontWeight: 500,
  textDecoration: 'none',
} as const;
```

---

## 5. Component conventions

**Directory layout** (`apps/web/src/components/landing/`):

```
landing/
├── ConnectorsOrbit.tsx
├── CountUp.tsx
├── CtaBand.tsx
├── Features.tsx
├── Footer.tsx
├── Hero.tsx
├── HeroDiagram.tsx
├── LandingPage.tsx
├── Nav.tsx
├── Pricing.tsx
├── Reveal.tsx
├── Stats.tsx
├── TrustedBy.tsx
├── TypeChips.tsx
├── heroFonts.ts
├── styles.ts
└── hero-canvas/
    ├── HeroCanvasLayer.tsx
    ├── HeroCanvasSection.tsx
    ├── NodeCard.tsx
    ├── bezier.ts
    ├── config.ts
    ├── heroCanvasFonts.ts
    ├── icons.tsx
    ├── useHeroApproachProgress.ts
    └── useHeroScrollProgress.ts
```

**Naming:** PascalCase `.tsx` for components (`Features.tsx`, one
`export default function Features()` per file, matching the file name).
Lowercase-camelCase `.ts` for non-component modules (`heroFonts.ts`,
`styles.ts`, `bezier.ts`, `config.ts`) — these use **named exports**, not
default.

**`"use client"`:** present in every landing file that needs `useState`,
a `useEffect`/scroll listener, or an `IntersectionObserver` — i.e.
`LandingPage.tsx`, `Features.tsx`, `Pricing.tsx`, `HeroDiagram.tsx`,
`Reveal.tsx`, `CountUp.tsx`, `hero-canvas/HeroCanvasSection.tsx`,
`hero-canvas/useHeroApproachProgress.ts`,
`hero-canvas/useHeroScrollProgress.ts`. Purely-presentational,
no-local-state files (`Nav.tsx`, `TrustedBy.tsx`, `Footer.tsx`,
`ConnectorsOrbit.tsx`, `TypeChips.tsx`, `Stats.tsx`, `heroFonts.ts`,
`styles.ts`) have **no** `"use client"` — they render fine as Server
Components even though the tree above them (`LandingPage.tsx`) is a
client boundary; Next 15 still lets you mix, and this codebase does not
add the directive defensively.

**Shared UI primitives:** There is **no** `Button`/`Container`/`Section`
component library anywhere in `packages/ui/src` or `apps/web/src` for the
landing page. Every card/button/pill is either:
- an inline `style={{ ... }}` object written per-usage, or
- a colocated static style object imported from `landing/styles.ts`.

`apps/web/src/components/landing/styles.ts` (full) is the closest thing to
a shared primitive layer — static `CSSProperties` constants + two style
*functions*:

```ts
// Static style objects extracted verbatim from designs/Nia Core Landing.html
// (renderVals() in the __bundler/template's inline <script>). Values are
// copied character-for-character — do not adjust by eye.
import type { CSSProperties } from 'react';

export const ghostBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', height: 36, padding: '0 14px', borderRadius: 9, fontSize: 13.5, fontWeight: 600, color: 'var(--secondary)', background: 'var(--surface)', border: '1px solid var(--line)' };

export const ghostBtnLg: CSSProperties = { display: 'inline-flex', alignItems: 'center', height: 44, padding: '0 20px', borderRadius: 11, fontSize: 14.5, fontWeight: 600, color: 'var(--secondary)', background: 'var(--surface)', border: '1px solid var(--line)' };

export const gradientBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', height: 36, padding: '0 15px', borderRadius: 9, fontSize: 13.5, fontWeight: 600, color: '#FFFFFF', background: 'linear-gradient(120deg,#4F46E5,#7C3AED)', boxShadow: '0 10px 22px -12px rgba(79,70,229,.8)' };

export const darkBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', height: 44, padding: '0 20px', borderRadius: 11, fontSize: 14.5, fontWeight: 600, color: '#FFFFFF', background: 'var(--text)' };

export const whiteBtn: CSSProperties = { position: 'relative', display: 'inline-flex', alignItems: 'center', height: 48, padding: '0 24px', borderRadius: 12, fontSize: 15, fontWeight: 700, color: 'var(--primary)', background: '#FFFFFF', boxShadow: '0 14px 30px -16px rgba(2,6,23,.5)' };

export const kickerStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', padding: '6px 13px', borderRadius: 999, background: 'var(--primary-soft)', fontSize: 11, fontWeight: 700, letterSpacing: '.11em', color: 'var(--primary)' };

export const recPillStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderRadius: 999, background: 'linear-gradient(120deg,#4F46E5,#7C3AED)', fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', color: '#FFFFFF' };

export const statCardStyle: CSSProperties = { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 7, padding: 20, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: '0 1px 2px rgba(15,23,42,.04)' };

export const demoFrameStyle: CSSProperties = { marginTop: 26, overflow: 'hidden', borderRadius: 18, background: 'rgba(255,255,255,.8)', backdropFilter: 'blur(14px) saturate(1.4)', WebkitBackdropFilter: 'blur(14px) saturate(1.4)', border: '1px solid var(--line)', boxShadow: '0 30px 60px -40px rgba(15,23,42,.5)' };

export function rail(c: string): CSSProperties {
  return { position: 'absolute', left: 12, right: 12, top: 0, height: 2.5, borderRadius: '0 0 2px 2px', background: `linear-gradient(90deg,transparent,${c} 14% 86%,transparent)` };
}

export function tile(c: string, t: string): CSSProperties {
  return { width: 28, height: 28, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, background: t, color: c, fontSize: 11, fontWeight: 700 };
}
```

Also see `Reveal.tsx` in §7 — the one true shared *component* primitive
(scroll-reveal wrapper).

**Max-width / gutter:** No `Container` component. Every top-level
`<section>` repeats the same inline pattern:

```tsx
style={{ maxWidth: 1180, margin: '0 auto', boxSizing: 'border-box', padding: '74px 24px 0' }}
```

(`Nav`'s inner row uses `maxWidth: 1440`.) Horizontal gutter is usually
`clamp(20px, 4vw, 56px)` on wider full-bleed sections (Nav) or a flat
`24px` on `maxWidth: 1180` content sections (Features, Pricing).

---

## 6. Content

**Copy is hardcoded in JSX as typed const arrays inside each component
file** — there is no `content.ts`/CMS layer for the landing page.

Example (`Features.tsx`):

```ts
const FEATURES = [
  { num: '01', key: 'a', aura: '#A5F3FC', title: 'A canvas that runs', body: 'Drag sources, transforms and destinations onto a grid, connect them, and press run. No YAML, no cron files.' },
  { num: '02', key: 'b', aura: '#DDD6FE', title: 'Every source, one grid', body: 'Databases, warehouses, files and BI tools connect once and appear as reusable handles in every pipeline.' },
  { num: '03', key: 'c', aura: '#FBCFE8', title: 'AI on the canvas', body: 'Ask for a pipeline in words, or drop an AI step in to classify and extract fields mid-flow.' },
] as const;
```

Same pattern in `Pricing.tsx` (`PLANS` array), `ConnectorsOrbit.tsx`
(connector list), `TypeChips.tsx`. Always `as const`, always colocated
directly above the component that renders it, never imported from
elsewhere.

---

## 7. Interaction and motion

**No `framer-motion` / `motion` / `react-spring`** in `package.json`.
Motion is done with three techniques, layered:

1. **CSS transitions on hover-driven inline styles** — simplest case.
   `Features.tsx`/`Pricing.tsx` track `useState<string | null>` for
   `hovered`, then compute `transform`/`boxShadow` inline with a
   `transition: 'transform .22s cubic-bezier(.2,.7,.2,1), box-shadow .22s ease'`
   string, so React re-renders drive the animation via the browser's own
   CSS transition engine (no per-frame JS).

2. **`Reveal.tsx`** — the shared scroll-reveal primitive, wraps any
   element, adds `.reveal` on mount and `.in` once 15% visible via
   `IntersectionObserver`; the actual fade/slide is pure CSS
   (`.reveal`/`.reveal.in` in `theme.css`, gated by `body.armed` so it's a
   no-op until JS has confirmed `IntersectionObserver` exists and
   reduced-motion is off). Full source:

```tsx
'use client';

import { forwardRef, useEffect, useRef } from 'react';
import type { CSSProperties, ElementType, ForwardedRef, ReactNode } from 'react';

function RevealImpl(
  { as: Tag = 'div', className = '', style, children, ...rest }: {
    as?: ElementType; className?: string; style?: CSSProperties; children?: ReactNode;
    [key: string]: any;
  },
  forwardedRef: ForwardedRef<HTMLElement>,
) {
  const innerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = innerRef.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const setRefs = (node: HTMLElement | null) => {
    innerRef.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) (forwardedRef as { current: HTMLElement | null }).current = node;
  };

  return (
    <Tag ref={setRefs as never} className={`reveal ${className}`.trim()} style={style} {...rest}>
      {children}
    </Tag>
  );
}

const Reveal = forwardRef(RevealImpl);
export default Reveal;
```
   Used by wrapping any section heading or card: `<Reveal as="h2" style={...}>`.

3. **Imperative `requestAnimationFrame` scroll rigs** — for the two
   heaviest effects: `LandingPage.tsx`'s `onScroll` (Nav theme sweep + CTA
   band 3D perspective, see §4 full source) and the hero canvas's two
   hooks. These never use React state for the per-frame values — they
   write directly to `ref.current.style.*` and to CSS custom properties,
   to avoid re-render cost during scroll. This is the load-bearing
   "no React state for continuous scroll-driven values" convention in
   this codebase.

**Local interactive-state components:**
- `Features.tsx` / `Pricing.tsx`: hover-tracked card state (`useState<string | null>`).
- `Pricing.tsx` additionally does mouse-position 3D tilt: `handleTilt`
  computes `rx`/`ry`/`gx`/`gy` from cursor position relative to the card,
  gated by `matchMedia('(pointer: fine)')` and reduced-motion (see below).
- `HeroDiagram.tsx`: toggle-button state machine (`aria-pressed`) driving
  which SVG diagram panel is shown.
- `CountUp.tsx`: `IntersectionObserver`-triggered count-up number
  animation (`threshold: 0.6`, later than Reveal's 0.15, so viewers see
  the target value before it starts counting).

**Hero canvas trio (currently the modified files in git status)** — the
most advanced motion pattern in the codebase, worth understanding before
touching any hero-adjacent code:

`hero-canvas/HeroCanvasLayer.tsx` (full):

```tsx
import type { RefObject } from 'react';
import { CANVAS_BOUNDS, COLOR, CONNECTORS, NODES } from './config';
import NodeCard from './NodeCard';

export default function HeroCanvasLayer({ canvasRef }: { canvasRef: RefObject<HTMLDivElement> }) {
  const canvasW = CANVAS_BOUNDS.right - CANVAS_BOUNDS.left;
  const canvasH = CANVAS_BOUNDS.bottom - CANVAS_BOUNDS.top;

  return (
    <div ref={canvasRef} style={{ position: 'absolute', left: 0, top: 0, willChange: 'transform' }}>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute', left: CANVAS_BOUNDS.left, top: CANVAS_BOUNDS.top, width: canvasW, height: canvasH,
          backgroundImage: `radial-gradient(circle, ${COLOR.dotGrid} 1.2px, transparent 1.2px)`,
          backgroundSize: '28px 28px', pointerEvents: 'none',
        }}
      />
      <svg
        aria-hidden="true"
        style={{ position: 'absolute', left: CANVAS_BOUNDS.left, top: CANVAS_BOUNDS.top, width: canvasW, height: canvasH, overflow: 'visible', pointerEvents: 'none' }}
        viewBox={`${CANVAS_BOUNDS.left} ${CANVAS_BOUNDS.top} ${canvasW} ${canvasH}`}
      >
        {CONNECTORS.map((d, i) => {
          const { from, span } = CONNECTOR_REVEAL[i] ?? { from: 0, span: 1 };
          return (
            <path key={d} d={d} fill="none" stroke={COLOR.connector} strokeWidth={1.5} strokeLinecap="round"
              style={{ strokeDasharray: DRAW_LEN, strokeDashoffset: drawOffset(from, span) }} />
          );
        })}
      </svg>

      {NODES.map((node) => {
        const reveal = NODE_REVEAL[node.id];
        if (!reveal) return <NodeCard key={node.id} node={node} />;
        return (
          <div key={node.id} style={{ opacity: revealOpacity(reveal.from, reveal.span) }}>
            <NodeCard node={node} />
          </div>
        );
      })}
    </div>
  );
}

const NODE_REVEAL: Partial<Record<(typeof NODES)[number]['id'], { from: number; span: number }>> = {
  schedule: { from: 0.04, span: 0.22 },
  claude: { from: 0.04, span: 0.22 },
  route: { from: 0.24, span: 0.26 },
  powerbi: { from: 0.38, span: 0.26 },
  slack: { from: 0.52, span: 0.28 },
};

const CONNECTOR_REVEAL: { from: number; span: number }[] = [
  { from: 0.04, span: 0.22 }, { from: 0.04, span: 0.22 }, { from: 0.24, span: 0.26 },
  { from: 0.38, span: 0.26 }, { from: 0.52, span: 0.28 },
];

function revealOpacity(from: number, span: number): string {
  return `clamp(0, calc((var(--reveal, 1) - ${from}) * ${(1 / span).toFixed(3)}), 1)`;
}

const DRAW_LEN = 1200;

function drawOffset(from: number, span: number): string {
  return `clamp(0, calc(${DRAW_LEN} - (var(--reveal, 1) - ${from}) * ${(DRAW_LEN / span).toFixed(1)}), ${DRAW_LEN})`;
}
```

Key pattern: a `--reveal` CSS custom property (0→1) is written once per
`requestAnimationFrame` tick by the scroll hooks, and every node/connector
reads it back via `var(--reveal, 1)` inside `clamp(calc(...))` — **zero
React re-renders during scroll**, and a `, 1` fallback means everything
renders fully visible before JS runs a single frame (progressive
enhancement, not a hidden-by-default flash-of-unrevealed-content gate).

`hero-canvas/useHeroApproachProgress.ts` and
`hero-canvas/useHeroScrollProgress.ts` (both `"use client"` hooks) drive,
respectively, a small floating preview window growing toward viewport
center on normal scroll ("approach"), then a sticky/pinned fullscreen
takeover ("pin"). Both:
- bail out entirely under `prefers-reduced-motion: reduce` and (approach
  hook only) below a 768px mobile breakpoint,
- use a single `requestAnimationFrame`-debounced `scroll` listener
  (`passive: true`),
- write only to `ref.current.style.*` / `style.setProperty('--reveal', …)`,
  never `setState`,
- share an eased progress helper from `hero-canvas/bezier.ts`
  (`clamp01`, `heroEase`, `lerp`, `smoothstep`).

This scroll-jacking pattern is specific to the hero; ordinary new landing
sections should use `Reveal` (§7.2) or plain hover-transition CSS (§7.1),
**not** this rig, unless building something equally scroll-driven.

---

## 8. Icons and assets

- **No icon library / no `lucide-react`/`heroicons`.** Two ad hoc
  patterns instead:
  - `hero-canvas/icons.tsx` — hand-written inline SVG glyph components
    (`NodeGlyphIcon`) for workflow-node types (clock/branch = generic
    neutral strokes; supabase/claude/powerbi/slack = real brand marks).
  - `ConnectorsOrbit.tsx` — pulls real brand-mark path data from the
    **`simple-icons`** package (`^16.31.0`, a dependency), inlined per
    connector as `{ name, hex, path }` and rendered as
    `<svg viewBox="0 0 24 24"><path d={path} fill={hex} /></svg>`.
- **No `next/image` usage anywhere in landing** — everything visual is
  either an inline SVG or a CSS `background`/`radial-gradient` (see
  `Features.tsx`'s `ART` object for the fully CSS-generated "piece art").
  There are no landing-page `<img>` assets under `apps/web/public/`
  beyond the Satoshi font files.
- `Logo` (used in `Nav.tsx`, imported as `@/components/Logo`) is the one
  shared brand asset — a component, not an image file, taking
  `size`/`wordmarkColor` props so it re-skins with the Nav theme sweep.

---

## 9. Responsive

**No Tailwind breakpoint classes** (consistent with §2 — Tailwind is
configured but unused in markup). Responsive design uses three
CSS-avoiding-media-query techniques plus a handful of real breakpoints:

1. **Fluid `clamp()` everywhere for type scale, spacing, and one-off
   widths** — no discrete breakpoints needed for most sizing:
   ```ts
   fontSize: 'clamp(28px,4vw,38px)'   // Features/Pricing h2
   padding: '22px clamp(20px,4vw,56px)' // Nav gutter
   ```
2. **CSS Grid auto-fit** for card reflow instead of a breakpoint per grid
   arity: `gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))'`
   (Features, Pricing) — cards wrap on their own once they'd go under
   280px, no JS/media-query involved.
3. **Real `@media` rules**, only for: `prefers-reduced-motion: reduce`
   (kills all `animation`/`transition` globally, in `theme.css`), a small
   set of orbit-ring scale breakpoints (`1200px`/`960px`/`660px` in
   `theme.css`, scoped to `.orings`/`.floatcard`), and the hero canvas's
   single `768px` mobile breakpoint (in `HeroCanvasSection.tsx`'s scoped
   `<style>` block) which switches the scroll-jacked desktop layout to a
   static full-width band.
4. **`window.matchMedia()` in JS**, for behavior (not just style) gating:
   `(prefers-reduced-motion: reduce)` checked in `LandingPage.tsx`,
   `Pricing.tsx`, `HeroDiagram.tsx`, `CountUp.tsx`, and both hero-canvas
   hooks; `Pricing.tsx` also checks `(pointer: fine)` to disable the 3D
   tilt effect on touch devices.

Representative responsive block (`HeroCanvasSection.tsx`'s mobile
override, scoped `<style>` tag):

```css
@media (max-width: 768px) {
  .nia-hero-approach { height: auto; padding: 96px 20px 32px; }
  .nia-hero-approach-window { display: none; }
  .nia-hero-window {
    position: relative;
    width: 100%;
    height: min(38vw, 200px);
  }
}
```

---

## 10. Quality gates

- **No ESLint config** at root or in `apps/web` (`.eslintrc*` /
  `eslint.config.*` — none found outside `node_modules`). `lint` script
  falls through to Next.js's built-in `next lint` default config.
- **No Prettier config** anywhere in the repo (none found outside
  `node_modules`).
- **`apps/web/package.json` scripts:**
  ```
  dev:       next dev
  build:     next build
  start:     next start
  typecheck: tsc -p tsconfig.json --noEmit
  lint:      next lint
  test:      vitest run
  test:e2e:  playwright test
  ```
  (Per this repo's root `CLAUDE.md`, `next dev` should be run directly as
  `./node_modules/.bin/next dev -p 3100` from `apps/web/`, not via the
  `dev` script, to avoid `pnpm --filter ... dev -- -p 3100` arg-mangling —
  irrelevant to landing-page code itself, just a local dev-server note.)
- **Accessibility conventions actually followed:**
  - `aria-hidden="true"` on every purely-decorative element (dot grids,
    gradient auras, `ART` piece shapes, canvas SVG paths).
  - `aria-label` on custom interactive SVG controls (`HeroDiagram.tsx`).
  - `aria-pressed` on toggle-style buttons (`HeroDiagram.tsx`).
  - `aria-live="polite"` on dynamically-updating text regions
    (`HeroDiagram.tsx`'s info panel).
  - Global `:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }`
    in `theme.css` — applies everywhere, no per-component focus styling
    needed.
  - Semantic landmark elements (`<section>`, `<nav>`, `<h1>`/`<h2>`)
    throughout instead of generic `<div>` soup.

---

## 11. Anything surprising

- **Tailwind is fully configured but deliberately unused in markup.**
  `tailwind.config.ts`/`postcss.config.mjs` exist, `globals.css` still has
  `@tailwind base/components/utilities`, and the config even aliases
  Tailwind theme colors to the same CSS custom properties as `theme.css`
  — but zero landing components use a Tailwind class name. This matches
  the root `CLAUDE.md`'s explicit rule ("no Tailwind ... inline
  `CSSProperties` style objects") — don't add Tailwind classes to a new
  section even though the tooling would accept them.
- **`styles.ts` and `theme.css` are pixel-extraction artifacts**, not
  hand-designed: both carry header comments stating values were copied
  character-for-character from `designs/Nia Core Landing.html` /
  `designs/Nia Core App.html` (the Figma/bundler HTML exports checked into
  the repo) and must be **re-extracted from those source files**, never
  eyeballed/adjusted directly, if a value needs to change. A new section
  should follow the same discipline if it's meant to match a `designs/*`
  reference exactly.
- **Font stacking is per-subtree, not global.** Satoshi is the page-wide
  default (`html, body`), but Nav/Hero opt into IBM Plex Sans via a scoped
  `className={plexSans.variable}` + local `fontFamily: 'var(--font-plex-sans)'`
  — new sections should default to inheriting Satoshi and only introduce a
  new font variable if there's a specific design reason (as Nav/Hero did).
- **No React state for anything that changes every scroll frame.**
  `LandingPage.tsx` and both hero-canvas hooks write directly to
  `ref.current.style` / CSS custom properties inside a
  `requestAnimationFrame`-debounced scroll listener. This is intentional
  and load-bearing for perf — copying this pattern (not `useState` +
  re-render) is expected for any new scroll-driven section.
- **`prefers-reduced-motion` is checked in at least 6 separate places**
  (`theme.css` media query, `LandingPage.tsx`, `Pricing.tsx`,
  `HeroDiagram.tsx`, `CountUp.tsx`, both hero-canvas hooks) rather than
  centralized in one hook/util — a new interactive section should add its
  own `matchMedia('(prefers-reduced-motion: reduce)')` check rather than
  looking for (and not finding) a shared abstraction.
- **`Reveal`'s `<Tag>` prop plus `as never` ref cast** is a minor TS
  workaround (forwardRef + dynamic `as` tag typing) — copy it as-is if a
  new section needs `<Reveal as="h2">`-style API rather than re-deriving
  the generic typing.
- git status at time of writing shows exactly the three hero-canvas motion
  files (`HeroCanvasLayer.tsx`, `useHeroApproachProgress.ts`,
  `useHeroScrollProgress.ts`) as locally modified — these were read in
  full above as the current, in-progress state of that subsystem.

---

## How I would add a new section here

1. **New file:** `apps/web/src/components/landing/MySection.tsx` (PascalCase,
   default export, name matches file).
2. **Add `'use client'`** only if it needs local state, refs, or effects
   (hover state, `Reveal`-driven animation, etc.) — otherwise leave it a
   Server Component like `TrustedBy.tsx`/`Footer.tsx`.
3. **Structure:** a `const CONTENT = [...] as const` array above the
   component (§6) if it renders multiple repeated items; a `<section
   id="...">` root with `style={{ maxWidth: 1180, margin: '0 auto',
   boxSizing: 'border-box', padding: '74px 24px 0' }}` (§5) matching every
   other content section; wrap the heading and/or cards in `<Reveal
   as="h2">...</Reveal>` / `<Reveal>...</Reveal>` for the standard
   scroll-in treatment (§7.2), unless it needs the heavier scroll-jack
   rig, which it almost certainly doesn't.
4. **Styling:** inline `CSSProperties` only, referencing `var(--bg)`,
   `var(--text)`, `var(--primary)` etc. from `theme.css`'s bare `:root`
   tokens (§2) — no new hex values unless matching a specific
   `designs/*.html` reference, and no Tailwind classes.
5. **Wire it in:** edit
   `apps/web/src/components/landing/LandingPage.tsx` — add
   `import MySection from './MySection';` at the top, then place
   `<MySection />` in the JSX tree at the desired position among the
   existing ten sections (§4's render-order table).
