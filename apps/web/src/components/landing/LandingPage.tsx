'use client';

import { useRef } from 'react';
import { useNiaHeroEngine } from './hero-story/useNiaHeroEngine';
import NiaHeroNav from './hero-story/NiaHeroNav';
import NiaHeroStage from './hero-story/NiaHeroStage';
import Pricing from './Pricing';
import Footer from './Footer';
import ContactTab from './ContactTab';
import './hero-story/niaHero.css';

const ROOT_FONT = "'Suisse Intl', 'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif";

// Thin composition: nav + scroll-jacked 4-chapter story stage + pricing +
// footer, all sharing one useNiaHeroEngine() call (hook is lifted once here
// and passed down via props so the scroll engine only runs once). Port of
// designs/nia-hero/index.html's #nx-root (lines 103-544), which wraps the
// whole page in this shared background/color/font-family.
export default function LandingPage() {
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLSpanElement>(null);
  const { chapter, status, billing, setBilling, tab, setTab } = useNiaHeroEngine({ trackRef, stageRef, windowRef });

  return (
    <div id="nx-root" style={{ background: '#000000', color: '#0F172A', fontFamily: ROOT_FONT }}>
      <NiaHeroNav />
      <ContactTab />
      <NiaHeroStage trackRef={trackRef} stageRef={stageRef} windowRef={windowRef} chapter={chapter} status={status} />
      <Pricing billing={billing} setBilling={setBilling} />
      <Footer tab={tab} setTab={setTab} />
    </div>
  );
}
