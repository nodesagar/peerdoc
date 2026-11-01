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
    title: 'Zero Central Servers: Pure Peer-to-Peer',
    text: "There is no EditorDoc server. Collaboration happens directly between peer browsers via WebRTC DataChannels (Trystero) and local BroadcastChannels. So that peers can still connect when a network blocks WebRTC, edits are also relayed through public MQTT brokers (the PDF itself only when no direct connection is available); everything sent that way is end-to-end encrypted (AES-256-GCM) with a key derived from the room's secret key, which the brokers never see. Each room has a random key that lives only in the share link (after the #) and on your device, so having the same PDF is not enough to join. Anyone with the full share link can view and edit.",
  },
  {
    Icon: WifiOff,
    paper: 'bg-marigold',
    title: 'Offline-First Persistence (Y-IndexedDB)',
    text: "You can work offline for weeks without an active internet connection. All edits, annotations, page rotations, and redactions are stored locally in your browser's IndexedDB using Conflict-Free Replicated Data Types (CRDTs). When you reconnect, updates converge seamlessly in any order.",
  },
  {
    Icon: Cpu,
    paper: 'bg-mint',
    title: 'Permanent True Redactions',
    text: 'Unlike basic tools that merely draw black boxes over text, EditorDoc P2P rasterizes redacted regions directly into pixel bitmaps, permanently destroying the underlying text streams and font glyphs to ensure absolute security.',
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
              P2P Privacy Guarantee & Terms
            </h2>
            <p className="eyebrow">EditorDoc P2P Decentralized Collaboration Guarantee</p>
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
            I Understand & Accept
          </button>
        </div>
      </div>
    </div>
  );
};
