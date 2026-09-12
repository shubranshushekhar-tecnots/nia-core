'use client';

import { useEffect, useRef } from 'react';
import Nav from './Nav';
import Hero from './Hero';
import DemoSection from './DemoSection';
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
  const stageRef = useRef<HTMLElement>(null);
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
      const on = window.scrollY > 8;
      nav.style.borderBottomColor = on ? 'var(--line)' : 'transparent';
      nav.style.boxShadow = on ? '0 10px 30px -24px rgba(15,23,42,.5)' : 'none';
      if (reduce) return;

      const hero = heroRef.current;
      const stage = stageRef.current;
      if (hero && stage) {
        const h = hero.getBoundingClientRect().height || 1;
        const p = Math.max(0, Math.min(1, window.scrollY / (h * 0.8)));
        const e = p * p * (3 - 2 * p);
        hero.style.transform = `perspective(1200px) scale(${1 - e * 0.14}) translateY(${-e * 70}px) rotateX(${e * 7}deg)`;
        hero.style.opacity = String(1 - e * 0.85);
        hero.style.filter = `blur(${(e * 5).toFixed(2)}px)`;
        stage.style.transform = `translateY(${-e * 44}px)`;
        stage.style.borderTopLeftRadius = stage.style.borderTopRightRadius = `${36 - e * 22}px`;
      }

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
      <Hero heroRef={heroRef} />
      <DemoSection stageRef={stageRef} />
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
