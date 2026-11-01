import React from 'react';

interface HighlighterProps {
  children: React.ReactNode;
  action?: 'highlight' | 'underline' | 'box' | 'circle';
  color?: string;
}

export const Highlighter: React.FC<HighlighterProps> = ({
  children,
  action = 'highlight',
  color = '#87CEFA',
}) => {
  if (action === 'underline') {
    // A marker swipe under the lower half of the line, like a pen on paper
    return (
      <span
        className="relative inline font-medium text-ink"
        style={{
          backgroundImage: `linear-gradient(transparent 48%, ${color} 48%, ${color} 94%, transparent 94%)`,
          boxDecorationBreak: 'clone',
          WebkitBoxDecorationBreak: 'clone',
          padding: '0 2px',
        }}
      >
        {children}
      </span>
    );
  }

  return (
    <span
      className="relative inline-block px-1.5 py-0.5 rounded-sm font-medium"
      style={{
        backgroundColor: color ? `${color}33` : 'rgba(135, 206, 250, 0.25)',
        color: 'inherit',
      }}
    >
      {children}
    </span>
  );
};
