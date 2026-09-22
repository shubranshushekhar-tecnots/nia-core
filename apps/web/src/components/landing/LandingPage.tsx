'use client';

import { useEffect, useRef } from 'react';
import Nav, { NAV_HEIGHT } from './Nav';
import HeroCanvasSection from './hero-canvas/HeroCanvasSection';
import WhatNiaDoes from './WhatNiaDoes';
import ConnectorsOrbit from './ConnectorsOrbit';
import TypeChips from './TypeChips';
import ConnectorDirectory from './ConnectorDirectory';
import Stats from './Stats';
import Pricing from './Pricing';
import CtaBand from './CtaBand';
import Footer from './Footer';

export default function LandingPage() {
  const navRef = useRef<HTMLElement>(null);
  const heroRef = useRef<HTMLElement>(null);

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
      const pastHero = (heroRect?.bottom ?? -Infinity) <= NAV_HEIGHT;
      const pinned = !pastHero && heroEl?.dataset.heroPinned === 'true';
      const darkIsland = !pastHero;

      // html/body still carry the site-wide light theme background
      // (theme.css `html, body { background: var(--bg) }`) from before this
      // hero existed. That's correct for every other page, but it means the
      // native overscroll/rubber-band bounce at the top of THIS page reveals
      // that light canvas through the black hero. Track the canvas color to
      // whichever section is actually on screen (mirrors the Nav theme sweep
      // below) so a bounce always reveals the right color; reset on unmount.
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
      <WhatNiaDoes />
      <ConnectorsOrbit />
      <TypeChips />
      <ConnectorDirectory />
      <Stats />
      <Pricing />
      <CtaBand />
      <Footer />
    </div>
  );
}
