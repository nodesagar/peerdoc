import React from 'react';
import { ShieldCheck, Lock, Cpu, Trash2, X, WifiOff } from 'lucide-react';

interface PrivacyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PrivacyModal: React.FC<PrivacyModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="bg-[#faf9f8] rounded-2xl max-w-xl w-full border border-black/10 shadow-2xl p-6 md:p-8 space-y-6 relative animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-1.5 rounded-full hover:bg-black/5 text-[#625e5a] transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-[#005db2] text-white flex items-center justify-center shadow-xs">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-2xl font-serif-heading font-bold text-[#1a1c1c]">
              P2P Privacy Guarantee & Terms
            </h2>
            <p className="text-xs text-[#625e5a]">EditorDoc P2P Decentralized Collaboration Guarantee</p>
          </div>
        </div>

        <div className="space-y-4 text-xs md:text-sm text-[#414753] leading-relaxed max-h-[50vh] overflow-y-auto pr-2">
          <div className="bg-white p-4 rounded-xl border border-black/[0.08] space-y-2">
            <div className="flex items-center space-x-2 font-semibold text-[#1a1c1c]">
              <Lock className="w-4 h-4 text-[#005db2]" />
              <span>Zero Central Servers: Pure Peer-to-Peer</span>
            </div>
            <p className="text-xs text-[#5f6368]">
              There is no EditorDoc server. Collaboration happens directly between peer browsers via WebRTC DataChannels (Trystero) and local BroadcastChannels. So that peers can still connect when a network blocks WebRTC, edits are also relayed through public MQTT brokers (the PDF itself only when no direct connection is available); everything sent that way is end-to-end encrypted (AES-256-GCM) with a key derived from the room's secret key, which the brokers never see. Each room has a random key that lives only in the share link (after the #) and on your device, so having the same PDF is not enough to join. Anyone with the full share link can view and edit.
            </p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-black/[0.08] space-y-2">
            <div className="flex items-center space-x-2 font-semibold text-[#1a1c1c]">
              <WifiOff className="w-4 h-4 text-[#005db2]" />
              <span>Offline-First Persistence (Y-IndexedDB)</span>
            </div>
            <p className="text-xs text-[#5f6368]">
              You can work offline for weeks without an active internet connection. All edits, annotations, page rotations, and redactions are stored locally in your browser's IndexedDB using Conflict-Free Replicated Data Types (CRDTs). When you reconnect, updates converge seamlessly in any order.
            </p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-black/[0.08] space-y-2">
            <div className="flex items-center space-x-2 font-semibold text-[#1a1c1c]">
              <Cpu className="w-4 h-4 text-[#005db2]" />
              <span>Permanent True Redactions</span>
            </div>
            <p className="text-xs text-[#5f6368]">
              Unlike basic tools that merely draw black boxes over text, EditorDoc P2P rasterizes redacted regions directly into pixel bitmaps, permanently destroying the underlying text streams and font glyphs to ensure absolute security.
            </p>
          </div>
        </div>

        <div className="pt-2 flex justify-end">
          <button
            onClick={onClose}
            className="bg-[#0075de] hover:bg-[#005db2] text-white px-6 py-2.5 rounded-xl text-xs font-semibold shadow-xs cursor-pointer"
          >
            I Understand & Accept
          </button>
        </div>
      </div>
    </div>
  );
};
