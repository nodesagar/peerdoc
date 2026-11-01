import React from 'react';

interface FooterProps {
  onOpenPrivacyModal: () => void;
}

export const Footer: React.FC<FooterProps> = ({ onOpenPrivacyModal }) => {
  return (
    <footer className="border-t border-ink/10 py-10 px-4 md:px-6 mt-auto">
      <div className="max-w-[1440px] mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-body-sm text-graphite">
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <div className="w-6 h-6 rounded-[7px] bg-ink text-white flex items-center justify-center font-semibold text-[10px]">
            PD
          </div>
          <span className="font-semibold text-ink">Peer Docs</span>
          <span aria-hidden>&bull;</span>
          <span>Offline-first, peer-to-peer document editing</span>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={onOpenPrivacyModal}
            className="hover:text-ink underline-offset-4 hover:underline transition-colors"
          >
            Privacy & security
          </button>
          <span aria-hidden>&bull;</span>
          <span>Supports UN SDG 9.c: universal access to ICT</span>
        </div>
      </div>
    </footer>
  );
};
