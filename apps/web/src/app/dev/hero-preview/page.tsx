'use client';

import { useRef } from 'react';
import HeroCanvasSection from '@/components/landing/hero-canvas/HeroCanvasSection';

// Temporary, isolated preview of the scroll-driven canvas-zoom hero — lets
// us screenshot/scroll-test the 4 checkpoints without touching the live
// LandingPage.tsx/Nav.tsx yet. Delete this route (and the "/dev" public
// middleware allowance) once HeroCanvasSection is wired into the real
// landing page.
export default function HeroPreviewPage() {
  const heroRef = useRef<HTMLElement>(null);
  return <HeroCanvasSection heroRef={heroRef} />;
}
