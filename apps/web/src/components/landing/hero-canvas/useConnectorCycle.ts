'use client';

import { useEffect, useRef, useState } from 'react';
import { CONNECTOR_CYCLE, type ConnectorFrame } from './config';

const PERIOD_MS = 1200; // time each tool is fully visible before swapping
const FADE_MS = 300; // dip-to-transparent duration, matches the CSS transition in HeroCanvasLayer
const POLL_MS = 250;

// Drives the hero canvas's anchor node ('supabase' in NODES) through
// CONNECTOR_CYCLE over time, with a brief dip-to-transparent between tools.
// Called independently by each HeroCanvasLayer instance (approach block +
// pin block are two separate React trees) — they stay in sync because the
// active index is derived from performance.now() (a clock shared by every
// mounted instance), not "time since this hook mounted".
export function useConnectorCycle(): { frame: ConnectorFrame; fading: boolean } {
  const [index, setIndex] = useState(0); // deterministic first paint: Supabase, matches NODES' static fallback
  const [fading, setFading] = useState(false);
  const indexRef = useRef(0);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return undefined; // stays on Supabase, matches this component's other reduced-motion handling

    let pending = false;
    let fadeTimeout: ReturnType<typeof setTimeout> | undefined;

    const poll = setInterval(() => {
      if (pending) return;
      const nextIndex = Math.floor(performance.now() / PERIOD_MS) % CONNECTOR_CYCLE.length;
      if (nextIndex === indexRef.current) return;
      pending = true;
      setFading(true); // opacity -> 0 (CSS transition on the NodeCard wrapper)
      fadeTimeout = setTimeout(() => {
        indexRef.current = nextIndex;
        setIndex(nextIndex); // swap content while invisible
        setFading(false); // opacity -> 1
        pending = false;
      }, FADE_MS);
    }, POLL_MS);

    return () => {
      clearInterval(poll);
      if (fadeTimeout) clearTimeout(fadeTimeout);
    };
  }, []);

  return { frame: CONNECTOR_CYCLE[index] ?? CONNECTOR_CYCLE[0]!, fading };
}
