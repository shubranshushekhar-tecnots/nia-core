'use client';

import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';

// Re-implements the original data-count/data-suffix IntersectionObserver
// count-up (threshold .6, 1100ms cubic ease-out, thousands separators),
// respecting prefers-reduced-motion exactly as the source did.
export default function CountUp({ target, suffix, value, style }: { target: number; suffix: string; value: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          io.unobserve(entry.target);
          if (reduce || !target) return;
          const dur = 1100;
          const t0 = performance.now();
          const dec = target % 1 !== 0 ? 1 : 0;
          const tick = (now: number) => {
            const p = Math.min(1, (now - t0) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            el.textContent = (target * eased).toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + suffix;
            if (p < 1) requestAnimationFrame(tick);
          };
          el.textContent = '0' + suffix;
          requestAnimationFrame(tick);
        });
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [target, suffix]);

  return <span ref={ref} style={style}>{value}</span>;
}
