import React, { useId } from 'react';

interface PaperScrapProps {
  /** Any CSS colour, e.g. 'var(--color-mint)' */
  color: string;
  /** Aspect of the scrap in px; the rendered width comes from className */
  w?: number;
  h?: number;
  pattern?: 'lines' | 'grid';
  seed?: number;
  className?: string;
}

/**
 * Decorative torn-paper scrap for the scrapbook collage. The torn edge is an SVG
 * displacement of a rectangle; a white rim (the paper's core) peeks out under it.
 */
export const PaperScrap: React.FC<PaperScrapProps> = ({ color, w = 400, h = 160, pattern, seed = 3, className }) => {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const pad = 16;
  const tear = (s: number) => (
    <filter id={`${id}t${s}`} x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="4" seed={s} />
      <feDisplacementMap in="SourceGraphic" scale="20" xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );

  return (
    <svg aria-hidden focusable="false" viewBox={`0 0 ${w} ${h}`} className={className}>
      <defs>
        {tear(seed)}
        {tear(seed + 7)}
        <mask id={`${id}m`}>
          <rect x={pad} y={pad} width={w - 2 * pad} height={h - 2 * pad} fill="#fff" filter={`url(#${id}t${seed + 7})`} />
        </mask>
        {pattern === 'lines' && (
          <pattern id={`${id}p`} width={w} height="18" patternUnits="userSpaceOnUse">
            <path d={`M0 17.5H${w}`} stroke="rgb(3 3 2 / 0.16)" />
          </pattern>
        )}
        {pattern === 'grid' && (
          <pattern id={`${id}p`} width="14" height="14" patternUnits="userSpaceOnUse">
            <path d="M14 0V14H0" fill="none" stroke="rgb(3 3 2 / 0.14)" />
          </pattern>
        )}
      </defs>
      <rect x={pad - 4} y={pad - 4} width={w - 2 * pad + 8} height={h - 2 * pad + 8} fill="#fff" filter={`url(#${id}t${seed})`} />
      <g mask={`url(#${id}m)`}>
        <rect width={w} height={h} style={{ fill: color }} />
        {pattern && <rect width={w} height={h} fill={`url(#${id}p)`} />}
      </g>
    </svg>
  );
};
