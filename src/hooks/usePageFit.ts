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

  // The canvas element can mount later (e.g. once the file arrives); follow it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === observed.current) return;
    observer.current ??= new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    if (observed.current) observer.current.unobserve(observed.current);
    observed.current = el;
    if (el) {
      setAvailable(el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight));
      observer.current.observe(el);
    }
  });
  useEffect(() => () => observer.current?.disconnect(), []);

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
