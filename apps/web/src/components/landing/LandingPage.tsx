'use client';

import { useEffect, useRef } from 'react';
import Nav from './Nav';
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

      // Hero is a self-contained dark island (see hero-canvas/HeroCanvasSection):
      // Nav starts transparent-on-black, goes solid black once the hero pins
      // (its own scroll rig sets `wrapper.dataset.heroPinned`), then resumes
      // the normal frosted-light treatment once the 420vh hero section has
      // fully scrolled past. HeroCanvasSection owns all of the hero's own
      // scroll-driven visuals via useHeroScrollProgress — this handler only
      // drives Nav's theme sweep now, it no longer touches hero styles.
      const heroEl = heroRef.current;
      const heroRect = heroEl?.getBoundingClientRect();
      const pastHero = (heroRect?.bottom ?? -Infinity) <= 74;
      const pinned = !pastHero && heroEl?.dataset.heroPinned === 'true';
      const darkIsland = !pastHero;

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
    return () => window.removeEventListener('scroll', onScroll);
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
