import React from 'react';
import { ShieldCheck, Lock, Cpu, X, WifiOff } from 'lucide-react';

interface PrivacyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const sections = [
  {
    Icon: Lock,
    paper: 'bg-periwinkle',
    title: 'No Peer Docs server, invite-only rooms',
    text: "Your documents never pass through a server we run. Collaborators connect browser to browser over WebRTC; public WebTorrent trackers only help them find each other. When a network blocks direct connections, changes (and the file itself, if no direct connection is available) travel through public MQTT relays instead, end-to-end encrypted with AES-256-GCM, so the relays see only ciphertext. Rooms are invite-only: the owner creates a single-use invite link for each person and can remove anyone at any time. Having the same file is not enough to join.",
  },
  {
    Icon: WifiOff,
    paper: 'bg-marigold',
    title: 'Works offline',
    text: "Everything you do (text edits, markup, comments, page changes, redactions and signatures) is saved in this browser's storage (IndexedDB) as you work, so you can keep editing without a connection. When you reconnect, everyone's changes merge automatically, in whatever order they arrive, thanks to CRDTs.",
  },
  {
    Icon: Cpu,
    paper: 'bg-mint',
    title: 'Redactions remove the content',
    text: "When you download a redacted PDF, every page with a redaction is rebuilt as an image with the black boxes burned in, so the text, fonts and graphics underneath are gone, not just covered. Text elsewhere on those pages stops being selectable too. Every downloaded PDF also leaves out the original title, author and other document properties.",
  },
];

export const PrivacyModal: React.FC<PrivacyModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/30 backdrop-blur-sm">
      <div
        className="bg-white rounded-3xl max-w-xl w-full shadow-xl p-6 md:p-8 space-y-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-5 right-5 btn btn-ghost h-9 w-9 px-0"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="space-y-4 pr-10">
          <div className="w-12 h-12 rounded-2xl bg-mint text-ink flex items-center justify-center">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h2 className="font-serif text-subheading md:text-heading-sm text-ink text-balance">
              Privacy & security
            </h2>
            <p className="eyebrow">How Peer Docs handles your documents</p>
          </div>
        </div>

        <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
          {sections.map(({ Icon, paper, title, text }) => (
            <div key={title} className="bg-linen p-4 rounded-2xl space-y-2">
              <div className="flex items-center gap-2.5 text-body-sm font-semibold text-ink">
                <span className={`w-7 h-7 rounded-lg ${paper} flex items-center justify-center shrink-0`}>
                  <Icon className="w-4 h-4" />
                </span>
                <span>{title}</span>
              </div>
              <p className="text-body-sm text-graphite">{text}</p>
            </div>
          ))}
        </div>

        <div className="flex justify-end">
          <button onClick={onClose} className="btn btn-primary">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
