import { ReactLenis } from 'lenis/react';
import 'lenis/dist/lenis.css';
import LandingPage from '@/components/landing/LandingPage';

// Premium smooth scroll (Lenis) for the landing route only — `root` makes
// window the scroll container (no transform wrapper, position: sticky in
// NiaHeroStage keeps working) and exposes the instance via useLenis() to
// any descendant, which useNiaHeroEngine hooks into for its scroll engine.
// App routes outside this page keep native scroll (no Lenis instance there).
export default function Page() {
  return (
    <ReactLenis
      root
      options={{
        autoRaf: true,
        lerp: 0.09,
        smoothWheel: true,
        anchors: { offset: -56 },
        wheelMultiplier: 1,
        touchMultiplier: 1,
        respectReducedMotion: true,
      }}
    >
      <LandingPage />
    </ReactLenis>
  );
}
