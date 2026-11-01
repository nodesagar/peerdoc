import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Page scale that fits PDF pages to the canvas width, times the user's zoom.
 * Applied as CSS `zoom` (not transform) so the page's layout size changes too:
 * the canvas can scroll to every edge and overlays scale with the page.
 */
export function usePageFit(containerRef: RefObject<HTMLElement | null>, zoomPercent: number) {
  const [available, setAvailable] = useState(0);
  const [natural, setNatural] = useState<Record<number, number>>({});
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef<HTMLElement | null>(null);
  // Reading position as a fraction of the scroll range, so a re-fit keeps the same spot in view
  const position = useRef({ x: 0, y: 0 });
  const onScroll = useRef(() => {
    const el = observed.current;
    if (!el) return;
    const frac = (pos: number, max: number) => (max > 0 ? pos / max : 0);
    position.current = {
      x: frac(el.scrollLeft, el.scrollWidth - el.clientWidth),
      y: frac(el.scrollTop, el.scrollHeight - el.clientHeight),
    };
  }).current;

  // The canvas element can mount later (e.g. once the file arrives); follow it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === observed.current) return;
    observer.current ??= new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    if (observed.current) {
      observer.current.unobserve(observed.current);
      observed.current.removeEventListener('scroll', onScroll);
    }
    observed.current = el;
    if (el) {
      // Fixed scrollbar space: otherwise the bar appearing shrinks the fit width, which can
      // shrink the pages enough to drop the bar again, and the canvas flickers between the two.
      el.style.scrollbarGutter = 'stable';
      el.addEventListener('scroll', onScroll, { passive: true });
      setAvailable(el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight));
      observer.current.observe(el);
    }
  });
  useEffect(() => () => observer.current?.disconnect(), []);

  // Pages were rescaled (side panel toggled, window resized, zoom): restore the reading
  // position before paint, instead of leaving the old pixel offset over a different page.
  useLayoutEffect(() => {
    const el = observed.current;
    if (!el) return;
    el.scrollLeft = position.current.x * (el.scrollWidth - el.clientWidth);
    el.scrollTop = position.current.y * (el.scrollHeight - el.clientHeight);
  }, [available, zoomPercent]);

  const onPageLoad = useCallback((pageIndex: number, page: { originalWidth: number }) => {
    setNatural((n) => (n[pageIndex] === page.originalWidth ? n : { ...n, [pageIndex]: page.originalWidth }));
  }, []);

  const pageZoom = (pageIndex: number) => {
    const width = natural[pageIndex];
    const fit = width && available > 0 ? Math.min(1, available / width) : 1;
    return (fit * zoomPercent) / 100;
  };

  return { pageZoom, onPageLoad };
}
