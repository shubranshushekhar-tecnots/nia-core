'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { LOOP_DURATION } from './config';

export type RunClock = {
  playing: boolean;
  reducedMotion: boolean;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  replay: () => void;
  runNow: (fromT: number) => void;
};

// Single rAF-driven clock (0 -> LOOP_DURATION, looping). Pauses itself when
// the section scrolls off-screen or the tab is hidden. Consumers pass an
// onTick callback (usually a setState) rather than reading a ref, so every
// piece of derived UI re-renders from one source of truth: `t`.
export function useRunClock(containerRef: RefObject<HTMLElement>, onTick: (t: number) => void): RunClock {
  const [playing, setPlaying] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  const tRef = useRef(0);
  const lastRef = useRef<number | null>(null);
  const visibleRef = useRef(true);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setReducedMotion(reduce);
    if (reduce) {
      tRef.current = LOOP_DURATION - 0.01;
      onTickRef.current(tRef.current);
      return;
    }

    let rafId = 0;
    const el = containerRef.current;
    let io: IntersectionObserver | null = null;
    if (el && 'IntersectionObserver' in window) {
      io = new IntersectionObserver(
        (entries) => entries.forEach((entry) => { visibleRef.current = entry.isIntersecting; }),
        { threshold: 0.2 },
      );
      io.observe(el);
    }

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      const active = playingRef.current && visibleRef.current && !document.hidden;
      if (!active) {
        lastRef.current = null;
        return;
      }
      if (lastRef.current == null) lastRef.current = now;
      const dt = (now - lastRef.current) / 1000;
      lastRef.current = now;
      tRef.current = (tRef.current + dt) % LOOP_DURATION;
      onTickRef.current(tRef.current);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      io?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);
  const togglePlay = useCallback(() => setPlaying((p) => !p), []);
  const replay = useCallback(() => {
    tRef.current = 0;
    lastRef.current = null;
    onTickRef.current(0);
    setPlaying(true);
  }, []);
  const runNow = useCallback((fromT: number) => {
    tRef.current = fromT;
    lastRef.current = null;
    onTickRef.current(fromT);
    setPlaying(true);
  }, []);

  return { playing, reducedMotion, play, pause, togglePlay, replay, runNow };
}
