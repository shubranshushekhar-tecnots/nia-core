'use client';

import { forwardRef, useEffect, useRef } from 'react';
import type { CSSProperties, ElementType, ForwardedRef, ReactNode } from 'react';

// Re-implements the original scroll-reveal behavior: elements marked
// class="reveal" fade/slide in once they cross 15% into the viewport,
// matching the IntersectionObserver + .reveal/.reveal.in CSS in
// packages/ui/src/theme.css (from designs/Nia Core Landing.html).
function RevealImpl(
  {
    as: Tag = 'div',
    className = '',
    style,
    children,
    ...rest
  }: {
    as?: ElementType;
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
